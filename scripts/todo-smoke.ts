// Deterministic test for the task-list feature (update_tasks tool + TodoRegistry). No API key / no UI.
// Verifies the tool registers only when a TodoRegistry is wired, full-replace create/update/clear
// semantics, status + shape normalization, the live registry state the TUI renders, and subscribe().
// Usage: bun run scripts/todo-smoke.ts
import { buildTools } from "../src/agent/tools.ts";
import { TodoRegistry } from "../src/agent/todo-registry.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

// buildTools only touches cfg/store inside other tools' run closures, so plain stubs suffice here.
const cfg = { cwd: process.cwd() } as any;
const store = {} as any;

// 1. Registered only when a TodoRegistry is wired.
const noTodo = buildTools(cfg, store);
check("update_tasks NOT registered without a TodoRegistry", !noTodo.has("update_tasks"));

const todos = new TodoRegistry();
let emits = 0;
todos.subscribe(() => { emits++; });
const tools = buildTools(cfg, store, undefined, undefined, todos);
check("update_tasks registered when a TodoRegistry is wired", tools.has("update_tasks"));
const tool = tools.get("update_tasks")!;
check("update_tasks is read-only (no approval gate, allowed in Plan mode)", tool.mutating === false);

// 2. Create: the full list populates the registry; the result string reflects progress.
const r1 = await tool.run({ tasks: [
  { content: "Read the config", status: "completed" },
  { content: "Add the tool", status: "in_progress" },
  { content: "Wire the TUI", status: "pending" },
] });
check("create populates the registry", todos.size === 3, String(todos.size));
check("registry tracks completed count", todos.done === 1, String(todos.done));
check("registry preserves order + statuses", todos.list()[1].content === "Add the tool" && todos.list()[1].status === "in_progress");
check("result string summarizes progress", typeof r1 === "string" && r1.includes("1/3 done"), r1 as string);
check("set() emitted to subscribers", emits === 1, String(emits));

// 3. Update: a later full-replace call swaps statuses (not append).
await tool.run({ tasks: [
  { content: "Read the config", status: "completed" },
  { content: "Add the tool", status: "completed" },
  { content: "Wire the TUI", status: "in_progress" },
] });
check("update replaces the list (no append)", todos.size === 3 && todos.done === 2);

// 4. Normalization: bare string → pending; status synonyms; {task}/{state}; blanks dropped; trims.
await tool.run({ tasks: [
  "  loose string  ",
  { content: "x", status: "done" },
  { task: "y", state: "doing" },
  { content: "   ", status: "pending" }, // blank → dropped
] });
const norm = todos.list();
check("bare string item → pending + trimmed", norm[0].content === "loose string" && norm[0].status === "pending");
check("status synonym 'done' → completed", norm[1].status === "completed");
check("alt keys {task,state:'doing'} → in_progress", norm[2].content === "y" && norm[2].status === "in_progress");
check("blank-content item dropped", norm.length === 3);

// 5. Clear: an empty tasks array empties the registry.
const rc = await tool.run({ tasks: [] });
check("empty tasks array clears the registry", todos.size === 0);
check("clear result string says cleared", typeof rc === "string" && /clear/i.test(rc), rc as string);

// 6. Robust to missing/garbage input (no throw → empty list).
await tool.run({});
check("missing tasks → no throw, empty list", todos.size === 0);

if (fail) { console.error("\n✗ todo smoke FAILED"); process.exit(1); }
console.log("\n✓ todo smoke passed (registry + update_tasks: registration gate · create/update/clear replace semantics · normalization · live state + subscribe)");
process.exit(0);
