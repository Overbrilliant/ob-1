// Deterministic test for VERIFIED ESCALATION (Wave 3) — driven entirely through runTurn with fake
// _callModel + verify seams: no real models, no subprocesses, no filesystem. Covers the whole decision
// surface the spec enumerates:
//   (a) checks fail through the FULL self-fix budget and STILL fail → runTurn returns { escalate } and the
//       report carries the verifier's final failure output (this is the signal the dispatcher runs Fusion on)
//   (b) checks PASS → no escalation (an ordinary green turn)
//   (c) escalation OFF (canEscalateOnFailure:false, e.g. cfg.escalation=false) → NO escalate; the legacy
//       "leaving the changes for you to review" message is logged instead
//   (d) Plan mode (read-only) → the mutating attempt is blocked, nothing verifies, nothing escalates
//   (e) apply-turn override (canEscalateOnFailure:false) → NO escalate — this is what caps escalation at
//       ONCE per user turn (the escalated Fusion's apply turn can't re-escalate)
// The PURE gate (shouldEscalate) is unit-tested separately in src/agent/loop.test.ts.
// Usage: bun run scripts/escalation-smoke.ts
import { runTurn, type TurnDeps } from "../src/agent/loop.ts";
import type { Tool } from "../src/agent/tools.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import { loadConfig } from "../src/config.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

const cfg = { ...loadConfig(), apiKey: "test-key", planMode: false } as any;
const store = { searchSemantic: async () => [], listFacts: () => [], listRelationships: () => [] } as any;
const writeTool: [string, Tool] = ["write_file", { def: { name: "write_file", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "wrote file" }];
const tools = new Map<string, Tool>([writeTool]);
const baseDeps: TurnDeps = { cfg, tools, store, approve: async () => true, log: () => {} };

// A file-changing tool_use (arms auto-verify) and a plain end_turn answer.
const edit = (): ModelResponse => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "w" + Math.round(Math.random() * 1e9), name: "write_file", input: { path: "a.ts" } }], usage: { input_tokens: 1, output_tokens: 1 } });
const done = (t: string): ModelResponse => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 1, output_tokens: 1 } });
// N+1 [edit, done] pairs drive the self-fix loop to exhaustion for autofixMax=N (verify fires once per pair).
const editDonePairs = (rounds: number): ModelResponse[] => Array.from({ length: rounds }, () => [edit(), done("attempt")]).flat();

// ── (a) verified failure after the full budget → { escalate } carrying the final report ──
{
  const REPORT = "✗ typecheck FAILED: src/a.ts(3,1): error TS2322 still broken";
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: false, report: REPORT }; };
  const seq = editDonePairs(3); // autofixMax 2 → 3 verify checks (initial + 2 self-fix rounds)
  let n = 0;
  const logs: string[] = [];
  const history: any[] = [];
  const outcome = await runTurn("implement it", history, {
    ...baseDeps, verify, autofixMax: 2, canEscalateOnFailure: true, log: (s) => logs.push(s), _callModel: async () => seq[n++],
  });
  check("(a) self-fix budget spent: verify ran autofixMax+1 (=3) times", verifyCalls === 3, `calls=${verifyCalls}`);
  check("(a) returns an escalate outcome", !!outcome.escalate);
  check("(a) escalate.report carries the verifier's final failure output", outcome.escalate?.report === REPORT, outcome.escalate?.report);
  check("(a) escalate.reason names the round budget", /still failing after 2 self-correction rounds/i.test(outcome.escalate?.reason ?? ""), outcome.escalate?.reason);
  check("(a) the self-fix loop DID feed failures back before escalating", history.some((m) => typeof m.content === "string" && m.content.includes("verification of your changes FAILED")));
  check("(a) surfaces the escalation notice, not the legacy 'leaving the changes' line", logs.some((s) => s.includes("escalating to fusion")) && !logs.some((s) => s.includes("leaving the changes")), logs.join(" | "));
}

// ── (b) checks pass → no escalation ──
{
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: true, report: "✓ ok" }; };
  const seq = [edit(), done("done")];
  let n = 0;
  const logs: string[] = [];
  const outcome = await runTurn("implement it", [], { ...baseDeps, verify, autofixMax: 2, canEscalateOnFailure: true, log: (s) => logs.push(s), _callModel: async () => seq[n++] });
  check("(b) a passing check does NOT escalate", !outcome.escalate);
  check("(b) verify ran once and reported green", verifyCalls === 1 && logs.some((s) => s.includes("verified — checks pass")), logs.join(" | "));
}

// ── (c) escalation OFF (cfg.escalation=false → canEscalateOnFailure false) → legacy 'leave the changes' ──
{
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: false, report: "✗ still broken" }; };
  const seq = editDonePairs(3);
  let n = 0;
  const logs: string[] = [];
  const outcome = await runTurn("implement it", [], { ...baseDeps, verify, autofixMax: 2, canEscalateOnFailure: false, log: (s) => logs.push(s), _callModel: async () => seq[n++] });
  check("(c) escalation OFF → no escalate even on verified failure", !outcome.escalate);
  check("(c) falls back to the legacy 'leaving the changes for you to review' message", logs.some((s) => s.includes("leaving the changes for you to review")) && !logs.some((s) => s.includes("escalating to fusion")), logs.join(" | "));
  check("(c) still exhausted the self-fix budget first (verify ran 3×)", verifyCalls === 3, `calls=${verifyCalls}`);
}

// ── (d) Plan mode: the mutating attempt is blocked, so nothing verifies and nothing escalates ──
{
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: false, report: "✗ broken" }; };
  const seq = [edit(), done("I can only plan in read-only mode")];
  let n = 0;
  const logs: string[] = [];
  const outcome = await runTurn("implement it", [], {
    ...baseDeps, cfg: { ...cfg, planMode: true }, verify, autofixMax: 2, canEscalateOnFailure: true, log: (s) => logs.push(s), _callModel: async () => seq[n++],
  });
  check("(d) Plan mode never escalates", !outcome.escalate);
  check("(d) the mutating tool was blocked (read-only), so verify never ran", verifyCalls === 0 && logs.some((s) => s.includes("Plan mode is read-only")), logs.join(" | "));
}

// ── (e) apply-turn override (canEscalateOnFailure:false) → NO re-escalation (one escalation per user turn) ──
{
  // An escalated Fusion's apply turn runs with canEscalateOnFailure:false. Even if ITS checks fail through
  // the whole budget, it must NOT escalate again — otherwise escalation could recurse. Same mechanics as (c),
  // asserted from the apply-turn contract's angle.
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: false, report: "✗ apply turn still failing" }; };
  const seq = editDonePairs(3);
  let n = 0;
  const logs: string[] = [];
  const outcome = await runTurn("apply the fusion result", [], { ...baseDeps, verify, autofixMax: 2, canEscalateOnFailure: false, log: (s) => logs.push(s), _callModel: async () => seq[n++] });
  check("(e) an apply turn (override false) never re-escalates → at most one escalation per user turn", !outcome.escalate);
  check("(e) apply turn still ran the full self-fix budget first (verify 3×)", verifyCalls === 3, `calls=${verifyCalls}`);
  check("(e) apply turn leaves the changes for review instead", logs.some((s) => s.includes("leaving the changes for you to review")), logs.join(" | "));
}

if (fail) { console.error("\n✗ escalation smoke FAILED"); process.exit(1); }
console.log("\n✓ escalation smoke passed (verified-failure escalate + report · pass→no-escalate · off→legacy · plan-mode blocked · apply-turn override caps at one escalation)");
process.exit(0);
