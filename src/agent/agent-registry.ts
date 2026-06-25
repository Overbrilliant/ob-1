// Registry of the subagents spawned by the `spawn_subagents` tool — the live state the TUI footer
// renders so the user can SEE what each parallel agent is doing and TRACK its progress (mirrors the
// ProcRegistry that backs the run_bash footer/⌃P manager). runSubagents (multimind/subagents.ts)
// registers a batch, then feeds each worker's WorkerEvents in here; the TUI subscribes and re-renders.
//
// Lifecycle: begin() clears the previous batch and starts a fresh one; start() registers one agent as
// "queued"; event() advances it (queued → running → done/failed) from its WorkerEvents; the turn loop
// clear()s the whole registry when the turn ends.
import type { WorkerEvent } from "../multimind/runtime.ts";

export type AgentStatus = "queued" | "running" | "done" | "failed";

export interface AgentInfo {
  id: number;
  label: string;       // "subagent-1"
  task: string;        // the sub-task it was given (for the footer line)
  status: AgentStatus;
  startedAt: number;   // epoch ms (set when it actually starts running)
  queuedAt: number;    // epoch ms (set at registration — for an accurate elapsed before it starts)
  steps: number;       // model calls so far
  inTok: number;
  outTok: number;
  activity: string;    // a short "what it's doing right now" (latest tool call / phase)
}

/** A compact, dependency-free description of a tool call for the footer ("read_file src/x.ts"). */
function activityFor(tool: string, input: unknown): string {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const arg = o ? (o.path ?? o.command ?? o.url ?? o.query ?? o.name) : undefined;
  return arg != null ? `${tool} ${String(arg).slice(0, 44)}` : tool;
}

export class AgentRegistry {
  private agents = new Map<number, AgentInfo>();
  private seq = 0;
  private listeners = new Set<() => void>();

  /** Subscribe to changes (the TUI re-renders on these). Returns an unsubscribe fn. */
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { for (const l of this.listeners) l(); }

  /** Start a fresh batch — drop any previous batch's agents so the footer shows only the current run. */
  begin(): void { if (this.agents.size) { this.agents.clear(); this.emit(); } }

  /** Register one subagent as queued; returns its id (used to route its events back in). */
  start(label: string, task: string): number {
    const id = ++this.seq;
    const now = Date.now();
    this.agents.set(id, { id, label, task, status: "queued", startedAt: now, queuedAt: now, steps: 0, inTok: 0, outTok: 0, activity: "queued…" });
    this.emit();
    return id;
  }

  /** Advance an agent from one of its WorkerEvents. No-op for an unknown id (defensive). */
  event(id: number, ev: WorkerEvent): void {
    const a = this.agents.get(id);
    if (!a) return;
    switch (ev.phase) {
      case "start": a.status = "running"; a.startedAt = Date.now(); a.activity = "thinking…"; break;
      case "text": if (a.activity === "thinking…" || a.activity === "queued…") a.activity = "thinking…"; return; // high-frequency; don't spam re-renders
      case "tool": a.activity = activityFor(ev.tool, ev.input); break;
      case "step": a.steps++; a.inTok += ev.inputTokens; a.outTok += ev.outputTokens; break;
      case "done": a.status = ev.ok ? "done" : "failed"; a.activity = ev.ok ? "done" : "failed"; break;
    }
    this.emit();
  }

  list(): AgentInfo[] { return [...this.agents.values()]; }
  get size(): number { return this.agents.size; }
  get runningCount(): number { let n = 0; for (const a of this.agents.values()) if (a.status === "running" || a.status === "queued") n++; return n; }

  /** Drop everything (called when the turn ends). */
  clear(): void { if (this.agents.size) { this.agents.clear(); this.emit(); } }
}
