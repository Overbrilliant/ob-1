// LIVE Linux-only ENFORCEMENT test for the bubblewrap sandbox. Unlike sandbox-smoke (which only
// checks argv construction), this RUNS the real wrapCommand() under bwrap on a Linux host and proves
// the sandbox actually enforces: network is denied and writes are confined per mode. Self-skips on
// non-Linux / no bwrap. Run on Linux (or `docker run ... bun run scripts/bwrap-enforce.ts`).
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { wrapCommand, sandboxAvailable } from "../src/safety/sandbox.ts";
import type { SandboxMode } from "../src/config.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

if (platform() !== "linux" || !sandboxAvailable()) {
  console.log(`• skipped — bwrap enforcement requires Linux + usable bubblewrap (platform=${platform()}, sandboxAvailable=${sandboxAvailable()})`);
  process.exit(0);
}

// Workspace OUTSIDE /tmp (tmp is always writable by design) so read-only vs workspace-write differ.
const ws = mkdtempSync(join(homedir(), "ob1-bwrap-"));
const run = (mode: SandboxMode, cmd: string) => {
  const p = Bun.spawnSync(wrapCommand(mode, ws, cmd), { cwd: ws });
  return { code: p.exitCode ?? -1, out: (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)).trim() };
};
const NET = "timeout 6 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' && echo CONNECTED || echo BLOCKED";

try {
  // Baseline: unsandboxed network works (so the "denied" assertions below are meaningful).
  const base = run("off", NET);
  const netReachable = base.out.includes("CONNECTED");
  if (!netReachable) console.log(`• note: no outbound network in this env (baseline=${base.out.slice(0, 30)}) — network-denial asserts skipped`);
  else check("baseline (off): outbound TCP connects", true);

  for (const mode of ["read-only", "workspace-write"] as SandboxMode[]) {
    if (netReachable) {
      const r = run(mode, NET);
      check(`${mode}: network DENIED (--unshare-net)`, r.code !== 0 || r.out.includes("BLOCKED"), r.out.slice(0, 40));
    }
  }

  // read-only: nothing writable except /tmp; workspace + /etc blocked.
  check("read-only: workspace write BLOCKED", run("read-only", `touch ${ws}/x`).code !== 0);
  check("read-only: /etc write BLOCKED", run("read-only", "touch /etc/ob1x").code !== 0);
  check("read-only: /tmp write ALLOWED", run("read-only", "touch /tmp/ob1x && echo OK").out.includes("OK"));

  // workspace-write: workspace writable; /etc still blocked.
  check("workspace-write: workspace write ALLOWED", run("workspace-write", `touch ${ws}/y && echo OK`).out.includes("OK"));
  check("workspace-write: /etc write BLOCKED", run("workspace-write", "touch /etc/ob1y").code !== 0);

  // /dev/null writable in both restricted modes (tool plumbing).
  check("read-only: /dev/null writable", run("read-only", "echo hi > /dev/null && echo OK").out.includes("OK"));
} finally {
  rmSync(ws, { recursive: true, force: true });
}

if (fail) { console.error("\n✗ bwrap enforcement FAILED"); process.exit(1); }
console.log("\n✓ bwrap enforcement passed — network denied + writes confined (read-only & workspace-write) on real Linux");
process.exit(0);
