// deep.ts — the `/deep` tier: AB-MCTS-lite adaptive search (multimind v2, Wave 5).
//
// Lineage: this is a deliberately small, single-file port of Sakana AI's Adaptive Branching Monte-Carlo
// Tree Search — specifically the AB-MCTS-A(Beta) variant (arXiv:2503.04412, "Wider or Deeper? Scaling
// LLM Inference-Time Compute with Adaptive Branching Tree Search"). The measured result there: for coding
// tasks a search that DECIDES, per step and grounded in the real execution signal, whether to WIDEN (draft
// a fresh solution) or DEEPEN (refine an existing promising one) beats both pure best-of-N (all width) and
// pure iterative-refinement (all depth). SWE-Search reports +23% relative on top of the same mechanism.
//
// What we keep from AB-MCTS-A and what we drop:
//   • KEEP — Thompson sampling over a set of "arms" as the width-vs-depth decision. Each arm has a Beta
//     posterior over its expected reward; we draw ONE sample per arm and PLAY the argmax. Thompson naturally
//     balances exploit (an arm with a strong track record) vs explore (an arm we've barely tried, whose wide
//     Beta(1,1) still occasionally samples high). This is exactly AB-MCTS-A's node-selection rule.
//   • KEEP — the reward is the REAL verifier signal (evaluate.ts fractional pass ratio), never an LLM's
//     self-assessment. Grounding is the whole point; an ungrounded tree search is just expensive vibes.
//   • DROP — the full MCTS backup/UCT machinery and the "GEN node" abstraction of the paper. We flatten the
//     tree to a set of arms recomputed each step (GEN-per-model + REFINE-per-live-node×model) and let the
//     posteriors carry all the state. ~200 lines instead of a framework (12-factor-agents / own-the-loop).
//
// The search core (sampleBeta / armPosterior / selectArm) is PURE and injectable (rng + runner) so it is
// deterministically unit-testable with no models or subprocesses — see deep.test.ts / deep-smoke.ts.
import { runWorker, readOnlyTools, type WorkerEvent } from "./runtime.ts";
import { createWorkspaceCopy, type Worktree } from "./worktree.ts";
import { detectSignal, evaluateInDir, ensembleModels, tail, type CandidateScore } from "./evaluate.ts";
import {
  scoreCandidate,
  extractCandidateFile,
  captureCopyDiff,
  CANDIDATE_SYSTEM,
  CANDIDATE_SYSTEM_COPY,
  type FusionSignalTier,
} from "./fusion.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";
import type { ProcRegistry } from "../agent/procs.ts";

/** One node in the search tree: a complete candidate solution and its objective verdict. `score` is the
 *  REWARD in [0,1] (a full pass is 1; partial credit from the parsed test pass-ratio otherwise). `parent`
 *  is set iff this node is a REFINE of another (undefined ⇒ a fresh GEN at the root). `text` is the worker's
 *  raw output (kept for apply — the fenced block lives in it); `code` is the extracted block (for refining). */
export interface DeepNode {
  id: number;
  code: string;
  text: string;
  diff?: string;
  score: number;
  ok: boolean;
  model: string;
  parent?: number;
}

/** The two action shapes Thompson sampling chooses between — AB-MCTS-A's width-vs-depth decision made
 *  concrete: WIDEN with a fresh generation from model `m`, or DEEPEN by refining node `node` with model `m`. */
export type Arm = { kind: "gen"; model: string } | { kind: "refine"; node: number; model: string };

/** Injected uniform-[0,1) source. Real runs use Math.random; tests pass a seeded PRNG or a constant so the
 *  whole search is reproducible (the sampler below is pure given this). */
export type Rng = () => number;

const SCORE_TIMEOUT_MS = 120_000; // bound a copy's checks so a hanging test can't freeze the search
const TOP_REFINE_NODES = 4; // cap live REFINE targets to the best few nodes so the arm set stays bounded
const DEFAULT_BUDGET = 9; // total worker calls; OB1_DEEP_BUDGET / opts.budget override

// ── Pure sampling core ─────────────────────────────────────────────────────────

// A single standard-normal deviate via Box–Muller from the injected uniform rng. We use only the cosine
// companion (the sine one is an equally-valid independent normal we simply discard) — this keeps the rng
// consumption per normal at exactly two draws, which matters for reproducibility. u1 is floored off zero so
// log(0) can't produce -Infinity.
function sampleNormal(rng: Rng): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Gamma(shape, 1) via Marsaglia–Tsang (2000), driven by the injected rng. Chosen over Jöhnk/rejection-Beta
// because it stays efficient and low-variance across the whole shape range we hit. NOTE: every posterior we
// sample has shape = 1 + Σ(reward) ≥ 1, so the shape<1 boost branch (still included for completeness) is
// never actually exercised by armPosterior — meaning no recursion and a stable rng-consumption profile. The
// accept/reject loop is bounded (it a.s. terminates in ~1–2 iterations; the cap only guarantees purity).
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) · U^(1/a) for a<1 (Marsaglia–Tsang §6). Never hit from armPosterior.
    const g = sampleGamma(shape + 1, rng);
    return g * Math.pow(Math.max(rng(), 1e-12), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i++) {
    const x = sampleNormal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    // The two standard squeeze/full acceptance tests. Either accepting returns d·v.
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // unreachable in practice; the distribution mode as a safe pure fallback
}

/** Draw one sample from Beta(alpha, beta) using the injected rng, via the standard two-Gamma construction
 *  Beta = Ga/(Ga+Gb) with Ga~Gamma(alpha), Gb~Gamma(beta). Pure (deterministic given rng) and always in
 *  [0,1]. This is the per-arm Thompson draw. */
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const ga = sampleGamma(alpha, rng);
  const gb = sampleGamma(beta, rng);
  const s = ga + gb;
  return s > 0 ? ga / s : 0.5; // degenerate only if both gammas underflowed to 0 → uninformative 0.5
}

/** The Beta posterior for an arm given the search history so far — the heart of AB-MCTS-A(Beta). Beta(1+Σr,
 *  1+Σ(1−r)) is the conjugate posterior of a Bernoulli/continuous-[0,1] reward under a uniform Beta(1,1)
 *  prior: every observed reward r adds r to the "success" pseudo-count and (1−r) to the "failure" one, so
 *  the posterior mean tracks the arm's average reward and its variance shrinks as evidence accrues.
 *
 *  Which rewards an arm "observes" is what encodes width-vs-depth:
 *   • GEN(model m) pools ALL fresh generations by m — its posterior is "how good is a from-scratch draft by
 *     this model", the WIDTH signal.
 *   • REFINE(node k) pools the rewards of every refinement OF node k (by any model) PLUS node k's own score
 *     as a single prior observation. Seeding with the node's own score is deliberate: a strong-but-imperfect
 *     node (say 0.8) starts with a high refine posterior and thus ATTRACTS depth before it has any children,
 *     while a weak node (0.1) does not — exactly AB-MCTS's "deepen the promising frontier" behavior. (The
 *     model dimension of a REFINE arm doesn't change the pooled rewards, so REFINE(k,·) arms share a
 *     posterior but draw INDEPENDENT Beta samples in selectArm — which is how a model gets chosen for the
 *     refinement: by sampling luck weighted toward none, i.e. uniform exploration over models for that node.) */
export function armPosterior(arm: Arm, history: DeepNode[]): { alpha: number; beta: number } {
  const rewards: number[] = [];
  if (arm.kind === "gen") {
    for (const n of history) if (n.parent === undefined && n.model === arm.model) rewards.push(n.score);
  } else {
    for (const n of history) if (n.parent === arm.node) rewards.push(n.score);
    const self = history.find((n) => n.id === arm.node);
    if (self) rewards.push(self.score); // the node's own score as one prior observation (attracts refinement)
  }
  let alpha = 1;
  let beta = 1;
  for (const r of rewards) {
    alpha += r;
    beta += 1 - r;
  }
  return { alpha, beta };
}

/** Thompson selection: draw ONE Beta sample per arm from its posterior and PLAY the argmax. Returns the
 *  chosen arm's INDEX. Ties break deterministically toward the earlier arm (strict `>` keeps the incumbent),
 *  so GEN arms (listed first) win a genuine tie — a sensible default when we have no reason to prefer depth.
 *  Pure given `rng`; the randomness that makes this EXPLORE lives entirely in the sampler. */
export function selectArm(arms: Arm[], history: DeepNode[], rng: Rng): number {
  let bestIdx = 0;
  let bestSample = -Infinity;
  for (let i = 0; i < arms.length; i++) {
    const { alpha, beta } = armPosterior(arms[i], history);
    const s = sampleBeta(alpha, beta, rng);
    if (s > bestSample) {
      bestSample = s;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

/** The REFINE prompt: the parent candidate verbatim + its reported failures + the improve instruction. This
 *  is what turns a node into a DEEPER node — the model sees exactly what was wrong and is told to fix it
 *  while preserving what already passed (execution-feedback, the #1 measured multi-agent gain). Pure so the
 *  exact wording is unit-testable. */
export function buildRefineTask(parentCode: string, failureOutput: string): string {
  const failures = failureOutput.trim()
    ? `It was evaluated and reported these failures:\n\n${failureOutput.trim()}\n\n`
    : "";
  return (
    `Here is a candidate solution:\n\n\`\`\`\n${parentCode}\n\`\`\`\n\n${failures}` +
    "Improve this candidate: fix the reported failures, keep what already passes. Output the COMPLETE " +
    "corrected solution as a single fenced code block (path on the fence info line if it targets a file)."
  );
}

/** One printable tree line: `#3 ← #1 · refine · <model> · 0.67` (GEN nodes omit the ` ← #parent`). Pure and
 *  exported so the UI (index.ts) and the smoke render identically. */
export function deepNodeLine(n: DeepNode): string {
  const rel = n.parent !== undefined ? `#${n.id} ← #${n.parent}` : `#${n.id}`;
  const action = n.parent !== undefined ? "refine" : "gen";
  return `${rel} · ${action} · ${n.model} · ${n.score.toFixed(2)}`;
}

// ── The search loop ─────────────────────────────────────────────────────────────

export interface DeepResult {
  nodes: DeepNode[];
  /** Highest-scoring node; ties resolve to the EARLIEST (smallest id). Undefined only if 0 calls ran. */
  best: DeepNode | undefined;
  tree: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  signalTier: FusionSignalTier;
}

const TIER_ORDER: FusionSignalTier[] = ["copy-checks", "worktree-tests", "check", "syntax", "none"];

/** Resolve the total worker-call budget: explicit opt ▸ OB1_DEEP_BUDGET ▸ default 9. Malformed env falls
 *  back rather than poisoning the loop bound with NaN. */
function resolveBudget(opt?: number): number {
  if (opt && opt > 0) return Math.floor(opt);
  const env = process.env.OB1_DEEP_BUDGET;
  const n = env ? Number(env) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BUDGET;
}

/** Run the AB-MCTS-lite search. Each iteration is ONE worker call: build the live arm set (GEN per model +
 *  REFINE per top-K live node × model), Thompson-select an arm, run the worker, score it against the real
 *  verifier signal, and record the node. Stops early the moment a node fully passes. `mkTools`+`procs` wire
 *  the same per-call throwaway workspace copy Fusion uses (full tools, graded on real final state);
 *  otherwise workers are read-only and the emitted block is graded by check/syntax (the eval / plan path).
 *  `_run`/`_rng` are the injectable seams for deterministic tests. */
export async function runDeep(opts: {
  task: string;
  cfg: Config;
  tools: Map<string, Tool>;
  budget?: number;
  models?: string[];
  check?: string; // objective $OB1_FILE check for the no-copy path (eval); the strongest tier without a copy
  escalationContext?: string;
  mkTools?: (cwd: string) => Map<string, Tool>;
  procs?: ProcRegistry;
  planMode?: boolean;
  onEvent?: (ev: WorkerEvent) => void;
  signal?: AbortSignal;
  _run?: typeof runWorker;
  _rng?: Rng;
}): Promise<DeepResult> {
  const cfg = opts.cfg;
  const baseRun = opts._run ?? runWorker;
  const rng = opts._rng ?? Math.random;
  let inTok = 0;
  let outTok = 0;
  // Wrap the runner to forward live progress + ESC and roll up tokens at the call site (the UI meter ticks
  // per `step` event; the caller must NOT re-add these totals — mirrors fusion.ts / reviewer.ts).
  const run: typeof runWorker = async (o) => {
    const w = await baseRun({ ...o, onEvent: opts.onEvent, signal: opts.signal });
    inTok += w.inputTokens;
    outTok += w.outputTokens;
    return w;
  };

  const models = opts.models?.length ? opts.models : ensembleModels(cfg);
  const modelSet = models.length ? models : [cfg.model]; // ensembleModels always returns ≥1, but be safe
  const budget = resolveBudget(opts.budget);
  const signal = detectSignal(cfg); // the strongest objective signal for THIS project (zero env vars)
  const useCopy = !!opts.mkTools && !opts.planMode; // full-tools writable copy per call, else read-only
  const roTools = readOnlyTools(opts.tools);

  // GEN task carries the escalation preamble (candidates FIX a prior failure rather than restart); REFINE
  // tasks don't — they already carry the parent's concrete failure output. (Spec: escalation → GEN only.)
  const genTask = opts.escalationContext
    ? `A previous single-agent attempt failed verification. Failure report:\n${opts.escalationContext}\nFix the failures; keep what already works.\n\n${opts.task}`
    : opts.task;

  const nodes: DeepNode[] = [];
  const failOutput = new Map<number, string>(); // node id → its bounded failure output (for the refine prompt)
  const usedTiers = new Set<FusionSignalTier>();

  const unscored: CandidateScore = { ok: false, exitCode: -1, output: "no code block produced", checked: false };

  /** Grade one worker result against the strongest available signal. Copy path: grade the copy's REAL final
   *  state (evaluateInDir), capturing its diff first (before tests add artifacts). No-copy path: grade the
   *  emitted block by the $OB1_FILE check or an in-process syntax check. */
  const scoreOne = async (
    text: string,
    copy: Worktree | undefined,
  ): Promise<{ score: CandidateScore; tier: FusionSignalTier }> => {
    const { code, lang } = extractCandidateFile(text);
    if (copy) {
      const diff = captureCopyDiff(cfg, copy.path);
      if (signal.tier !== "none") {
        const score = await evaluateInDir(copy.path, cfg, signal, { signal: opts.signal, timeoutMs: SCORE_TIMEOUT_MS });
        score.diff = diff;
        return { score, tier: "copy-checks" };
      }
      const score = code ? await scoreCandidate(code, { langHint: lang, check: opts.check, cwd: cfg.cwd }) : { ...unscored };
      score.diff = diff; // keep the real edit as context even when there was no project signal to grade it
      return { score, tier: opts.check ? "check" : "syntax" };
    }
    if (!code) return { score: { ...unscored }, tier: "none" };
    const score = await scoreCandidate(code, { langHint: lang, check: opts.check, cwd: cfg.cwd });
    return { score, tier: opts.check ? "check" : "syntax" };
  };

  for (let call = 0; call < budget; call++) {
    if (opts.signal?.aborted) break; // ESC honored BETWEEN calls → return whatever we have, cleanly

    // Rebuild the arm set each step (AB-MCTS re-decides width-vs-depth every iteration). GEN per model is
    // always available (widen at the root); REFINE arms exist per (top-K node × model) — capping to the
    // best few nodes keeps the arm set O(models·K) rather than O(models·nodes) as the tree grows.
    const liveNodes = [...nodes].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, TOP_REFINE_NODES);
    const arms: Arm[] = [
      ...modelSet.map((m): Arm => ({ kind: "gen", model: m })),
      ...liveNodes.flatMap((n) => modelSet.map((m): Arm => ({ kind: "refine", node: n.id, model: m }))),
    ];
    const arm = arms[selectArm(arms, nodes, rng)];
    const id = nodes.length + 1;
    const isGen = arm.kind === "gen";
    const parent = isGen ? undefined : nodes.find((n) => n.id === arm.node);
    const label = isGen ? `gen-${id}` : `refine-${id}`;
    const task = isGen ? genTask : buildRefineTask(parent?.code ?? "", failOutput.get(arm.node) ?? "");

    // Fresh throwaway workspace copy per call (git worktree at HEAD or a temp dir), or the read-only shared
    // cwd. Copy creation can fail (contended .git) → fall back to read-only for THIS call, don't abort.
    let copy: Worktree | undefined;
    if (useCopy) {
      try {
        copy = createWorkspaceCopy(cfg, label);
      } catch (e) {
        copy = undefined;
        opts.onEvent?.({ label, phase: "tool", tool: "(workspace copy failed — read-only fallback)", input: { error: (e as Error).message } });
      }
    }

    try {
      const w = await run({
        label,
        task,
        system: copy ? CANDIDATE_SYSTEM_COPY : CANDIDATE_SYSTEM,
        cfg: copy ? { ...cfg, cwd: copy.path } : cfg,
        tools: copy && opts.mkTools ? opts.mkTools(copy.path) : roTools,
        model: arm.model,
      });
      const { score, tier } = await scoreOne(w.text, copy);
      usedTiers.add(tier);
      const { code } = extractCandidateFile(w.text);
      const reward = score.ok ? 1 : score.score ?? 0; // fractional reward; unscored → 0 (no signal, no credit)
      const node: DeepNode = { id, code, text: w.text, diff: score.diff, score: reward, ok: !!(score.checked && score.ok), model: arm.model, parent: parent?.id };
      if (score.checked && !score.ok && score.output) failOutput.set(id, tail(score.output, 1500));
      nodes.push(node);
      // Early stop: a fully-passing node ends the search (the `break` still runs the finally → cleanup).
      if (node.ok && node.score >= 1) break;
    } finally {
      // Reap any background proc a worker left in its throwaway copy (kill-by-cwd) BEFORE removing the dir,
      // then delete the copy — a dev server started in a copy must never orphan or leak a checkout.
      if (copy) {
        opts.procs?.killByCwd(copy.path);
        copy.cleanup();
      }
    }
  }

  // best = highest score, ties → earliest. Iterating in id order and keeping the incumbent on `>=` yields
  // the earliest maximum.
  const best = nodes.reduce<DeepNode | undefined>((b, n) => (b && b.score >= n.score ? b : n), undefined);
  const signalTier = TIER_ORDER.find((t) => usedTiers.has(t)) ?? "none";
  return { nodes, best, tree: nodes.map(deepNodeLine), totalInputTokens: inTok, totalOutputTokens: outTok, signalTier };
}
