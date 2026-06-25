// Deterministic test for Fusion (no API key). Covers auto-scoring/extraction AND the new
// best-of-N flow: all candidates get the SAME prompt, a single judge/synthesizer merges them,
// and F4 verify+revert falls back to a passing candidate when the synthesis breaks.
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

// --- runFusion end-to-end via injected runner, graded by the real sum-evens check ---
const sumTask = BUILTIN_TASKS.find((t) => t.id === "sum-evens")!;
const OK1 = "export function sumEvens(nums){let s=0;for(const n of nums)if(n%2===0)s+=n;return s}";
const OK2 = "export function sumEvens(nums){return nums.filter(n=>n%2===0).reduce((a,b)=>a+b,0)}";
const BADC = "export function sumEvens(){return 0}";
const block = (c: string) => "```ts\n" + c + "\n```";
const W = (label: string, text: string): WorkerResult => ({ label, text, inputTokens: 1, outputTokens: 1, ok: true });

// default N=3 candidates, all from the SAME prompt; synthesizer merges; synth passes → no revert
const seenSys: Record<string, string> = {};
let synthSawAll = false;
const f1 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), check: sumTask.check,
  _run: (async (o: { label: string; system: string; task: string }) => {
    if (o.label.startsWith("cand-")) { seenSys[o.label] = o.system; return W(o.label, block(o.label === "cand-1" ? OK1 : OK2)); }
    if (o.label === "synthesizer") { synthSawAll = o.task.includes("cand-1") && o.task.includes("cand-2") && o.task.includes("cand-3"); return W(o.label, block(OK1)); }
    return W(o.label, "?");
  }) as any,
});
check("F: 3 candidates by default", f1.candidates.length === 3);
check("F: all candidates share one prompt (no angles)", new Set(Object.values(seenSys)).size === 1 && Object.keys(seenSys).length === 3);
check("F: every candidate auto-scored", f1.candidates.every((c) => c.score?.checked));
check("F: judge sees ALL candidates", synthSawAll);
check("F: synth passes → not reverted", f1.reverted === false && f1.synthesisScore?.ok === true);
check("F: tokens accounted via wrapper", f1.totalInputTokens > 0 && f1.totalOutputTokens > 0);

// synth emits broken code but a candidate passed → F4 reverts to a passing candidate
const f2 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), check: sumTask.check,
  _run: (async (o: { label: string }) => {
    if (o.label === "cand-1") return W(o.label, block(OK1)); // passes
    if (o.label.startsWith("cand-")) return W(o.label, block(BADC)); // fail
    if (o.label === "synthesizer") return W(o.label, block(BADC)); // broken synthesis
    return W(o.label, "?");
  }) as any,
});
check("F: failed synth → reverted to a passing candidate", f2.reverted === true && f2.synthesis.includes("sumEvens"));
check("F: revert note present", f2.synthesis.includes("reverted to a passing candidate"));

// explicit N is honored
const f3 = await runFusion({
  task: "sum evens", cfg, tools: new Map(), n: 5, check: sumTask.check,
  _run: (async (o: { label: string }) => W(o.label, block(OK1))) as any,
});
check("F: explicit n=5 → 5 candidates", f3.candidates.length === 5);

if (fail) { console.error("\n✗ fusion smoke FAILED"); process.exit(1); }
console.log("\n✓ fusion smoke passed (extract/score + same-prompt best-of-N + merge synthesis + F4 verify-revert)");
