// Deterministic test for the eval harness (no API key needed). Verifies (a) the built-in task
// checks really discriminate correct vs wrong code through the REAL objective grader, and (b) the
// compute-matched math (Solo@k via the pass@k estimator) on hand-computed values via fake runners.
// Usage: bun run scripts/eval-smoke.ts
import { BUILTIN_TASKS, loadTasks } from "../src/eval/tasks.ts";
import { runEval, computeMatched, computeCapability, type ModeRunner, type Outcome } from "../src/eval/harness.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const cwd = process.cwd();
const SUM = BUILTIN_TASKS.find((t) => t.id === "sum-evens")!;
const SLUG = BUILTIN_TASKS.find((t) => t.id === "slugify")!;

// Candidate code strings (graded by the REAL check, not by the test).
const SUM_OK = "```ts\nexport function sumEvens(nums){let s=0;for(const n of nums)if(n%2===0)s+=n;return s}\n```";
const SUM_BAD = "```ts\nexport function sumEvens(){return 0}\n```";
const SLUG_OK = '```ts\nexport function slugify(s){return s.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")}\n```';
const SLUG_BAD = "```ts\nexport function slugify(s){return s.toLowerCase()}\n```";

const fixed = (text: string, inTok: number, outTok: number): ModeRunner => async () => ({ text, inputTokens: inTok, outputTokens: outTok });

// --- (a) the checks discriminate, end-to-end through runEval + scoreCandidate ---
const disc = await runEval({
  tasks: [SUM, SLUG],
  cwd,
  runners: { good: fixed(SUM_OK, 1, 1), bad: fixed(SUM_BAD, 1, 1) }, // 'good' only correct for sum-evens
});
const sumGood = disc.find((o) => o.taskId === "sum-evens" && o.mode === "good")!;
const sumBad = disc.find((o) => o.taskId === "sum-evens" && o.mode === "bad")!;
check("sum-evens: correct code PASSES the real check", sumGood.pass === true && sumGood.checked === true);
check("sum-evens: wrong code FAILS the real check", sumBad.pass === false);

const slugDisc = await runEval({ tasks: [SLUG], cwd, runners: { good: fixed(SLUG_OK, 1, 1), bad: fixed(SLUG_BAD, 1, 1) } });
check("slugify: correct code PASSES", slugDisc.find((o) => o.mode === "good")!.pass === true);
check("slugify: wrong code FAILS", slugDisc.find((o) => o.mode === "bad")!.pass === false);

// --- (b) compute-matched math, 1 task × 3 modes × 2 trials, outcomes scripted to known rates ---
// solo: ok,bad -> 0.5 @ 100 tok | fusion: ok,ok -> 1.0 @ 300 tok | council: bad,ok -> 0.5 @ 600 tok
function scripted(seq: Array<"ok" | "bad">, inTok: number, outTok: number): ModeRunner {
  let i = 0;
  return async () => ({ text: seq[i++ % seq.length] === "ok" ? SUM_OK : SUM_BAD, inputTokens: inTok, outputTokens: outTok });
}
const outcomes = await runEval({
  tasks: [SUM], cwd, trials: 2,
  runners: { solo: scripted(["ok", "bad"], 50, 50), fusion: scripted(["ok", "ok"], 150, 150), council: scripted(["bad", "ok"], 300, 300) },
});
check("runEval: 1 task × 3 modes × 2 trials = 6 outcomes", outcomes.length === 6);
check("real grading: solo passed exactly 1 of 2 trials", outcomes.filter((o) => o.mode === "solo" && o.pass).length === 1);

const rep = computeMatched(outcomes, { baseline: "solo" });
const get = (m: string) => rep.modes.find((s) => s.mode === m)!;
const solo = get("solo"), fusion = get("fusion"), council = get("council");

check("solo: pass 0.5, avg 100 tok, baseline", near(solo.passRate, 0.5) && near(solo.avgTokens, 100) && solo.isBaseline && solo.justified === null);
// fusion: k=300/100=3, solo@k=1-(1-0.5)^3=0.875, pass 1.0 > 0.875 -> justified
check("fusion: k=3, solo@k=0.875, JUSTIFIED", near(fusion.k, 3) && near(fusion.soloAtK, 0.875) && fusion.passRate === 1 && fusion.justified === true);
check("fusion: delta = +0.125", near(fusion.delta, 0.125));
// council: k=600/100=6, solo@k=1-0.5^6=0.984375, pass 0.5 < that -> NOT justified
check("council: k=6, solo@k=0.984375, NOT justified", near(council.k, 6) && near(council.soloAtK, 0.984375) && council.justified === false);

check("report: baseline solo listed first", rep.modes[0].mode === "solo");
check("loadTasks includes the built-ins", loadTasks(cwd).some((t) => t.id === "sum-evens"));

// --- (c) capability/recovery math: task A easy (Solo aces), task B hard (Solo fails, mode recovers) ---
const mk = (taskId: string, mode: string, pass: boolean): Outcome => ({ taskId, mode, trial: 0, pass, inputTokens: 10, outputTokens: 10, checked: true });
const capOc: Outcome[] = [
  mk("A", "solo", true), mk("A", "fusion", true),   // easy task: both pass
  mk("B", "solo", false), mk("B", "fusion", true),  // hard task: Solo fails, fusion recovers
];
const cap = computeCapability(capOc, { baseline: "solo" });
const cf = cap.modes.find((m) => m.mode === "fusion")!;
const cs = cap.modes.find((m) => m.mode === "solo")!;
check("cap: exactly 1 hard task (B)", cap.hardTasks === 1);
check("cap: fusion recovers Solo's failure", near(cf.hardPass, 1) && near(cf.lift, 1) && cf.solvedHard === 1 && cf.fullyRecovered === 1);
check("cap: solo hardPass 0, no recovery", near(cs.hardPass, 0) && cs.solvedHard === 0);
check("cap: raw pass — fusion 100%, solo 50%", near(cf.rawPass, 1) && near(cs.rawPass, 0.5));
check("cap: best recoverer sorts above baseline", cap.modes[0].mode === "solo" && cap.modes[1].mode === "fusion");

if (fail) { console.error("\n✗ eval smoke FAILED"); process.exit(1); }
console.log("\n✓ eval smoke passed (objective checks + Solo@k math + capability/recovery math)");
