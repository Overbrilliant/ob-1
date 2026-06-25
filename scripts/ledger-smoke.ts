// Deterministic test for dual-ledger orchestration (PLAN-V2 #11). No API key — model calls injected.
// Covers the pure layer (progress/replan parsing, stall transition, replan trigger) and the runLedger
// loop: satisfied → stop; sustained no-progress → re-plan at the threshold, reset, and stop after
// exhausting replans; the deterministic loop backstop; and clean pass-through with no stall.
// Usage: bun run scripts/ledger-smoke.ts
import {
  parseProgress, parseReplan, nextStall, shouldReplan, runLedger,
  STALL_THRESHOLD, MAX_REPLANS, type TaskLedger,
} from "../src/multimind/ledger.ts";
import type { WorkerResult, WorkerEvent, runWorker } from "../src/multimind/runtime.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const cfg = {} as any;
const ledger0 = (): TaskLedger => ({ task: "build the thing", facts: ["it is a CLI"], guesses: ["uses bun"], plan: ["step A", "step B"] });

// ── pure layer ──
check("parseProgress reads camelCase + snake_case", (() => {
  const a = parseProgress('{"satisfied":true,"progress":true}');
  const b = parseProgress('{"is_request_satisfied":true,"is_progress_being_made":false,"is_in_loop":true}');
  return a.satisfied && a.progress && b.satisfied && !b.progress && b.inLoop;
})());
check("parseProgress fails closed (unparseable → no progress, not satisfied)", (() => { const p = parseProgress("garbage"); return !p.satisfied && !p.progress; })());
check("nextStall resets on real progress", nextStall(2, { satisfied: false, progress: true, inLoop: false, nextStep: "", nextAssignee: "" }) === 0);
check("nextStall increments on no-progress", nextStall(1, { satisfied: false, progress: false, inLoop: false, nextStep: "", nextAssignee: "" }) === 2);
check("nextStall increments when looping even if 'progress'", nextStall(0, { satisfied: false, progress: true, inLoop: true, nextStep: "", nextAssignee: "" }) === 1);
check(`shouldReplan trips at the threshold (${STALL_THRESHOLD})`, !shouldReplan(STALL_THRESHOLD - 1) && shouldReplan(STALL_THRESHOLD));
check("parseReplan revises the plan but keeps the task; falls back on junk", (() => {
  const r = parseReplan('{"plan":["new1","new2"],"facts":["learned X"]}', ledger0());
  const j = parseReplan("not json", ledger0());
  return r.task === "build the thing" && r.plan[0] === "new1" && r.facts[0] === "learned X" && j.plan[0] === "step A";
})());

// a fake worker that returns a unique line each round (so the loop backstop doesn't fire unless we want it)
const uniqueRun: typeof runWorker = (async (o: any): Promise<WorkerResult> => {
  o.onEvent?.({ label: o.label, phase: "start" } as WorkerEvent);
  return { label: o.label, text: `did ${o.label}`, inputTokens: 10, outputTokens: 5, ok: true };
}) as any;

// ── satisfied on round 2 → stops, no replan ──
{
  let r = 0;
  const out = await runLedger({
    ledger: ledger0(), cfg, tools: new Map(), _run: uniqueRun,
    _assess: async () => (++r >= 2 ? '{"satisfied":true}' : '{"progress":true}'),
    _replan: async () => "{}",
  });
  check("stops when the request is satisfied", out.satisfied && out.rounds === 2 && out.replans === 0);
}

// ── sustained no-progress → re-plans at the threshold, then gives up after MAX_REPLANS ──
{
  let events = 0; const evs: WorkerEvent[] = [];
  let replanCalls = 0;
  const out = await runLedger({
    ledger: ledger0(), cfg, tools: new Map(), _run: uniqueRun,
    onEvent: (e) => { events++; evs.push(e); },
    _assess: async () => '{"progress":false}',           // never makes progress
    _replan: async () => { replanCalls++; return '{"plan":["retry differently"]}'; },
  });
  check("re-planned exactly MAX_REPLANS times under sustained stall", out.replans === MAX_REPLANS && replanCalls === MAX_REPLANS, `${out.replans}`);
  check("gave up gracefully (stalledOut, not satisfied)", out.stalledOut && !out.satisfied);
  check("ran more rounds than one replan cycle (threshold × replans)", out.rounds >= STALL_THRESHOLD * MAX_REPLANS, `${out.rounds}`);
  check("emitted live worker events", events > 0);
}

// ── deterministic loop backstop: identical output flips inLoop even when the assessor claims progress ──
{
  const sameRun: typeof runWorker = (async (o: any): Promise<WorkerResult> => ({ label: o.label, text: "IDENTICAL", inputTokens: 1, outputTokens: 1, ok: true })) as any;
  const out = await runLedger({
    ledger: ledger0(), cfg, tools: new Map(), _run: sameRun,
    _assess: async () => '{"progress":true}',  // assessor LIES that progress is happening
    _replan: async () => '{"plan":["x"]}',
  });
  check("identical output is detected as a loop → still stalls out despite 'progress'", out.stalledOut, `replans=${out.replans}`);
}

// ── clean pass-through: progress every round until plan exhausts, no replan, hits round cap or finishes ──
{
  const out = await runLedger({
    ledger: ledger0(), cfg, tools: new Map(), maxRounds: 4, _run: uniqueRun,
    _assess: async () => '{"progress":true,"nextStep":"keep going"}', // always progressing, never satisfied
    _replan: async () => { throw new Error("replan should not be called when progressing"); },
  });
  check("never re-plans while progressing", out.replans === 0 && !out.stalledOut);
  check("respects the round cap", out.rounds === 4);
}

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
