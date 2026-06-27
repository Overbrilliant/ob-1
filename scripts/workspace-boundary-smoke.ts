// Deterministic test for the workspace-boundary + secret-handling hardening (security pass).
// Covers, with NO API key / network:
//   • read_file / run_bash refuse to escape the workspace via a symlink OR cwd:".." (path containment is
//     real-path, not just lexical) — while still allowing legitimate in-workspace paths/subdirs.
//   • request_secret values actually reach run_bash (Bun.spawn needs an explicit env), and any echo of a
//     secret value is redacted out of run_bash / list_bash output.
//   • run_bash(background) refuses to launch a SECOND copy of an identical command BEFORE spawning it
//     (no duplicate / port conflict), and read_file MARKS a >100k truncation instead of silently slicing.
// Usage: bun run scripts/workspace-boundary-smoke.ts
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcRegistry } from "../src/agent/procs.ts";
import { SecretStore } from "../src/agent/secrets.ts";
import { buildTools, ReadCache, normalizeToolOutput, type ToolOutput } from "../src/agent/tools.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const text = (o: ToolOutput) => normalizeToolOutput(o).text;
/** Run a tool and report whether it threw with a message matching `re`. */
async function refuses(run: () => Promise<unknown>, re: RegExp): Promise<{ ok: boolean; msg: string }> {
  try { const r = await run(); return { ok: false, msg: `did NOT throw (got ${String((r as any)?.text ?? r).slice(0, 50)})` }; }
  catch (e) { const m = (e as Error).message; return { ok: re.test(m), msg: m.slice(0, 70) }; }
}

// realpath the temp roots: macOS /tmp is itself a symlink, which the real-path containment check resolves.
const root = realpathSync(mkdtempSync(join(tmpdir(), "ob1-ws-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "ob1-out-")));
try {
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "inside.txt"), "hello");
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE_DATA");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt")); // in-workspace symlink → outside file
  symlinkSync(outside, join(root, "linkdir"));                       // in-workspace symlink → outside dir

  const cfg: any = { cwd: root, sandbox: "off", permissionMode: "autopilot", planMode: false };
  const secrets = new SecretStore({ exposeEnv: true });
  secrets.set("MY_SECRET_TOKEN", "supersecret123");
  const reg = new ProcRegistry();
  const tools = buildTools(cfg, {} as any, undefined, reg, undefined, new ReadCache(), { secrets });
  const readFile = tools.get("read_file")!;
  const runBash = tools.get("run_bash")!;

  // ── path containment ──
  check("read_file reads an in-workspace file", text(await readFile.run({ path: "inside.txt" }, {} as any)) === "hello");
  {
    const r = await refuses(() => readFile.run({ path: "link.txt" }, {} as any), /symlink|outside the workspace/i);
    check("read_file refuses an in-workspace symlink to an outside file", r.ok, r.msg);
  }
  {
    const r = await refuses(() => readFile.run({ path: "linkdir/secret.txt" }, {} as any), /symlink|outside the workspace/i);
    check("read_file refuses a path through a symlinked-out dir", r.ok, r.msg);
  }
  {
    const r = await refuses(() => runBash.run({ command: "pwd", cwd: ".." }, {} as any), /outside the workspace/i);
    check("run_bash refuses cwd:'..'", r.ok, r.msg);
  }
  check("run_bash allows a real in-workspace subdir", text(await runBash.run({ command: "pwd", cwd: "sub" }, {} as any)).includes(join(root, "sub")));

  // ── secrets: propagation + redaction ──
  {
    const out = text(await runBash.run({ command: "echo got=[$MY_SECRET_TOKEN]" }, {} as any));
    // The value reaches the shell (so it's non-empty); on the way back it's redacted, so we see the mask.
    check("request_secret value reaches run_bash (and is masked on return)", out.includes("got=[‹redacted›]"), out.split("\n")[1] ?? out.slice(0, 60));
  }
  {
    const out = text(await runBash.run({ command: "echo leak supersecret123 here" }, {} as any));
    check("run_bash output redacts a secret value", !out.includes("supersecret123") && out.includes("‹redacted›"));
  }

  // ── read_file truncation marker ──
  {
    writeFileSync(join(root, "big.txt"), "A".repeat(120_000));
    const out = text(await readFile.run({ path: "big.txt" }, {} as any));
    check("read_file marks a >100k truncation", /TRUNCATED/.test(out) && out.length < 120_000);
  }

  // ── duplicate background guard (refuse BEFORE spawning a second copy) ──
  {
    const first = text(await runBash.run({ command: "sleep 30", background: true }, {} as any));
    check("run_bash background launches the first copy", /started background process/.test(first));
    const before = reg.list().length;
    const second = text(await runBash.run({ command: "sleep 30", background: true }, {} as any));
    check("run_bash background refuses a duplicate (no second spawn)", /not starting a duplicate/.test(second) && reg.list().length === before, `procs ${before}→${reg.list().length}`);
    reg.killAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

console.log(fail ? "\n✗ workspace-boundary smoke FAILED" : "\n✓ workspace-boundary smoke passed (symlink/cwd containment + secret env+redaction + truncation marker + dup-bg guard)");
process.exit(fail ? 1 : 0);
