// Deterministic test for the run_bash process registry (footer + ⌃P kill manager).
// Covers: ProcRegistry add/list/remove/kill(escalation)/killAll/subscribe, and an end-to-end run_bash
// round-trip — a normal command registers + cleans up with correct output, and a long command can be
// killed and returns promptly (no hang on the wrapper's pipes).
// Usage: bun run scripts/procs-smoke.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { ProcRegistry } from "../src/agent/procs.ts";
import { buildTools, normalizeToolOutput, type ToolOutput } from "../src/agent/tools.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** These tools all return text — unwrap the ToolOutput union for the string assertions below. */
const text = (o: ToolOutput) => normalizeToolOutput(o).text;

// ── ProcRegistry unit ──
{
  const r = new ProcRegistry();
  let events = 0;
  r.subscribe(() => { events++; });
  const signals: (string | number | undefined)[] = [];
  const id = r.add("sleep 100", (sig) => signals.push(sig), 4242);
  check("add registers a process (size 1, listed)", r.size === 1 && r.list()[0].command === "sleep 100" && r.list()[0].pid === 4242);
  check("add emitted a change event", events === 1);
  check("list carries a startedAt timestamp", typeof r.list()[0].startedAt === "number" && r.list()[0].startedAt > 0);

  r.kill(id);
  check("first kill sends SIGTERM + marks killing", signals[0] === "SIGTERM" && r.list()[0].killing === true);
  r.kill(id);
  check("second kill escalates to SIGKILL", signals[1] === "SIGKILL");

  r.remove(id);
  check("remove drops the process (size 0)", r.size === 0);
  check("kill on an unknown id is a no-op (returns false)", r.kill(999) === false);

  // killAll signals every live process once
  const ka: string[] = [];
  const r2 = new ProcRegistry();
  r2.add("a", (s) => ka.push("a:" + s));
  r2.add("b", (s) => ka.push("b:" + s));
  r2.killAll();
  check("killAll signals every process", ka.length === 2 && ka.every((x) => x.endsWith("SIGTERM")));
}

// ── run_bash end-to-end (real shell, sandbox off) ──
const cfg = { cwd: process.cwd(), sandbox: "off" } as any;
const store = {} as any;

{
  const reg = new ProcRegistry();
  let maxSize = 0;
  reg.subscribe(() => { maxSize = Math.max(maxSize, reg.size); });
  const tools = buildTools(cfg, store, undefined, reg);
  const out = text(await tools.get("run_bash")!.run({ command: "echo hello-procs" }));
  check("run_bash returns exit 0 + stdout", out.startsWith("exit 0") && out.includes("hello-procs"));
  check("run_bash registered a process while running", maxSize >= 1);
  check("run_bash deregistered after it finished", reg.size === 0);
}

// ── malformed run_bash: a missing/blank command fails cleanly (never spawns or registers a broken
//    proc — an undefined command crashed the TUI render at `p.command.length`) ──
{
  const reg = new ProcRegistry();
  const tools = buildTools(cfg, store, undefined, reg);
  for (const bad of [{}, { command: "" }, { command: "   " }, { command: 42 as any }]) {
    let threw = false;
    try { await tools.get("run_bash")!.run(bad as any); } catch { threw = true; }
    check(`run_bash rejects a malformed command (${JSON.stringify(bad)})`, threw);
  }
  check("a rejected run_bash registers no process", reg.size === 0);
  // Registry hardening: even if a non-string slips in, list() must be render-safe (command is a string).
  const r2 = new ProcRegistry();
  r2.add(undefined as any, () => {});
  check("ProcRegistry coerces a non-string command to a string (render-safe)", typeof r2.list()[0].command === "string");
}

// ── run_bash `cwd` parameter (cwd does NOT persist between calls, so callers pass it per-command) ──
{
  const tools = buildTools(cfg, store, undefined, new ProcRegistry());
  const sub = mkdtempSync(join(process.cwd(), "ob1-cwd-"));
  const rel = relative(process.cwd(), sub);
  try {
    const out = text(await tools.get("run_bash")!.run({ command: "pwd", cwd: rel }));
    check("run_bash cwd runs the command in the given subdirectory", out.includes(rel) || out.includes(sub));
    let errMsg = "";
    try { await tools.get("run_bash")!.run({ command: "pwd", cwd: "no-such-dir-xyz-123" }); }
    catch (e) { errMsg = (e as Error).message; }
    check("run_bash cwd: a missing directory yields a clear error", /cwd does not exist/.test(errMsg));
  } finally { rmSync(sub, { recursive: true, force: true }); }
}

// ── timeout: a stuck foreground command is killed instead of hanging the turn ──
{
  const tools = buildTools(cfg, store, undefined, new ProcRegistry());
  const t0 = Date.now();
  const out = text(await tools.get("run_bash")!.run({ command: "sleep 5", timeout_ms: 300 }));
  const elapsed = Date.now() - t0;
  check("run_bash timeout kills a stuck command (reports timed out)", /timed out after/.test(out));
  check("run_bash timeout returns promptly, not after the full command", elapsed < 3000);
}

// kill a long-running command → run_bash returns promptly with a non-zero exit
{
  const reg = new ProcRegistry();
  const tools = buildTools(cfg, store, undefined, reg);
  const t0 = Date.now();
  const p = tools.get("run_bash")!.run({ command: "sleep 5" });
  for (let i = 0; i < 100 && reg.size === 0; i++) await sleep(20); // wait for registration
  check("a long run_bash shows up in the registry", reg.size === 1);
  reg.kill(reg.list()[0].id);
  const out = text(await p);
  const elapsed = Date.now() - t0;
  check("killed run_bash returns promptly (well under the 5s sleep)", elapsed < 2500);
  check("killed run_bash reports a non-zero exit", out.startsWith("exit ") && !out.startsWith("exit 0"));
  check("killed run_bash deregistered", reg.size === 0);
}

// ── registry output buffer (background capture) ──
{
  const r = new ProcRegistry();
  const id = r.add("server", () => {}, 7, true);
  check("add(background) marks the proc as background", r.get(id)?.background === true);
  r.appendOutput(id, "Listening on http://localhost:3000\n");
  check("appendOutput buffers + tail returns it", r.tail(id).includes("localhost:3000"));
  r.appendOutput(id, "x".repeat(20_000));
  check("output buffer is capped (ring)", r.tail(id, 50_000).length <= 16_000);
}

// ── background run_bash: returns immediately, stays registered, captures output, agent can kill ──
{
  const reg = new ProcRegistry();
  const tools = buildTools(cfg, store, undefined, reg);
  check("list_bash + kill_bash tools are offered when a registry is wired", tools.has("list_bash") && tools.has("kill_bash"));

  const t0 = Date.now();
  // A "server": prints a line, then blocks forever. background:true must return without waiting for exit.
  const out = text(await tools.get("run_bash")!.run({ command: "echo READY-URL; sleep 30", background: true }));
  const elapsed = Date.now() - t0;
  check("background run_bash returns promptly (does not block on the process)", elapsed < 1500);
  check("background run_bash reports the process id", /background process #\d+/.test(out));
  check("background process stays in the registry", reg.size === 1 && reg.list()[0].background === true);

  // its output is captured + visible to the agent via list_bash
  for (let i = 0; i < 100 && !reg.tail(reg.list()[0].id).includes("READY-URL"); i++) await sleep(20);
  const listed = text(await tools.get("list_bash")!.run({}));
  check("list_bash shows the running process + its buffered output", listed.includes("READY-URL") && /#\d+/.test(listed));

  // the agent kills it by id → it deregisters (footer clears)
  const id = reg.list()[0].id;
  const killed = text(await tools.get("kill_bash")!.run({ id }));
  check("kill_bash signals the process", killed.includes(`#${id}`));
  for (let i = 0; i < 100 && reg.size > 0; i++) await sleep(20); // exited.then → remove
  check("killed background process deregisters (footer clears)", reg.size === 0);

  const unknown = text(await tools.get("kill_bash")!.run({ id: 9999 }));
  check("kill_bash on an unknown id is a friendly no-op", unknown.includes("no run_bash process with id 9999"));
  check("kill_bash on an unknown id hints OS-PID vs run_bash id", unknown.toLowerCase().includes("os pid"));
  check("list_bash with nothing running says so", text(await tools.get("list_bash")!.run({})) === "no running processes");
}

// ── restart_bash: clean kill → wait-for-exit → relaunch (same command + cwd, new id) ──
{
  const reg = new ProcRegistry();
  const tools = buildTools(cfg, store, undefined, reg);
  check("restart_bash tool is offered when a registry is wired", tools.has("restart_bash"));
  const sub = mkdtempSync(join(process.cwd(), "ob1-restart-"));
  const rel = relative(process.cwd(), sub);
  try {
    await tools.get("run_bash")!.run({ command: "echo READY; sleep 30", background: true, cwd: rel });
    const id1 = reg.list()[0].id;
    check("a background proc records the cwd it was launched in", reg.get(id1)?.cwd === sub);

    const out = text(await tools.get("restart_bash")!.run({ id: id1 }));
    check("restart_bash reports old id → new id", /restarted #\d+ → new #\d+/.test(out));
    check("the old process id is gone (it exited before relaunch)", reg.get(id1) === undefined);
    const fresh = reg.list().find((p) => p.background);
    check("a new background process is running", !!fresh && fresh.id !== id1);
    check("relaunched with the SAME command", fresh?.command === "echo READY; sleep 30");
    check("relaunched in the SAME directory", fresh?.cwd === sub);
    if (fresh) { reg.kill(fresh.id); for (let i = 0; i < 100 && reg.size > 0; i++) await sleep(20); }
  } finally { rmSync(sub, { recursive: true, force: true }); }

  const unknown = text(await tools.get("restart_bash")!.run({ id: 9999 }));
  check("restart_bash on an unknown id is a friendly no-op", unknown.includes("no run_bash process with id 9999"));

  const reg2 = new ProcRegistry();
  const tools2 = buildTools(cfg, store, undefined, reg2);
  const fgId = reg2.add("echo hi", () => {}, 111, false);
  check("restart_bash refuses a foreground process", text(await tools2.get("restart_bash")!.run({ id: fgId })).includes("foreground"));
}

// kill_bash given an OS PID (not the run_bash id) → points the agent at the right id instead of no-op'ing
{
  const reg = new ProcRegistry();
  const tools = buildTools(cfg, store, undefined, reg);
  const id = reg.add("npm run develop", () => {}, 54321, true); // pid 54321, run_bash id is `id`
  const byPid = text(await tools.get("kill_bash")!.run({ id: 54321 }));
  check("kill_bash with an OS PID identifies it as a PID", byPid.includes("OS PID"));
  check("kill_bash with an OS PID points to the real run_bash id", byPid.includes(`id: ${id}`));
}

// list_bash / kill_bash are NOT offered when there's no registry (e.g. headless eval)
{
  const tools = buildTools(cfg, store, undefined, undefined);
  check("no proc tools without a registry", !tools.has("list_bash") && !tools.has("kill_bash"));
}

if (fail) { console.error("\n✗ procs smoke FAILED"); process.exit(1); }
console.log("\n✓ procs smoke passed (registry add/kill/killAll + output buffer + run_bash fg/bg register/cleanup + cwd + timeout + list_bash/kill_bash + prompt kill)");
process.exit(0);
