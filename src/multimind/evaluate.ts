// Auto verifier signal (multimind v2) — the policy layer that picks the STRONGEST objective signal for a
// coding task with ZERO env vars required, then runs it inside a candidate's isolated directory. This is
// the piece that makes Fusion selection grounded in REAL execution (research: test-execution ≫ judge ≫
// voting) instead of vibes, and it is the substrate the later verified-escalation/deep waves reuse.
//
// It deliberately REUSES agent/verify.ts (detectChecks/shellExec) — the same detection the Solo self-fix
// loop already trusts — rather than inventing a parallel notion of "the project's tests": a candidate is
// graded by exactly what the user's own toolchain already says. Pure detection + parsing + an injectable
// executor keep the whole module deterministically unit-testable (no spawning in tests).
import { detectChecks, shellExec } from "../agent/verify.ts";
import { splitModelKey } from "../providers/free/registry.ts";
import { getStats } from "../providers/free/state.ts";
import { listFreeModels } from "../providers/free/index.ts";
import type { Config } from "../config.ts";

/** The objective grading verdict for one candidate / artifact. `checked:false` ⇒ we could not grade it at
 *  all (no signal, or no code) — NEVER conflate that with a real FAIL. `score` is a fractional pass ratio
 *  in [0,1] (partial credit) when a runner exposed pass/fail counts; otherwise it mirrors ok (1 or 0). */
export interface CandidateScore {
  ok: boolean;
  exitCode: number;
  output: string;
  checked: boolean;
  /** Fractional pass ratio in [0,1] parsed from the test output; falls back to ok?1:0 when unparseable. */
  score?: number;
  /** Real-test scoring only: captured test output + the candidate's diff vs the baseline (for the judge). */
  testOutput?: string;
  diff?: string;
  targetPath?: string;
}

/** Detection strength for the auto signal: a real test suite beats fast compile gates beats nothing. */
export type SignalTier = "test" | "auto" | "none";
export interface Signal {
  tier: SignalTier;
  /** The project's test command (kind:"test"), or the OB1_FUSION_TEST_CMD override when set. */
  testCmd?: string;
  /** The fast, side-effect-free compile gates (typecheck / `cargo check` / `go build` / ruff / mypy). */
  autoCmds: string[];
}

/** Choose the strongest objective signal for the project rooted at cfg.cwd, with ZERO env vars required.
 *  OB1_FUSION_TEST_CMD is honored as an OVERRIDE (forces a "test" tier even where none was detected) — an
 *  env may refine the signal, but it is never required to obtain one. */
export function detectSignal(cfg: Config): Signal {
  const checks = detectChecks(cfg.cwd);
  const autoCmds = checks.filter((c) => c.auto).map((c) => c.command);
  const envTest = process.env.OB1_FUSION_TEST_CMD?.trim();
  const testCmd = envTest || checks.find((c) => c.kind === "test")?.command;
  const tier: SignalTier = testCmd ? "test" : autoCmds.length ? "auto" : "none";
  return { tier, testCmd, autoCmds };
}

/** Bounded TAIL of check output — the last ~maxChars, so a failure report keeps the ERROR (which a runner
 *  prints last) instead of a truncated head of setup noise. */
export function tail(s: string, maxChars = 2000): string {
  return s.length <= maxChars ? s : s.slice(s.length - maxChars);
}

export type ExecInDir = typeof shellExec;

/** Run the detected signal's commands INSIDE `dir` (a candidate's writable workspace copy/worktree),
 *  sandbox-wrapped and ESC-killable via shellExec (the SAME executor the main loop uses — not a duplicate).
 *  Compile gates run first (cheap, fail fast); the test command last. score.ok = every command exited 0;
 *  on failure the fractional `score` is the parsed pass ratio when the test output exposed counts (a
 *  candidate passing 4/5 tests is genuinely better than one passing 0/5). `_exec` is the injectable seam. */
export async function evaluateInDir(
  dir: string,
  cfg: Config,
  signal: Signal,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  _exec: ExecInDir = shellExec,
): Promise<CandidateScore> {
  const cmds = [...signal.autoCmds, ...(signal.testCmd ? [signal.testCmd] : [])];
  if (!cmds.length) return { ok: false, exitCode: -1, output: "no objective signal detected", checked: false };
  let testOutput: string | undefined;
  for (const command of cmds) {
    const { code, output } = await _exec({ cwd: dir, sandbox: cfg.sandbox, command, timeoutMs: opts.timeoutMs, signal: opts.signal });
    if (command === signal.testCmd) testOutput = output;
    if (code !== 0) {
      const frac = testOutput ? parsePassFraction(testOutput) : undefined;
      return { ok: false, exitCode: code, output: tail(output, 2000) || "(no output)", checked: true, score: frac ?? 0, testOutput };
    }
  }
  return { ok: true, exitCode: 0, output: "all checks passed", checked: true, score: 1, testOutput };
}

/** Best-effort fractional pass ratio in [0,1] from a test runner's output. Parses the common shapes:
 *  bun `N pass` / `M fail`, vitest/jest `Tests: X failed, Y passed`, pytest `X failed, Y passed`, cargo
 *  `test result: … Y passed; X failed`. Go's `ok`/`FAIL` exposes no counts → returns undefined (caller →
 *  ok?1:0). Counts are SUMMED across matches so multi-crate/multi-file runs aggregate correctly. */
export function parsePassFraction(output: string): number | undefined {
  const sum = (re: RegExp): number => {
    const g = new RegExp(re.source, "gi");
    let total = Number.NaN;
    let m: RegExpExecArray | null;
    while ((m = g.exec(output))) total = (Number.isNaN(total) ? 0 : total) + Number(m[1]);
    return total;
  };
  const ratio = (p: number, f: number): number | undefined => {
    const pp = Number.isNaN(p) ? 0 : p;
    const ff = Number.isNaN(f) ? 0 : f;
    return pp + ff > 0 ? pp / (pp + ff) : undefined;
  };
  // jest / vitest / pytest / cargo all print "<N> passed" / "<N> failed" (the "-ed" word).
  const worded = ratio(sum(/(\d+)\s+passed\b/), sum(/(\d+)\s+failed\b/));
  if (worded !== undefined) return worded;
  // bun test prints "<N> pass" / "<N> fail" (no "-ed"); `\b` keeps this from matching "passed"/"failed".
  return ratio(sum(/(\d+)\s+pass\b/), sum(/(\d+)\s+fail\b/));
}

// ── Ensemble diversity gate ─────────────────────────────────────────────────────

/** One frontier-candidate model's inputs to the PURE ranker — kept as plain data so tests inject fakes
 *  without touching live free-router state (registry/state APIs aren't injectable). */
export interface FrontierModel {
  id: string; // "platform/modelId" pin (what a worker passes as its model)
  displayName: string;
  available: boolean; // healthy + within rate windows right now (from listFreeModels)
  sizeLabel: string; // Frontier | Large | Medium | Small
  intelligenceRank: number; // 1 = smartest (catalog prior)
  succ: number; // bandit success pseudo-count
  fail: number; // bandit failure pseudo-count
}

/** Bandit-weighted rank for a frontier model: the LEARNED reliability posterior (Beta(1,1) mean) dominates,
 *  with the catalog intelligence rank as the prior tiebreak (every model starts at 0.5 with no data). */
function frontierRank(m: FrontierModel): number {
  const reliability = (m.succ + 1) / (m.succ + m.fail + 2);
  return reliability * 1000 - m.intelligenceRank;
}

/** PURE diversity ranker: keep only healthy Frontier-tier models, dedupe by model (two providers serving
 *  the SAME weights aren't "diverse"), and order best-first. Returns the distinct pins; the caller decides
 *  how many to take and whether ≥2 clears the diversity gate. Extracted from ensembleModels so it is
 *  unit-testable with fake registry inputs. */
export function rankFrontierModels(models: FrontierModel[]): string[] {
  const eligible = models.filter((m) => m.available && /frontier/i.test(m.sizeLabel));
  const best = new Map<string, FrontierModel>(); // key: normalized display name → the best-ranked instance
  for (const m of eligible) {
    const key = m.displayName.trim().toLowerCase();
    const cur = best.get(key);
    if (!cur || frontierRank(m) > frontierRank(cur)) best.set(key, m);
  }
  return [...best.values()]
    .sort((a, b) => frontierRank(b) - frontierRank(a) || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

/** The diversity gate (multimind v2) — which model(s) an ensemble should sample:
 *  1. OB1_FUSION_MODELS set → use it VERBATIM (explicit user intent, any provider).
 *  2. the free router → up to 3 DISTINCT healthy Frontier models (bandit/health-ranked); fewer than 2
 *     available ⇒ fall back to the single active model. Model diversity only helps among frontier-comparable
 *     models with a real selector; a weak member POISONS selection (Self-MoA), so Medium/Small are NEVER
 *     eligible.
 *  3. any other provider → [cfg.model] (same-model N-sampling is the correct design here, not a fallback). */
export function ensembleModels(cfg: Config): string[] {
  const override = (process.env.OB1_FUSION_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (override.length) return override;
  if (cfg.provider === "free") {
    const ranked = rankFrontierModels(freeFrontierInputs());
    if (ranked.length >= 2) return ranked.slice(0, 3);
    return [cfg.model];
  }
  return [cfg.model];
}

/** Read the LIVE free-router catalog + bandit state into the pure ranker's input shape. Kept separate from
 *  rankFrontierModels so the ranker stays pure/injectable. */
function freeFrontierInputs(): FrontierModel[] {
  return listFreeModels().map((m) => {
    const split = splitModelKey(m.id);
    const stats = split ? getStats(split.platform, split.modelId) : undefined;
    return {
      id: m.id,
      displayName: m.displayName,
      available: m.available,
      sizeLabel: m.sizeLabel,
      intelligenceRank: m.intelligenceRank,
      succ: stats?.succ ?? 0,
      fail: stats?.fail ?? 0,
    };
  });
}
