// Deterministic test for the delivery surface (gaps 8.2–8.6): execute_sql, request_secret/check_secret,
// create_pr, pr_checks, expose_port. No network, no `gh`, no tunnel client — the SQLite + secret paths run
// for real (temp DB, injected masked prompt); the git/PR/tunnel paths run against a scripted fake CmdRunner
// so the full orchestration + parsing is exercised hermetically. Also asserts tool registration + the
// approval flags (mutating / [destructive]) the loop relies on.
// Usage: bun run scripts/delivery-smoke.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { buildTools, isDestructiveCall, toolCallMutates } from "../src/agent/tools.ts";
import { classifySql, runSqlite, formatSqlResult } from "../src/agent/sql.ts";
import { SecretStore } from "../src/agent/secrets.ts";
import { slugifyBranch, buildGhCreateArgs, parsePrChecks, createPr, prChecks } from "../src/agent/pr.ts";
import { tunnelCommand, extractTunnelUrl, pickProvider } from "../src/agent/expose.ts";
import type { CmdRunner, CmdResult } from "../src/agent/exec.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const ok = (code = 0, stdout = "", stderr = ""): CmdResult => ({ code, stdout, stderr });
const dir = mkdtempSync(join(tmpdir(), "ob1-delivery-"));

// ───────────────────────── execute_sql (real SQLite) ─────────────────────────
console.log("\n── execute_sql ──");
check("classify SELECT → read", classifySql("SELECT * FROM t") === "read");
check("classify PRAGMA → read", classifySql("PRAGMA table_info(t)") === "read");
check("classify INSERT → write", classifySql("INSERT INTO t VALUES (1)") === "write");
check("classify UPDATE…WHERE → write", classifySql("UPDATE t SET x=1 WHERE id=2") === "write");
check("classify CREATE → ddl", classifySql("CREATE TABLE t(id int)") === "ddl");
check("classify DROP → destructive", classifySql("DROP TABLE t") === "destructive");
check("classify TRUNCATE → destructive", classifySql("TRUNCATE TABLE t") === "destructive");
check("classify unscoped DELETE → destructive", classifySql("DELETE FROM t") === "destructive");
check("classify unscoped UPDATE → destructive", classifySql("UPDATE t SET x=1") === "destructive");
check("classify -- comment then SELECT → read", classifySql("-- note\nSELECT 1") === "read");
check("classify empty → empty", classifySql("   ") === "empty");
// multi-statement scripts are classified by their MOST DANGEROUS statement — a destructive statement
// anywhere in the script must trip the gate (db.exec runs the WHOLE script).
check("classify scoped write + trailing DROP → destructive", classifySql("UPDATE t SET x=1 WHERE id=2; DROP TABLE t") === "destructive");
check("classify two writes → write", classifySql("INSERT INTO t VALUES (1); UPDATE t SET x=1 WHERE id=1") === "write");
check("classify ; inside a string literal is not a split", classifySql("INSERT INTO t VALUES ('a;b')") === "write");
check("classify DROP hidden after a comment line → destructive", classifySql("SELECT 1; -- harmless\nDROP TABLE t") === "destructive");

// real round-trip against a temp db file
runSqlite(dir, "app.db", "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)");
const ins = runSqlite(dir, "app.db", "INSERT INTO users(name) VALUES ('ada'),('grace')");
check("INSERT reports 2 rows affected", ins.changes === 2, `changes=${ins.changes}`);
const sel = runSqlite(dir, "app.db", "SELECT id,name FROM users ORDER BY id");
check("SELECT returns 2 rows + columns", sel.rows.length === 2 && sel.columns.join(",") === "id,name");
check("SELECT row values correct", sel.rows[0][1] === "ada" && sel.rows[1][1] === "grace");
check("formatSqlResult renders a table", /name/.test(formatSqlResult(sel)) && /ada/.test(formatSqlResult(sel)));
const upd = runSqlite(dir, "app.db", "UPDATE users SET name='Ada' WHERE id=1");
check("scoped UPDATE writes 1 row", upd.changes === 1);
{
  let threw = false;
  try { runSqlite(dir, "missing-read.db", "SELECT 1 AS n"); } catch { threw = true; }
  check("read-only SELECT does not create a missing db file", threw && !existsSync(join(dir, "missing-read.db")));
}

// the tool: registration, flags, destructive guard
const sqlTools = buildTools({ cwd: dir } as any, {} as any);
const sqlTool = sqlTools.get("execute_sql");
check("execute_sql registered + statically mutating", !!sqlTool && sqlTool.mutating === true);
check("execute_sql SELECT is effectively read-only", !!sqlTool && toolCallMutates(sqlTool, "execute_sql", { sql: "SELECT 1" }) === false);
check("execute_sql INSERT is effectively mutating", !!sqlTool && toolCallMutates(sqlTool, "execute_sql", { sql: "INSERT INTO users(name) VALUES ('x')", db: "app.db" }) === true);
check("isDestructiveCall tags DROP", isDestructiveCall("execute_sql", { sql: "DROP TABLE users" }) === true);
check("isDestructiveCall does NOT tag SELECT", isDestructiveCall("execute_sql", { sql: "SELECT 1" }) === false);
{
  // these target the SAME db file written by the round-trip above (the tool's default is .ob1/app.db).
  let threw = false;
  try { await sqlTool!.run({ sql: "DROP TABLE users", db: "app.db" }); } catch { threw = true; }
  check("execute_sql refuses DROP without allow_destructive", threw);
  let threw2 = false;
  try { await sqlTool!.run({ sql: "DELETE FROM users", db: "app.db" }); } catch { threw2 = true; }
  check("execute_sql refuses unscoped DELETE", threw2);
  // P0 regression: a destructive statement smuggled after a benign one must still be refused, and the
  // table must survive (the gate blocks BEFORE db.exec runs the script).
  let threw3 = false;
  try { await sqlTool!.run({ sql: "UPDATE users SET name='x' WHERE id=1; DROP TABLE users", db: "app.db" }); } catch { threw3 = true; }
  const tableSurvived = runSqlite(dir, "app.db", "SELECT name FROM sqlite_master WHERE type='table' AND name='users'").rows.length === 1;
  check("execute_sql refuses multi-statement DROP bypass (table survives)", threw3 && tableSurvived);
  const wiped = await sqlTool!.run({ sql: "DELETE FROM users", db: "app.db", allow_destructive: true });
  check("execute_sql allows DELETE with allow_destructive", /affected/.test(String((wiped as any).text ?? wiped)));
  const read = await sqlTool!.run({ sql: "SELECT count(*) c FROM users", db: "app.db" });
  check("execute_sql read after wipe → 0", /\b0\b/.test(String((read as any).text ?? read)));
}

// ───────────────────────── secrets ─────────────────────────
console.log("\n── secrets ──");
check("validName accepts UPPER_SNAKE", SecretStore.validName("OPENAI_API_KEY"));
check("validName rejects lower/space", !SecretStore.validName("api key") && !SecretStore.validName("lower"));
{
  const TESTNAME = "OB1_DELIVERY_TEST_SECRET";
  delete process.env[TESTNAME];
  let promptedFor = "";
  const store = new SecretStore({ prompt: async (name) => { promptedFor = name; return "s3cr3t-value-123"; } });
  check("has() false before request", store.has(TESTNAME) === false);
  check("source() missing before request", store.source(TESTNAME) === "missing");
  const captured = await store.request(TESTNAME, "for the test");
  check("request() captured", captured === true && promptedFor === TESTNAME);
  check("has() true after request", store.has(TESTNAME) === true);
  check("source() session after request", store.source(TESTNAME) === "session");
  check("value exposed to process.env for run_bash", process.env[TESTNAME] === "s3cr3t-value-123");
  check("redact() masks the value", store.redact("token is s3cr3t-value-123 ok") === "token is ‹redacted› ok");
  const again = await store.request(TESTNAME);
  check("request() idempotent (no re-prompt when set)", again === false);
  // env-sourced secret
  process.env.OB1_ENV_ONLY_SECRET = "from-env";
  check("source() env for a pre-set env var", store.source("OB1_ENV_ONLY_SECRET") === "env");
  delete process.env[TESTNAME]; delete process.env.OB1_ENV_ONLY_SECRET;

  // tools: only present when a secret store is wired
  check("request_secret absent without extras", !buildTools({ cwd: dir } as any, {} as any).has("request_secret"));
  const secretStore = new SecretStore({ prompt: async () => "injected-key" });
  const st = buildTools({ cwd: dir } as any, {} as any, undefined, undefined, undefined, undefined, { secrets: secretStore });
  check("request_secret + check_secret registered with extras", st.has("request_secret") && st.has("check_secret"));
  check("request_secret is non-mutating", st.get("request_secret")!.mutating === false);
  const r1 = String(await st.get("request_secret")!.run({ name: "MY_TOKEN", reason: "demo" }));
  check("request_secret captures + confirms without value", /MY_TOKEN/.test(r1) && !/injected-key/.test(r1));
  const chk = String(st.get("check_secret")!.run({ name: "MY_TOKEN" }));
  check("check_secret reports set, hides value", /available/.test(chk) && !/injected-key/.test(chk));
  let badName = false;
  try { await st.get("request_secret")!.run({ name: "bad name" }); } catch { badName = true; }
  check("request_secret rejects invalid name", badName);
  delete process.env.MY_TOKEN;
}

// ───────────────────────── create_pr / pr_checks ─────────────────────────
console.log("\n── create_pr / pr_checks ──");
check("slugifyBranch kebabs + prefixes", slugifyBranch("Add OAuth login!") === "ob1/add-oauth-login");
check("slugifyBranch caps + trims", slugifyBranch("   ") === "ob1/change");
check("buildGhCreateArgs draft + body-file", (() => { const a = buildGhCreateArgs({ title: "T", base: "main", head: "ob1/x", draft: true }); return a.includes("--draft") && a.includes("--body-file") && a.includes("-") && a[a.indexOf("--base") + 1] === "main"; })());

{
  const p = parsePrChecks("build\tpass\t1m\turl\ntest\tpass\t2m\turl");
  check("parsePrChecks all pass", p.state === "pass" && p.passed === 2 && p.total === 2);
  const f = parsePrChecks("build\tpass\nlint\tfail\ne2e\tpending");
  check("parsePrChecks fail dominates", f.state === "fail" && f.failed === 1 && f.failures[0] === "lint" && f.pending === 1);
  const n = parsePrChecks("no checks reported on this branch");
  check("parsePrChecks none", n.state === "none" && n.total === 0);
}

// fake gh/git runner for createPr happy path
const ghYes = (argv: string[]) => argv[0] === "bash" && /command -v gh/.test(argv[2]);
const makeRunner = (handlers: Array<[(a: string[]) => boolean, CmdResult]>): CmdRunner => async (argv) => {
  for (const [m, res] of handlers) if (m(argv)) return res;
  return ok(0, "", "");
};
{
  const run = makeRunner([
    [ghYes, ok(0, "__yes__")],
    [(a) => a.includes("--show-toplevel"), ok(0, "/repo")],
    [(a) => a.includes("symbolic-ref"), ok(0, "refs/remotes/origin/main\n")],
    [(a) => a.includes("--abbrev-ref"), ok(0, "feature-x\n")],
    [(a) => a.includes("rev-list"), ok(0, "2\n")],
    [(a) => a.includes("push"), ok(0, "", "Branch set up")],
    [(a) => a[0] === "gh" && a.includes("create"), ok(0, "https://github.com/o/r/pull/7\n")],
  ]);
  const out = await createPr({ title: "Feature X", body: "does X" }, { cwd: "/repo", run });
  check("createPr happy path returns PR url", /pull\/7/.test(out), out);
}
{
  const run = makeRunner([[ghYes, ok(1, "__no__")]]);
  const out = await createPr({ title: "X" }, { cwd: "/repo", run });
  check("createPr without gh → actionable guidance", /gh.*not installed/i.test(out));
}
{
  const run = makeRunner([
    [ghYes, ok(0, "__yes__")],
    [(a) => a.includes("--show-toplevel"), ok(0, "/repo")],
    [(a) => a.includes("symbolic-ref"), ok(0, "refs/remotes/origin/main\n")],
    [(a) => a.includes("--abbrev-ref"), ok(0, "feature-x\n")],
    [(a) => a.includes("rev-list"), ok(0, "0\n")], // no commits ahead
  ]);
  const out = await createPr({ title: "X" }, { cwd: "/repo", run });
  check("createPr refuses empty PR (no commits ahead)", /no commits ahead/i.test(out));
}
{
  const run = makeRunner([[ghYes, ok(0, "__yes__")], [(a) => a.includes("--show-toplevel"), ok(128, "", "not a git repository")]]);
  const out = await createPr({ title: "X" }, { cwd: "/x", run });
  check("createPr outside a repo → guidance", /not inside a git repository/i.test(out));
}

// pr_checks: pass / fail / wait-until-settled
{
  const run = makeRunner([[ghYes, ok(0, "__yes__")], [(a) => a[0] === "gh", ok(0, "build\tpass\ntest\tpass")]]);
  const out = await prChecks({}, { cwd: "/repo", run });
  check("pr_checks all-pass summary", /all checks passed/i.test(out) && !/NOT green/.test(out));
}
{
  const run = makeRunner([[ghYes, ok(0, "__yes__")], [(a) => a[0] === "gh", ok(1, "build\tpass\nlint\tfail")]]);
  const out = await prChecks({}, { cwd: "/repo", run });
  check("pr_checks failure shows gate text", /FAILED/.test(out) && /NOT green/.test(out) && /lint/.test(out));
}
{
  let calls = 0;
  const run: CmdRunner = async (argv) => {
    if (ghYes(argv)) return ok(0, "__yes__");
    if (argv[0] === "gh") { calls++; return calls < 2 ? ok(0, "build\tpending") : ok(0, "build\tpass"); }
    return ok(0);
  };
  const out = await prChecks({ wait: true }, { cwd: "/repo", run }, async () => {}); // instant sleep
  check("pr_checks wait polls until settled", calls === 2 && /all checks passed/i.test(out));
}

// create_pr / pr_checks tool registration + flags
{
  const t = buildTools({ cwd: dir } as any, {} as any);
  check("create_pr registered + mutating", !!t.get("create_pr") && t.get("create_pr")!.mutating === true);
  check("pr_checks registered + read-only", !!t.get("pr_checks") && t.get("pr_checks")!.mutating === false);
}

// ───────────────────────── expose_port ─────────────────────────
console.log("\n── expose_port ──");
check("tunnelCommand cloudflared", tunnelCommand("cloudflared", 3000).join(" ") === "cloudflared tunnel --url http://localhost:3000");
check("tunnelCommand localtunnel", tunnelCommand("localtunnel", 8080).includes("localtunnel") && tunnelCommand("localtunnel", 8080).includes("8080"));
check("extract cloudflared url", extractTunnelUrl("cloudflared", "INF |  https://brave-fox-12.trycloudflare.com  |") === "https://brave-fox-12.trycloudflare.com");
check("extract localtunnel url", extractTunnelUrl("localtunnel", "your url is: https://tame-cat.loca.lt") === "https://tame-cat.loca.lt");
check("extract localhost.run url", extractTunnelUrl("localhost.run", "tunneled at https://abc123.lhr.life") === "https://abc123.lhr.life");
check("extract returns null when absent", extractTunnelUrl("cloudflared", "starting…") === null);
{
  const has = (bin: string): CmdRunner => async (argv) => ok(0, new RegExp(`command -v ${bin}`).test(argv[2] ?? "") ? "__yes__" : "__no__");
  check("pickProvider picks cloudflared when present", (await pickProvider(undefined, has("cloudflared"))) === "cloudflared");
  check("pickProvider honors preference", (await pickProvider("localtunnel", async () => ok(0, "__yes__"))) === "localtunnel");
  const none: CmdRunner = async () => ok(0, "__no__");
  check("pickProvider null when none installed", (await pickProvider(undefined, none)) === null);
}
{
  const t = buildTools({ cwd: dir } as any, {} as any);
  check("expose_port registered + mutating", !!t.get("expose_port") && t.get("expose_port")!.mutating === true);
  // Public exposure is outward-facing risk: it must confirm even in autopilot (forceAsk), so it can't
  // auto-open a tunnel unattended and is always denied in a non-interactive session.
  check("expose_port forces confirmation even in autopilot (forceAsk)", t.get("expose_port")!.forceAsk === true);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? "\nFAIL" : "\nPASS — delivery surface (sql · secrets · pr/ci · expose) verified");
process.exit(fail ? 1 : 0);
