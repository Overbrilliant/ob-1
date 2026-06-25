// Registry backing the `update_tasks` tool — the agent's TODO list for a longer, multi-step task,
// rendered above the input so the user can watch the plan and see each item get checked off (mirrors
// ProcRegistry/AgentRegistry: the TUI subscribes and re-renders on every change).
//
// The agent OWNS it via `update_tasks`, which is full-replace: the first call creates the list, later
// calls update statuses, an empty list clears it. Unlike the subagent registry it PERSISTS across turns
// (a long task spans several turns) — it's cleared only when the agent finishes and clears it.
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem { content: string; status: TodoStatus }

export class TodoRegistry {
  private items: TodoItem[] = [];
  private listeners = new Set<() => void>();

  /** Subscribe to changes (the TUI re-renders on these). Returns an unsubscribe fn. */
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { for (const l of this.listeners) l(); }

  /** Replace the whole list (create/update). Pass [] to clear. Emits once. */
  set(items: TodoItem[]): void { this.items = items; this.emit(); }
  clear(): void { if (this.items.length) { this.items = []; this.emit(); } }

  list(): TodoItem[] { return this.items; }
  get size(): number { return this.items.length; }
  get done(): number { let n = 0; for (const t of this.items) if (t.status === "completed") n++; return n; }
}
