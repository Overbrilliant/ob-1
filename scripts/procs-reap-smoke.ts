// Deterministic test that background processes are reaped — including their SUBTREE — so a detached
// dev server/watcher never outlives the OB-1 harness (no API key / no network).
//   • reapAll() SIGKILLs every tracked process
//   • makeProcKiller: foreground → raw per-process kill; background → group kill (with raw fallback)
//   • integration: a REAL detached `bash → sleep` tree is fully killed by the group signal (the child,
//     i.e. the actual server, dies too — not just the bash wrapper)
// Usage: bun run scripts/procs-reap-smoke.ts
import { spawnSync } from "node:child_process";
import { ProcRegistry, makeProcKiller } from "../src/agent/procs.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pgrepChildren = (pid: number): number[] => {
  const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
};
const waitDead = async (pid: number, ms = 2000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(40); }
  return !alive(pid);
};

// ── reapAll: SIGKILL everything tracked ──────────────────────────────────────
{
  const reg = new ProcRegistry();
  const killed: string[] = [];
  reg.add("a", (s) => killed.push(`a:${String(s)}`), 1001, true);
  reg.add("b", (s) => killed.push(`b:${String(s)}`), 1002, false);
  reg.reapAll();
  check("reapAll SIGKILLs every tracked process", killed.includes("a:SIGKILL") && killed.includes("b:SIGKILL"));
}

// ── makeProcKiller routing ───────────────────────────────────────────────────
{
  let raw: string | undefined;
  makeProcKiller(2002, (s) => { raw = String(s); }, false)("SIGTERM");
  check("foreground killer uses the raw per-process kill", raw === "SIGTERM");

  // background with a pid whose process GROUP doesn't exist → group signal throws → falls back to raw.
  let raw2: string | undefined;
  makeProcKiller(999_999, (s) => { raw2 = String(s); }, true)("SIGKILL");
  check("background killer falls back to raw kill when the group can't be signaled", raw2 === "SIGKILL");
}

// ── integration: a real detached subtree is fully reaped ─────────────────────
{
  // `sleep 30; echo x` keeps bash alive as the PARENT (it has more to run, so it won't exec-replace
  // itself with sleep) — so this is a genuine grandchild-of-OB-1 (bash → sleep) scenario.
  const proc = Bun.spawn(["bash", "-lc", "sleep 30; echo x"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
  const wrapperPid = proc.pid!;
  // Poll for bash to fork its `sleep` child instead of a fixed sleep — a fixed wait flakes on a
  // loaded CI runner where the fork takes >250ms (mirrors how the mini-harness section waits below).
  let children: number[] = [];
  for (let i = 0; i < 75 && children.length === 0; i++) { await sleep(40); children = pgrepChildren(wrapperPid); }
  check("detached background proc has a child (the 'real server' under the wrapper)", children.length >= 1);
  check("the wrapper is its own process group leader (detached)", (() => { try { return process.kill(-wrapperPid, 0) === true || true; } catch { return false; } })());

  // Group-kill via the same killer run_bash registers for a background proc.
  makeProcKiller(wrapperPid, (s) => proc.kill(s as any), true)("SIGKILL");

  check("wrapper process is killed", await waitDead(wrapperPid));
  let allChildrenDead = true;
  for (const cp of children) if (!(await waitDead(cp))) allChildrenDead = false;
  check("the child (the real server) is killed too — no orphan left behind", allChildrenDead);

  // Safety: clean up anything still lingering so the test never leaks.
  try { proc.kill(9); } catch { /* gone */ }
  for (const cp of children) { try { process.kill(cp, 9); } catch { /* gone */ } }
}

// ── end-to-end: killing the HARNESS reaps its background subtree ─────────────
// Launch a mini-harness (a child `bun` that installs the same signal/exit reaper and starts a detached
// background subtree), then external-kill it with SIGTERM and confirm the subtree is gone — exactly the
// "kill the background processes when the OB harness is killed" guarantee.
{
  const { writeFileSync, existsSync, readFileSync, rmSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const root = join(dirname(new URL(import.meta.url).pathname), "..");
  const procsMod = join(root, "src", "agent", "procs.ts");
  const dir = mkdtempSync(join(tmpdir(), "ob1-reap-e2e-"));
  const helperPath = join(dir, "harness.ts");
  // The mini-harness mirrors index.ts's reaper signal set EXACTLY — including SIGQUIT (⌃\) and SIGALRM
  // (a deadline/alarm timeout), which leak orphans if not handled because 'exit' doesn't fire on an
  // uncaught terminating signal.
  writeFileSync(helperPath, `
import { ProcRegistry, makeProcKiller } from ${JSON.stringify(procsMod)};
import { writeFileSync } from "node:fs";
const procs = new ProcRegistry();
let r = false; const reap = () => { if (r) return; r = true; try { procs.reapAll(); } catch {} };
process.on("exit", reap);
for (const s of ["SIGINT","SIGTERM","SIGHUP","SIGQUIT","SIGALRM"]) process.once(s, () => { reap(); process.exit(0); });
const p = Bun.spawn(["bash","-lc","sleep 30; echo x"], { stdout:"ignore", stderr:"ignore", stdin:"ignore", detached: true });
procs.add("srv", makeProcKiller(p.pid, (sig) => p.kill(sig), true), p.pid, true);
writeFileSync(process.argv[2], String(p.pid));
setTimeout(() => {}, 60000);
`);
  // Run the kill→reap guarantee for each terminating signal — SIGTERM (external kill) AND SIGALRM (the
  // deadline-timeout case that previously leaked the background subtree).
  for (const sig of ["SIGTERM", "SIGALRM"] as const) {
    const pf = join(dir, `wrapper-${sig}.pid`);
    const harness = Bun.spawn(["bun", helperPath, pf], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    let wrapper = 0, kids: number[] = [];
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      if (!wrapper && existsSync(pf)) wrapper = Number(readFileSync(pf, "utf8").trim());
      if (wrapper) { kids = pgrepChildren(wrapper); if (kids.length) break; }
    }
    check(`[${sig}] mini-harness started a detached background subtree`, wrapper > 0 && kids.length >= 1);

    harness.kill(sig); // external signal to the harness — the reaper must fire before exit

    check(`[${sig}] harness exits`, await waitDead(harness.pid!));
    check(`[${sig}] harness's background wrapper is reaped`, await waitDead(wrapper));
    let kidsDead = true;
    for (const cp of kids) if (!(await waitDead(cp))) kidsDead = false;
    check(`[${sig}] background SUBTREE (the server) is reaped — nothing orphaned`, kidsDead);

    // Cleanup any stragglers.
    try { harness.kill(9); } catch { /* gone */ }
    if (wrapper) { try { process.kill(-wrapper, 9); } catch { /* gone */ } try { process.kill(wrapper, 9); } catch { /* gone */ } }
    for (const cp of kids) { try { process.kill(cp, 9); } catch { /* gone */ } }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("");
if (fail) { console.error("✗ procs-reap smoke FAILED"); process.exit(1); }
console.log("✓ procs-reap smoke passed");
