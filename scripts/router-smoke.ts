// Deterministic test for the adaptive router (no API key). Verifies Solo-first + escalate-on-fail
// via injected Solo/escalation runners and the real objective grader.
// Usage: bun run scripts/router-smoke.ts
import { runAdaptive, suggestMode } from "../src/multimind/router.ts";
import { runTurn, type TurnDeps } from "../src/agent/loop.ts";
import { BUILTIN_TASKS } from "../src/eval/tasks.ts";
import { loadConfig } from "../src/config.ts";
import type { WorkerResult } from "../src/multimind/runtime.ts";
import type { ModelResponse } from "../src/providers/types.ts";

const cfg = loadConfig();
const sumTask = BUILTIN_TASKS.find((t) => t.id === "sum-evens")!;
const OK = "```ts\nexport function sumEvens(nums){return nums.filter(n=>n%2===0).reduce((a,b)=>a+b,0)}\n```";
const BAD = "```ts\nexport function sumEvens(){return 0}\n```";
let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };
const solo = (text: string) => (async (o: { label: string }): Promise<WorkerResult> => ({ label: o.label, text, inputTokens: 5, outputTokens: 5, ok: true })) as any;

// Solo passes the check → ship Solo, never escalate.
const esc = { hit: false };
const r1 = await runAdaptive({
  task: "sum evens", cfg, tools: new Map(), check: sumTask.check,
  _runSolo: solo(OK),
  _escalate: async () => { esc.hit = true; return { text: "ESC", inputTokens: 50, outputTokens: 50 }; },
});
check("solo passes → path=solo", r1.path === "solo" && r1.soloPassed === true);
check("no escalation when solo passes", !esc.hit);
check("solo-path tokens are solo-only", r1.totalInputTokens === 5 && r1.totalOutputTokens === 5);

// Solo fails the check → escalate; final + tokens come from the escalation.
esc.hit = false;
const r2 = await runAdaptive({
  task: "sum evens", cfg, tools: new Map(), check: sumTask.check, escalateTo: "fusion",
  _runSolo: solo(BAD),
  _escalate: async () => { esc.hit = true; return { text: "ESC-FUSION", inputTokens: 50, outputTokens: 50 }; },
});
check("solo fails → path=fusion", r2.path === "fusion" && r2.soloPassed === false);
check("escalation happened", esc.hit && r2.final === "ESC-FUSION");
check("tokens = solo + escalation", r2.totalInputTokens === 55 && r2.totalOutputTokens === 55);

// No gradeable output (Solo produced no code) → conservatively ship Solo, don't escalate.
esc.hit = false;
const r3 = await runAdaptive({
  task: "explain", cfg, tools: new Map(),
  _runSolo: solo("   "),
  _escalate: async () => { esc.hit = true; return { text: "ESC", inputTokens: 50, outputTokens: 50 }; },
});
check("ungradeable → ship solo, no escalation", r3.path === "solo" && !esc.hit && r3.soloChecked === false);

// requireDifficultySignal: a SIMPLE task whose Solo output fails the check still ships Solo — escalation
// is reserved for tasks that warrant deeper analysis (this is what kills the code-fence-in-an-answer
// false positive that was dragging simple turns into Fusion).
esc.hit = false;
const r4 = await runAdaptive({
  task: "rename this variable", cfg, tools: new Map(), check: sumTask.check, escalateTo: "fusion",
  requireDifficultySignal: true,
  _runSolo: solo(BAD),
  _escalate: async () => { esc.hit = true; return { text: "ESC", inputTokens: 50, outputTokens: 50 }; },
});
check("gate on + simple task + solo fails → ship solo, no escalation", r4.path === "solo" && !esc.hit);

// requireDifficultySignal: a HARD task whose Solo output fails the check DOES escalate.
esc.hit = false;
const r5 = await runAdaptive({
  task: "find the most efficient algorithm for this", cfg, tools: new Map(), check: sumTask.check, escalateTo: "fusion",
  requireDifficultySignal: true,
  _runSolo: solo(BAD),
  _escalate: async () => { esc.hit = true; return { text: "ESC-HARD", inputTokens: 50, outputTokens: 50 }; },
});
check("gate on + hard task + solo fails → escalate", r5.path === "fusion" && esc.hit && r5.final === "ESC-HARD");

// Default (gate off, e.g. eval) preserves pure solve-what-Solo-fails: a non-keyword task still escalates.
esc.hit = false;
const r6 = await runAdaptive({
  task: "rename this variable", cfg, tools: new Map(), check: sumTask.check, escalateTo: "fusion",
  _runSolo: solo(BAD),
  _escalate: async () => { esc.hit = true; return { text: "ESC", inputTokens: 50, outputTokens: 50 }; },
});
check("gate OFF (default) → escalates regardless of difficulty signal", r6.path === "fusion" && esc.hit);

// --- suggestMode heuristic: detect hard/high-value tasks and recommend an escalation ---
check("suggest: security task → council", suggestMode("add JWT auth and hash the password")?.mode === "council");
check("suggest: design task → personas", suggestMode("review the architecture and propose a design")?.mode === "personas");
check("suggest: hard/best task → fusion", suggestMode("find the most efficient algorithm for this")?.mode === "fusion");
check("suggest: plain task → no suggestion", suggestMode("rename this variable") === null);
check("suggest: very long task → fusion", suggestMode("x".repeat(900))?.mode === "fusion");

// Regression: a bare "delete" of a FILE is NOT risk-critical — it used to wrongly suggest council
// because the keyword list contained an unconditional `delete`.
check("suggest: delete a file → no suggestion (was a false 'council')", suggestMode("delete the .DS_Store") === null);
check("suggest: delete a file (generic) → no suggestion", suggestMode("delete this file") === null);
check("suggest: remove a line/comment → no suggestion", suggestMode("delete the unused import") === null);
// But a genuinely destructive DATA op still escalates.
check("suggest: drop a table → council", suggestMode("DROP TABLE users") ?.mode === "council");
check("suggest: delete from a table → council", suggestMode("delete from the orders table") ?.mode === "council");
check("suggest: delete production data → council", suggestMode("delete the production database") ?.mode === "council");
check("suggest: delete all user records → council", suggestMode("delete all the user records") ?.mode === "council");

// --- LLM router: Solo's `escalate` tool (runTurn) — the interactive auto-route path -------------------
// Solo decides DURING its normal response. A fake model lets us drive the two outcomes deterministically:
// (a) it calls escalate → runTurn returns {escalate:{mode,reason}} and leaves valid history; (b) it just
// answers → no escalation. Also verifies the tool is gated by canEscalate (off ⇒ never escalates).
{
  const baseDeps: TurnDeps = {
    cfg: { ...cfg, apiKey: "test-key" } as any,
    tools: new Map(), store: { searchSemantic: async () => [], listFacts: () => [], listRelationships: () => [] } as any,
    approve: async () => true, log: () => {},
  };
  const text = (t: string): ModelResponse => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 3, output_tokens: 3 } as any });
  const escResp = (mode: string, reason: string): ModelResponse => ({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tu_1", name: "escalate", input: { mode, reason } }],
    usage: { input_tokens: 3, output_tokens: 3 } as any,
  });

  // (a) canEscalate on + model calls escalate → outcome carries the mode/reason
  const h1: any[] = [];
  const o1 = await runTurn("design a plugin architecture", h1, { ...baseDeps, canEscalate: true, _callModel: async () => escResp("personas", "open-ended design") });
  check("escalate tool → runTurn returns the escalation", o1.escalate?.mode === "personas" && o1.escalate?.reason === "open-ended design");
  const last1 = h1[h1.length - 1];
  check("history stays valid after escalate (tool_use answered by tool_result)", last1?.role === "user" && Array.isArray(last1.content) && last1.content[0]?.type === "tool_result" && last1.content[0]?.tool_use_id === "tu_1");

  // (b) canEscalate on + model just answers → no escalation
  const o2 = await runTurn("rename a variable", [], { ...baseDeps, canEscalate: true, _callModel: async () => text("done") });
  check("plain answer → no escalation (no wasted routing)", !o2.escalate);

  // (c) canEscalate OFF → escalate is not offered; even a stray escalate call is not honored as routing
  const o3 = await runTurn("design something", [], { ...baseDeps, canEscalate: false, _callModel: async () => escResp("fusion", "x") });
  check("auto-route off → escalate is inert (treated as a normal/unknown tool, no routing)", !o3.escalate);

  // (d) an out-of-enum mode defaults to fusion (defensive)
  const o4 = await runTurn("hard thing", [], { ...baseDeps, canEscalate: true, _callModel: async () => escResp("bogus", "r") });
  check("unknown escalate mode defaults to fusion", o4.escalate?.mode === "fusion");
}

if (fail) { console.error("\n✗ router smoke FAILED"); process.exit(1); }
console.log("\n✓ router smoke passed (Solo-first, escalate-on-fail, conservative when ungradeable, suggest-mode, LLM escalate tool)");
