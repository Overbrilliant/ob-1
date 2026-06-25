// End-to-end test of the delivery surface THROUGH the real agent loop (runTurn) with a scripted mock
// model — no API key, no network. Proves the wired path: a model emits an execute_sql / request_secret /
// create_pr tool call, the loop gates + runs it, and the result is fed back correctly. Also asserts (a) the
// SQLite write actually hit disk, (b) a secret value NEVER appears in any tool_result returned to the
// model, and (c) the capability guidance is present in the system prompt ("the prompt follows the tool").
// Usage: bun run scripts/delivery-e2e-smoke.ts
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, type TurnDeps } from "../src/agent/loop.ts";
import { buildTools } from "../src/agent/tools.ts";
import { runSqlite } from "../src/agent/sql.ts";
import { SecretStore } from "../src/agent/secrets.ts";
import { loadConfig } from "../src/config.ts";
import { MockBrain, asText, asToolUse, toolResultsIn } from "../src/eval/parity.ts";
import type { Message } from "../src/providers/types.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const dir = mkdtempSync(join(tmpdir(), "ob1-delivery-e2e-"));
const store = { searchSemantic: async () => [], listFacts: () => [], listRelationships: () => [] } as any;
const SECRET = "TOP-SECRET-VALUE-zzz";
const secrets = new SecretStore({ prompt: async () => SECRET });
// autopilot so mutating tools run without an approval prompt; secrets wired so request_secret registers.
const cfg = { ...loadConfig(), apiKey: "test-key", cwd: dir, dataDir: dir, planMode: false, sandbox: "off", repoMap: false, permissionMode: "autopilot" } as any;
const deps = (brain: MockBrain, over: Partial<TurnDeps> = {}): TurnDeps => ({
  cfg, store, tools: buildTools(cfg, store, undefined, undefined, undefined, undefined, { secrets }),
  approve: async () => true, log: () => {}, verify: undefined, _callModel: brain.callModel, onMutate: () => {}, ...over,
});
// tool_results accumulate across a turn's requests (history grows), so the result of the call made at step
// N-1 is the LAST tool_result in request N. `latest(i)` returns that most-recently-added result.
const latest = (brain: MockBrain, i: number) => { const f = toolResultsIn(brain.request(i)); return f[f.length - 1]; };

// ── execute_sql through the loop: CREATE → INSERT → SELECT, result fed back, DB on disk ──
{
  const brain = new MockBrain([
    asToolUse([{ name: "execute_sql", input: { sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)", db: "app.db" } }]),
    asToolUse([{ name: "execute_sql", input: { sql: "INSERT INTO notes(body) VALUES ('ship it')", db: "app.db" } }]),
    asToolUse([{ name: "execute_sql", input: { sql: "SELECT body FROM notes", db: "app.db" } }]),
    asText("the note says: ship it"),
  ]);
  const history: Message[] = [];
  await runTurn("save a note in sqlite and read it back", history, deps(brain));
  check("execute_sql e2e: four model steps (3 tools + answer)", brain.steps === 4);
  const insFed = latest(brain, 2);
  check("execute_sql e2e: INSERT reported 1 row affected", !!insFed && /1 row\(s\) affected/.test(insFed.content) && !insFed.is_error);
  const selFed = latest(brain, 3);
  check("execute_sql e2e: SELECT rows fed back to the model", !!selFed && /ship it/.test(selFed.content) && !selFed.is_error);
  check("execute_sql e2e: the SQLite file was actually written to disk", existsSync(join(dir, "app.db")));
}

// ── Plan mode: read-only SQL is allowed; writes are still blocked before approval ──
{
  runSqlite(dir, "plan.db", "CREATE TABLE plan_notes(body TEXT)");
  runSqlite(dir, "plan.db", "INSERT INTO plan_notes(body) VALUES ('readable')");
  const planCfg = { ...cfg, planMode: true, permissionMode: "ask" } as any;
  const planDeps = (brain: MockBrain): TurnDeps => {
    let approvals = 0;
    return {
      ...deps(brain),
      cfg: planCfg,
      tools: buildTools(planCfg, store, undefined, undefined, undefined, undefined, { secrets }),
      approve: async () => { approvals++; return true; },
      onMutate: () => { approvals += 100; },
      log: () => {},
      get _approvals() { return approvals; },
    } as TurnDeps & { _approvals: number };
  };
  const readBrain = new MockBrain([
    asToolUse([{ name: "execute_sql", input: { sql: "SELECT body FROM plan_notes", db: "plan.db" } }]),
    asText("readable"),
  ]);
  const readDeps = planDeps(readBrain) as TurnDeps & { _approvals: number };
  await runTurn("inspect sqlite in plan mode", [], readDeps);
  const readFed = latest(readBrain, 1);
  check("execute_sql plan-mode SELECT runs", !!readFed && /readable/.test(readFed.content) && !readFed.is_error);
  check("execute_sql plan-mode SELECT needs no approval/mutation", readDeps._approvals === 0);

  const writeBrain = new MockBrain([
    asToolUse([{ name: "execute_sql", input: { sql: "INSERT INTO plan_notes(body) VALUES ('blocked')", db: "plan.db" } }]),
    asText("blocked"),
  ]);
  await runTurn("write sqlite in plan mode", [], planDeps(writeBrain));
  const writeFed = latest(writeBrain, 1);
  check("execute_sql plan-mode INSERT is blocked", !!writeFed && writeFed.is_error === true && /Plan mode/.test(writeFed.content));
}

// ── request_secret / check_secret through the loop: captured, exposed, value never leaked ──
{
  delete process.env.MY_API_KEY;
  const brain = new MockBrain([
    asToolUse([{ name: "request_secret", input: { name: "MY_API_KEY", reason: "call the weather API" } }]),
    asToolUse([{ name: "check_secret", input: { name: "MY_API_KEY" } }]),
    asText("secret is set; proceeding"),
  ]);
  const history: Message[] = [];
  await runTurn("get the api key from the user", history, deps(brain));
  const reqFed = latest(brain, 1);
  check("request_secret e2e: captured + confirmed (no value)", !!reqFed && /MY_API_KEY/.test(reqFed.content) && !reqFed.content.includes(SECRET));
  check("request_secret e2e: value exposed to env for run_bash", process.env.MY_API_KEY === SECRET);
  const chkFed = latest(brain, 2);
  check("check_secret e2e: reports available, hides value", !!chkFed && /available/.test(chkFed.content) && !chkFed.content.includes(SECRET));
  // the secret value must appear NOWHERE in anything sent back to the model (tool results across all steps)
  let leaked = false;
  for (let i = 0; i < brain.steps; i++) for (const r of toolResultsIn(brain.request(i))) if (r.content.includes(SECRET)) leaked = true;
  check("request_secret e2e: secret VALUE never leaks into any tool_result", !leaked);
  delete process.env.MY_API_KEY;
}

// ── create_pr through the loop degrades gracefully (no repo / no gh) — never crashes the turn ──
{
  const brain = new MockBrain([
    asToolUse([{ name: "create_pr", input: { title: "Add feature", body: "does the thing" } }]),
    asText("handled"),
  ]);
  const history: Message[] = [];
  await runTurn("open a pr", history, deps(brain));
  const fed = latest(brain, 1);
  check("create_pr e2e: a graceful tool_result fed back (no crash)", !!fed && fed.content.length > 0);
  check("create_pr e2e: result is actionable guidance, not a stack trace", !!fed && /gh|git repositor|commit|PR|branch/i.test(fed.content));
}

// ── the system prompt advertises the capabilities (the prompt that follows the tools) ──
{
  const brain = new MockBrain([asText("ok")]);
  await runTurn("hi", [], deps(brain));
  const sys = brain.request(0)?.system ?? "";
  check("system prompt: includes execute_sql guidance", /execute_sql/.test(sys));
  check("system prompt: includes create_pr / pr_checks guidance", /create_pr/.test(sys) && /pr_checks/.test(sys));
  check("system prompt: includes request_secret guidance", /request_secret/.test(sys));
  check("system prompt: includes expose_port guidance", /expose_port/.test(sys));
  check("system prompt: includes the 'CI green' completion gate", /CI is green|until CI/i.test(sys));
}

if (fail) { console.error("\n✗ delivery-e2e smoke FAILED"); process.exit(1); }
console.log("\n✓ delivery-e2e smoke passed — sql/secrets/pr drive the real agent loop end-to-end");
process.exit(0);
