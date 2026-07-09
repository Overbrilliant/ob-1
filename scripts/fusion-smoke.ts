// Deterministic test for Fusion v2 (no API key). Covers auto-scoring/extraction AND the SELECTION-FIRST
// flow: all candidates get the SAME prompt, ≥1 passing → a winner is SELECTED verbatim (vote / smallest
// diff) with NO synthesizer call; 0 passing → the judge synthesizes a merge, re-scores it, and the result
// is flagged FAILING when the merge still fails. Also: the escalation-context preamble is prepended.
// Usage: bun run scripts/fusion-smoke.ts
import { extractCode, scoreCandidate, runFusion } from "../src/multimind/fusion.ts";
import { BUILTIN_TASKS } from "../src/eval/tasks.ts";
import { loadConfig } from "../src/config.ts";
import type { WorkerResult } from "../src/multimind/runtime.ts";

const cfg = loadConfig();
let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

// --- extraction + scoring ---
const { code, lang } = extractCode("Here:\n\n```ts\nexport const add = (a: number, b: number): number => a + b;\n```\nDone.");
check("extract lang+code", lang === "ts" && code.includes("add"));
const good = await scoreCandidate("export const add = (a: number, b: number) => a + b;", { langHint: "ts", cwd: process.cwd() });
const bad = await scoreCandidate("export const add = (a: number, b: number) => a +;", { langHint: "ts", cwd: process.cwd() });
check("good TS passes", good.ok && good.checked);
check("broken TS fails", !bad.ok && bad.checked);
const custom = await scoreCandidate("print('hi')", { langHint: "py", check: "grep -q hi \"$OB1_FILE\"", cwd: process.cwd() });
check("custom check passes", custom.ok);

// --- runFusion end-to-end via injected runner, graded by the real sum-evens $OB1_FILE check ---
const sumTask = BUILTIN_TASKS.find((t) => t.id === "sum-evens")!;
const OK1 = "export function sumEvens(nums){let s=0;for(const n of nums)if(n%2===0)s+=n;return s}";
const OK2 = "export function sumEvens(nums){return nums.filter(n=>n%2===0).reduce((a,b)=>a+b,0)}";
const BADC = "export function sumEvens(){return 0}";
const block = (c: string) => "```ts\n" + c + "\n```";
const W = (label: string, text: string): WorkerResult => ({ label, text, inputTokens: 1, outputTokens: 1, ok: true });

// SELECT by similarity vote: 2× OK1 + 1× OK2 → OK1 is the majority group; winner returned verbatim; NO judge/synth.
const seenSys: Record<string, string> = {};
const labels1: string[] = [];
const f1 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), check: sumTask.check,
  _run: (async (o: { label: string; system: string; task: string }) => {
    labels1.push(o.label);
    if (o.label.startsWith("cand-")) { seenSys[o.label] = o.system; return W(o.label, block(o.label === "cand-3" ? OK2 : OK1)); }
    return W(o.label, "?");
  }) as any,
});
check("F: 3 candidates by default", f1.candidates.length === 3);
check("F: all candidates share one prompt (no angles)", new Set(Object.values(seenSys)).size === 1 && Object.keys(seenSys).length === 3);
check("F: every candidate auto-scored", f1.candidates.every((c) => c.score?.checked));
check("F: majority selected by vote (verbatim, no merge)", f1.selected?.method === "vote" && f1.synthesis.includes("sumEvens") && !f1.reverted && !f1.failing);
check("F: winner verdict passes", f1.synthesisScore?.ok === true);
check("F: NO synthesizer/judge call on the passing path", !labels1.includes("synthesizer") && !labels1.includes("judge"));
check("F: signal tier reported (check)", f1.signalTier === "check");
check("F: tokens accounted via wrapper", f1.totalInputTokens > 0 && f1.totalOutputTokens > 0);

// SELECT by smallest diff: 2 distinct passing solutions, no majority → least-change wins ("diff" method).
const f2 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), n: 2, check: sumTask.check,
  _run: (async (o: { label: string }) => W(o.label, block(o.label === "cand-1" ? OK1 : OK2))) as any,
});
check("F: two distinct passing → smallest-diff selection", f2.selected?.method === "diff" && f2.synthesisScore?.ok === true && !f2.failing);

// FALLBACK synthesize: 0 candidates pass → judge merges; a passing merge → not reverted, not failing.
const labels3: string[] = [];
const f3 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), check: sumTask.check,
  _run: (async (o: { label: string }) => {
    labels3.push(o.label);
    if (o.label === "synthesizer") return W(o.label, block(OK1)); // merge fixes it
    return W(o.label, block(BADC)); // every candidate fails
  }) as any,
});
check("F: 0 passing → synthesizer runs (merge fallback)", labels3.includes("synthesizer") && f3.selected === undefined);
check("F: passing merge → not reverted, not failing", !f3.reverted && !f3.failing && f3.synthesis.includes("sumEvens"));

// FALLBACK failing: 0 pass AND the merge still fails → the result is flagged FAILING (never a silent pass).
const f4 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), check: sumTask.check,
  _run: (async (o: { label: string }) => W(o.label, block(BADC))) as any, // candidates AND merge fail
});
check("F: unfixable → FAILING flag set", f4.selected === undefined && f4.failing === true && f4.synthesisScore?.ok !== true);

// explicit N is honored, and identical passing candidates all vote into one group.
const f5 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), n: 5, check: sumTask.check,
  _run: (async (o: { label: string }) => W(o.label, block(OK1))) as any,
});
check("F: explicit n=5 → 5 candidates", f5.candidates.length === 5);
check("F: unanimous vote selects verbatim", f5.selected?.method === "vote" && !f5.failing);

// escalation context is prepended to every candidate's task (candidates FIX rather than restart).
let candTask = "";
await runFusion({
  task: "sum evens", cfg, tools: new Map(), n: 1, check: sumTask.check, escalationContext: "typecheck: TS2322 boom",
  _run: (async (o: { label: string; task: string }) => { if (o.label === "cand-1") candTask = o.task; return W(o.label, block(OK1)); }) as any,
});
check("F: escalationContext preamble prepended", /previous single-agent attempt failed verification/i.test(candTask) && candTask.includes("TS2322 boom") && candTask.includes("sum evens"));

// ALL-PROSE (conversational answer): candidates emit NO code block → UNSCORED (never syntax-FAILed), selected
// by AGREEMENT with no synthesizer/judge, tier "none", NOT failing, returned VERBATIM (no fence wrapped on).
const proseLabels: string[] = [];
const PROSE = "Hi! I'm doing well, thanks for asking.";
const fp = await runFusion({
  task: "how are you", cfg, tools: new Map(),
  _run: (async (o: { label: string }) => { proseLabels.push(o.label); return W(o.label, PROSE); }) as any,
});
check("F: prose candidates are UNSCORED (not syntax-FAILed)", fp.candidates.every((c) => c.score?.checked === false));
check("F: prose signal tier is none", fp.signalTier === "none");
check("F: prose selected by vote, verbatim, not failing", fp.selected?.method === "vote" && fp.synthesis === PROSE && fp.failing === false);
check("F: prose path spends NO synthesizer/judge call", !proseLabels.includes("synthesizer") && !proseLabels.includes("judge"));

if (fail) { console.error("\n✗ fusion smoke FAILED"); process.exit(1); }
console.log("\n✓ fusion smoke passed (extract/score + selection-first vote/diff + synthesize fallback + FAILING flag + escalation preamble + all-prose honesty)");
