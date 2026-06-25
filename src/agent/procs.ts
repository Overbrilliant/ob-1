// Registry of currently-running run_bash subprocesses. run_bash (tools.ts) registers a process when it
// spawns and removes it when it exits; the TUI mirrors the list — shows it in the footer and lets the
// user navigate + kill processes (the `x` key). This is why run_bash uses async Bun.spawn rather than
// the old blocking spawnSync: with the event loop free during a command, the TUI can render and accept
// keystrokes while bash runs, so a hung command can be killed instead of freezing the whole UI.
//
// Killing is best-effort: it signals the spawned `bash -lc …` wrapper (first SIGTERM, then SIGKILL on a
// second request). A grandchild that detaches into its own session may outlive the wrapper.

export interface ProcInfo {
  id: number;
  command: string;
  pid?: number;
  startedAt: number;   // epoch ms (for an elapsed-time readout)
  killing?: boolean;   // a kill signal has been sent; the process is winding down
  background?: boolean; // started detached (run_bash background:true) — outlives the turn; output buffered
  cwd?: string;        // the directory it was launched in — lets restart_bash relaunch it identically
}

type KillFn = (signal?: number | NodeJS.Signals) => void;

// Cap on the per-process captured-output ring buffer (background procs only). Keeps the tail a dev
// server's URL / recent logs live in, without letting a chatty process grow memory unbounded.
const OUT_CAP = 16_000;

export class ProcRegistry {
  private procs = new Map<number, { info: ProcInfo; kill: KillFn; out: string }>();
  private seq = 0;
  private listeners = new Set<() => void>();

  /** Subscribe to add/remove/kill changes (the TUI re-renders on these). Returns an unsubscribe fn. */
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { for (const l of this.listeners) l(); }

  /** Register a running process; returns an id to remove() it by when it exits. */
  add(command: string, kill: KillFn, pid?: number, background = false, cwd?: string): number {
    const id = ++this.seq;
    // Coerce defensively: a non-string command must never reach the TUI render (where `command.length`
    // would throw and crash the whole app). The real guard is run_bash validating its input upstream.
    this.procs.set(id, { info: { id, command: typeof command === "string" ? command : String(command ?? ""), pid, startedAt: Date.now(), background, cwd }, kill, out: "" });
    this.emit();
    return id;
  }

  remove(id: number): void { if (this.procs.delete(id)) this.emit(); }

  list(): ProcInfo[] { return [...this.procs.values()].map((p) => p.info); }
  get(id: number): ProcInfo | undefined { return this.procs.get(id)?.info; }
  get size(): number { return this.procs.size; }

  /** Buffer a chunk of a background process's combined output (drained so its pipes don't stall). */
  appendOutput(id: number, chunk: string): void {
    const p = this.procs.get(id);
    if (!p) return;
    p.out = (p.out + chunk).slice(-OUT_CAP);
  }

  /** The captured output tail for a process (background procs); "" if none/unknown. */
  tail(id: number, max = 4000): string {
    const p = this.procs.get(id);
    return p ? p.out.slice(-max) : "";
  }

  /** Kill one process: SIGTERM first, then SIGKILL if it's asked to die again (a stuck process). */
  kill(id: number): boolean {
    const p = this.procs.get(id);
    if (!p) return false;
    try { p.kill(p.info.killing ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
    p.info.killing = true;
    this.emit();
    return true;
  }

  /** Kill everything (e.g. ESC abandons the turn). */
  killAll(): void {
    for (const p of this.procs.values()) { try { p.kill(p.info.killing ? "SIGKILL" : "SIGTERM"); } catch { /* ignore */ } p.info.killing = true; }
    if (this.procs.size) this.emit();
  }

  /** Hard-kill every tracked process immediately (SIGKILL) with no state change or emit — safe to call
   *  synchronously from a process 'exit' handler so a background dev server/watcher never outlives the
   *  harness. Background procs are detached (own group), so their kill fn signals the whole subtree. */
  reapAll(): void {
    for (const p of this.procs.values()) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  }
}

/** Build the KillFn for a tracked process. Background procs are spawned DETACHED (their own process
 *  group), so we signal the whole GROUP (negative pid) to take down the `bash -lc` wrapper AND its
 *  descendants (e.g. `npm run dev` → node) — otherwise killing only the wrapper orphans the real
 *  server. Foreground procs share our group, so we just signal the process. Falls back to the raw
 *  per-process kill if the group signal can't be delivered (no pid / not a group leader). */
export function makeProcKiller(pid: number | undefined, rawKill: KillFn, background: boolean): KillFn {
  return (signal) => {
    if (background && typeof pid === "number" && pid > 1) {
      try { process.kill(-pid, (signal ?? "SIGTERM") as NodeJS.Signals); return; } catch { /* group gone / not a leader → fall back */ }
    }
    try { rawKill(signal); } catch { /* already gone */ }
  };
}
