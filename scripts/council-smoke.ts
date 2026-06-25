// Deterministic test for Council (no API key needed). Verifies the verdict parsers and the full
// author→review→revise→finalizer control flow via an injected fake runner (early-stop, round cap,
// two-model routing, objective grounding, distinct arbiter, accept/revise, live progress).
// Usage: bun run scripts/council-smoke.ts
import { parseBlocking, parseAccepted, runCouncil } from "../src/multimind/council.ts";
import type { WorkerResult, WorkerEvent } from "../src/multimind/runtime.ts";
import { BUILTIN_TASKS } from "../src/eval/tasks.ts";
import { loadConfig } from "../src/config.ts";

const cfg = loadConfig();
let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

// --- verdict parsers ---
check("parseBlocking BLOCK", parseBlocking("issue here\nVERDICT: BLOCK") === true);
check("parseBlocking OK", parseBlocking("looks fine\nVERDICT: OK") === false);
check("parseBlocking last-wins", parseBlocking("VERDICT: BLOCK\n...later...\nVERDICT: OK") === false);
check("parseBlocking absent⇒non-blocking", parseBlocking("no verdict line at all") === false);
check("parseAccepted ACCEPT", parseAccepted("ship it\nVERDICT: ACCEPT") === true);
check("parseAccepted REVISE", parseAccepted("not yet\nVERDICT: REVISE") === false);
check("parseAccepted absent⇒accept", parseAccepted("no marker") === true);

/** Build a fake worker runner scripted by label; `reviewerVerdict(round)` drives BLOCK/OK. */
function fakeRunner(opts: { reviewerVerdict: (round: number) => "BLOCK" | "OK"; arbiter: "ACCEPT" | "REVISE" }) {
  return async (o: { label: string }): Promise<WorkerResult> => {
    const base = { label: o.label, inputTokens: 2, outputTokens: 3, ok: true };
    if (o.label === "author") return { ...base, text: "DRAFT\n```ts\nexport const x = 1;\n```" };
    if (o.label.startsWith("reviewer:")) {
      const round = Number(o.label.split(":r")[1] ?? "1");
      return { ...base, text: `review of round ${round}\nVERDICT: ${opts.reviewerVerdict(round)}` };
    }
    if (o.label.startsWith("reviser:")) return { ...base, text: "REVISED\n```ts\nexport const x = 2;\n```" };
    if (o.label === "arbiter") return { ...base, text: `final answer here\nrationale.\nVERDICT: ${opts.arbiter}` };
    return { ...base, text: "?" };
  };
}

// --- Scenario A: block round 1, OK round 2 → 2 rounds, one revision, accepted ---
const a = await runCouncil({
  task: "do the thing", cfg, tools: new Map(), rounds: 2,
  _run: fakeRunner({ reviewerVerdict: (r) => (r === 1 ? "BLOCK" : "OK"), arbiter: "ACCEPT" }) as any,
});
check("A: two rounds", a.rounds.length === 2);
check("A: round1 blocked + revised", a.rounds[0].blocking === true && a.rounds[0].revisedThisRound === true);
check("A: round2 clean, no revision", a.rounds[1].blocking === false && a.rounds[1].revisedThisRound === false);
check("A: arbiter accepted", a.accepted === true && a.final.includes("final answer"));
check("A: token accounting", a.totalInputTokens > 0 && a.totalOutputTokens > 0);

// --- Scenario B: OK in round 1 → early stop, no revision, finalizer still runs ---
const b = await runCouncil({
  task: "trivial", cfg, tools: new Map(), rounds: 3,
  _run: fakeRunner({ reviewerVerdict: () => "OK", arbiter: "ACCEPT" }) as any,
});
check("B: early-stop at 1 round", b.rounds.length === 1);
check("B: no revision happened", b.rounds[0].revisedThisRound === false && b.rounds[0].revised === b.rounds[0].draft);
check("B: finalizer still ran", b.final.includes("final answer") && b.accepted === true);

// --- Scenario C: always-block hits the round cap, arbiter returns REVISE ---
const cRes = await runCouncil({
  task: "hard", cfg, tools: new Map(), rounds: 2,
  _run: fakeRunner({ reviewerVerdict: () => "BLOCK", arbiter: "REVISE" }) as any,
});
check("C: capped at maxRounds", cRes.rounds.length === 2);
check("C: every round revised", cRes.rounds.every((r) => r.revisedThisRound === true));
check("C: arbiter REVISE surfaced", cRes.accepted === false);

// --- Scenario D: two-model routing — author/reviser on models[0], reviewer on models[1]; arbiter default ---
const seen: Record<string, string | undefined> = {};
const capRun = async (o: { label: string; model?: string }): Promise<WorkerResult> => {
  seen[o.label] = o.model;
  const base = { label: o.label, inputTokens: 1, outputTokens: 1, ok: true };
  if (o.label.startsWith("reviewer:")) return { ...base, text: "issue\nVERDICT: BLOCK" }; // force a revise
  if (o.label === "arbiter") return { ...base, text: "final\nVERDICT: ACCEPT" };
  return { ...base, text: "```ts\nx\n```" };
};
await runCouncil({ task: "t", cfg, tools: new Map(), rounds: 1, models: ["m1", "m2"], _run: capRun as any });
check("D: author + reviser on first model", seen["author"] === "m1" && seen["reviser:r1"] === "m1");
check("D: reviewer on second model", seen["reviewer:r1"] === "m2");
check("D: arbiter stays on default model", seen["arbiter"] === undefined);

// --- Scenario E: objective grounding — reviewer + arbiter see the draft's real check verdict ---
const sumTask = BUILTIN_TASKS.find((t) => t.id === "sum-evens")!;
const seenTask: Record<string, string> = {};
const groundRun = async (o: { label: string; task: string }): Promise<WorkerResult> => {
  seenTask[o.label] = o.task;
  const base = { label: o.label, inputTokens: 1, outputTokens: 1, ok: true };
  if (o.label === "author") return { ...base, text: "```ts\nexport function sumEvens(){return 0}\n```" }; // FAILs the check
  if (o.label.startsWith("reviewer:")) return { ...base, text: "noted\nVERDICT: OK" };
  return { ...base, text: "final\nVERDICT: ACCEPT" };
};
await runCouncil({ task: "sum evens", cfg, tools: new Map(), rounds: 1, check: sumTask.check, _run: groundRun as any });
check("E: reviewer sees objective check FAIL", /OBJECTIVE check of this draft reports \*\*FAIL\*\*/.test(seenTask["reviewer:r1"] ?? ""));
check("E: arbiter is objective-grounded too", /OBJECTIVE check/.test(seenTask["arbiter"] ?? ""));

// --- Scenario F: distinct arbiter model; author stays default ---
const amSeen: Record<string, string | undefined> = {};
const amRun = async (o: { label: string; model?: string }): Promise<WorkerResult> => {
  amSeen[o.label] = o.model;
  const base = { label: o.label, inputTokens: 1, outputTokens: 1, ok: true };
  return { ...base, text: o.label.startsWith("reviewer:") ? "ok\nVERDICT: OK" : "x\nVERDICT: ACCEPT" };
};
await runCouncil({ task: "t", cfg, tools: new Map(), rounds: 1, arbiterModel: "arb-x", _run: amRun as any });
check("F: arbiter uses distinct model", amSeen["arbiter"] === "arb-x" && amSeen["author"] === undefined);

// --- Scenario G: onEvent live-progress is forwarded to EVERY worker (author + reviewer + reviser + arbiter) ---
const gEvents: WorkerEvent[] = [];
const emittingRun = async (o: { label: string; onEvent?: (e: WorkerEvent) => void }): Promise<WorkerResult> => {
  o.onEvent?.({ label: o.label, phase: "start" });               // simulate runWorker's own emission
  const r: WorkerResult = { label: o.label, text: o.label.startsWith("reviewer:") ? "issue\nVERDICT: BLOCK" : "final\nVERDICT: ACCEPT", inputTokens: 5, outputTokens: 7, ok: true };
  o.onEvent?.({ label: o.label, phase: "done", inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: r.ok });
  return r;
};
await runCouncil({ task: "t", cfg, tools: new Map(), rounds: 1, _run: emittingRun as any, onEvent: (e) => gEvents.push(e) });
const sawStartDone = (label: string) =>
  gEvents.some((e) => e.label === label && e.phase === "start") && gEvents.some((e) => e.label === label && e.phase === "done");
check("G: onEvent forwarded to author + reviewer + reviser + arbiter",
  ["author", "reviewer:r1", "reviser:r1", "arbiter"].every(sawStartDone));
const gDones = gEvents.filter((e) => e.phase === "done");
check("G: done events carry per-worker token totals",
  gDones.length === 4 && gDones.every((e) => (e as any).inputTokens === 5 && (e as any).outputTokens === 7)); // 4 = author+reviewer+reviser+arbiter

if (fail) { console.error("\n✗ council smoke FAILED"); process.exit(1); }
console.log("\n✓ council smoke passed (verdict parsers + author→review→revise→finalizer flow + two-model routing + grounding + live progress)");
