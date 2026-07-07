// Eval harness (Phase 7) — the R5 honesty gate: prove a mode beats Solo AT EQUAL TOKENS.
//
// runEval() runs every (task × mode × trial), extracts the candidate's code, and grades it with
// the task's objective check. computeMatched() then asks the only question that matters: is a
// multi-mind mode actually worth its tokens? It compares each mode's pass rate against **Solo@k**,
// where k = (mode's avg tokens) / (Solo's avg tokens) — i.e. how many independent Solo attempts
// the mode's budget would have bought. Solo@k uses the standard pass@k estimator
// 1 - (1 - p_solo)^k. A mode is only "justified" if it beats that compute-matched baseline; the
// research is blunt that much of multi-agent "gain" is just raw compute (R5), so default to Solo.
import { extractCode, scoreCandidate } from "../multimind/fusion.ts";
import type { EvalTask } from "./tasks.ts";

export interface RunOutput { text: string; inputTokens: number; outputTokens: number }
// A runner takes the task PROMPT (verbatim, as it always has) and OPTIONALLY the full EvalTask — so a mode
// that consults the per-task objective check (e.g. `escalate` deciding whether to escalate, or `fusion`
// grounding its selection) can read `task.check`. Existing prompt-only runners stay source-compatible: they
// simply ignore the second argument. The harness still grades every mode INDEPENDENTLY afterward, so a mode
// reading its own check can't grade itself green.
export type ModeRunner = (taskPrompt: string, task?: EvalTask) => Promise<RunOutput>;

export interface Outcome {
  taskId: string;
  mode: string;
  trial: number;
  pass: boolean;
  inputTokens: number;
  outputTokens: number;
  checked: boolean;   // false if the language/check couldn't be graded at all
}

export async function runEval(opts: {
  tasks: EvalTask[];
  runners: Record<string, ModeRunner>;
  cwd: string;
  trials?: number;
  onProgress?: (msg: string) => void;
}): Promise<Outcome[]> {
  const trials = Math.max(1, opts.trials ?? 1);
  const outcomes: Outcome[] = [];
  for (const task of opts.tasks) {
    for (const [mode, runner] of Object.entries(opts.runners)) {
      for (let t = 0; t < trials; t++) {
        let pass = false, checked = false, inTok = 0, outTok = 0;
        try {
          const out = await runner(task.prompt, task);
          inTok = out.inputTokens; outTok = out.outputTokens;
          const { code, lang } = extractCode(out.text);
          const score = await scoreCandidate(code, { langHint: lang ?? task.lang, check: task.check, cwd: opts.cwd });
          pass = score.ok && score.checked;
          checked = score.checked;
        } catch (e) {
          opts.onProgress?.(`${task.id} · ${mode} · trial ${t + 1}: error — ${(e as Error).message}`);
        }
        outcomes.push({ taskId: task.id, mode, trial: t, pass, inputTokens: inTok, outputTokens: outTok, checked });
        opts.onProgress?.(`${task.id} · ${mode} · trial ${t + 1}/${trials}: ${pass ? "PASS" : "FAIL"} (${inTok + outTok} tok)`);
      }
    }
  }
  return outcomes;
}

export interface ModeStats {
  mode: string;
  isBaseline: boolean;
  passRate: number;        // mean over tasks of the per-task pass fraction
  avgInputTokens: number;
  avgOutputTokens: number;
  avgTokens: number;
  k: number;               // token-match factor vs baseline (avgTokens_mode / avgTokens_baseline)
  soloAtK: number;         // compute-matched baseline pass rate (= passRate for the baseline itself)
  delta: number;           // passRate - soloAtK (advantage at equal tokens)
  justified: boolean | null; // null for the baseline row
}
export interface EvalReport { baseline: string; tasks: number; trials: number; modes: ModeStats[] }

/** The honesty computation. Pure — same outcomes always yield the same report. */
export function computeMatched(outcomes: Outcome[], opts?: { baseline?: string }): EvalReport {
  const baseline = opts?.baseline ?? "solo";
  const modes = [...new Set(outcomes.map((o) => o.mode))];
  const taskIds = [...new Set(outcomes.map((o) => o.taskId))];
  const trials = outcomes.length ? Math.max(...outcomes.map((o) => o.trial)) + 1 : 0;

  const agg = (mode: string, taskId: string) => {
    const rows = outcomes.filter((o) => o.mode === mode && o.taskId === taskId);
    const n = rows.length || 1;
    return {
      p: rows.filter((r) => r.pass).length / n,
      inTok: rows.reduce((a, r) => a + r.inputTokens, 0) / n,
      outTok: rows.reduce((a, r) => a + r.outputTokens, 0) / n,
      tok: rows.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0) / n,
    };
  };

  const basePerTask = Object.fromEntries(taskIds.map((t) => [t, agg(baseline, t)]));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

  const stats: ModeStats[] = modes.map((mode) => {
    const isBaseline = mode === baseline;
    const per = taskIds.map((t) => {
      const m = agg(mode, t);
      const s = basePerTask[t];
      const k = m.tok / Math.max(s.tok, 1);
      // pass@k estimator; cap the exponent so a huge k just saturates the baseline toward 1.
      const soloAtK = 1 - Math.pow(1 - s.p, Math.min(k, 1000));
      return { ...m, k, soloAtK };
    });
    const passRate = mean(per.map((x) => x.p));
    const soloAtK = mean(per.map((x) => x.soloAtK));
    return {
      mode,
      isBaseline,
      passRate,
      avgInputTokens: mean(per.map((x) => x.inTok)),
      avgOutputTokens: mean(per.map((x) => x.outTok)),
      avgTokens: mean(per.map((x) => x.tok)),
      k: mean(per.map((x) => x.k)),
      soloAtK: isBaseline ? passRate : soloAtK,
      delta: isBaseline ? 0 : passRate - soloAtK,
      justified: isBaseline ? null : passRate > soloAtK,
    };
  });

  // Baseline first, then most-capable modes by pass rate.
  stats.sort((a, b) => (a.isBaseline ? -1 : b.isBaseline ? 1 : b.passRate - a.passRate));
  return { baseline, tasks: taskIds.length, trials, modes: stats };
}

// ---- Capability frame: NOT compute-matched. The question is "does the mode SOLVE problems the
// baseline fails?" — raw capability on hard tasks, token cost explicitly not a gate.

export interface CapabilityStats {
  mode: string;
  isBaseline: boolean;
  rawPass: number;          // mean pass rate over ALL tasks
  hardPass: number;         // mean pass rate over HARD tasks (baseline pass-rate < threshold)
  baselineHardPass: number; // baseline's own pass rate on those hard tasks (reference)
  lift: number;             // hardPass − baselineHardPass: capability gained where the baseline struggles
  solvedHard: number;       // # hard tasks where the mode strictly out-passes the baseline (recoveries)
  fullyRecovered: number;   // # hard tasks the baseline NEVER solved (p=0) that the mode did (p>0)
  totalHard: number;
  avgTokens: number;        // informational only — not a gate in this frame
}
export interface CapabilityReport { baseline: string; tasks: number; hardTasks: number; trials: number; modes: CapabilityStats[] }

/** Capability/recovery report. `hardThreshold` (default 1) defines a "hard" task as one the baseline
 *  does not solve perfectly. Pure — same outcomes → same report. */
export function computeCapability(outcomes: Outcome[], opts?: { baseline?: string; hardThreshold?: number }): CapabilityReport {
  const baseline = opts?.baseline ?? "solo";
  const hardThreshold = opts?.hardThreshold ?? 1;
  const modes = [...new Set(outcomes.map((o) => o.mode))];
  const taskIds = [...new Set(outcomes.map((o) => o.taskId))];
  const trials = outcomes.length ? Math.max(...outcomes.map((o) => o.trial)) + 1 : 0;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
  const passRate = (mode: string, taskId: string) => {
    const rows = outcomes.filter((o) => o.mode === mode && o.taskId === taskId);
    return rows.length ? rows.filter((r) => r.pass).length / rows.length : 0;
  };
  const avgTokens = (mode: string) =>
    mean(taskIds.map((t) => {
      const rows = outcomes.filter((o) => o.mode === mode && o.taskId === t);
      return rows.length ? rows.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0) / rows.length : 0;
    }));

  const basePerTask = Object.fromEntries(taskIds.map((t) => [t, passRate(baseline, t)]));
  const hardIds = taskIds.filter((t) => basePerTask[t] < hardThreshold);

  const stats: CapabilityStats[] = modes.map((mode) => {
    const isBaseline = mode === baseline;
    const hardPass = mean(hardIds.map((t) => passRate(mode, t)));
    const baselineHardPass = mean(hardIds.map((t) => basePerTask[t]));
    return {
      mode,
      isBaseline,
      rawPass: mean(taskIds.map((t) => passRate(mode, t))),
      hardPass,
      baselineHardPass,
      lift: hardPass - baselineHardPass,
      solvedHard: hardIds.filter((t) => passRate(mode, t) > basePerTask[t]).length,
      fullyRecovered: hardIds.filter((t) => basePerTask[t] === 0 && passRate(mode, t) > 0).length,
      totalHard: hardIds.length,
      avgTokens: avgTokens(mode),
    };
  });

  // Baseline first, then by hard-task capability (then raw) — best recoverer on top.
  stats.sort((a, b) => (a.isBaseline ? -1 : b.isBaseline ? 1 : b.hardPass - a.hardPass || b.rawPass - a.rawPass));
  return { baseline, tasks: taskIds.length, hardTasks: hardIds.length, trials, modes: stats };
}
