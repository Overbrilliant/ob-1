// Bandit routing score — ported faithfully from the freellmapi-suite router's scoring.ts (pure math, no
// I/O, no SQLite). Every signal is normalized to [0,1] and combined as a CONVEX COMBINATION:
//
//   base      = w_rel·reliability + w_speed·speed + w_intel·intelligence   (weights sum to 1 ⇒ base ∈ [0,1])
//   effective = base × headroomFactor × rateLimitFactor
//
// headroomFactor pulls a model down as it nears its DAILY free quota (we use the daily rate-limit windows,
// NOT the display-only monthly budget string); rateLimitFactor demotes a model that is currently 429ing.
// Reliability is drawn from a Beta posterior (Thompson sampling) so exploration is automatic and
// proportional to uncertainty. Speed + intelligence are deterministic.

/** Convex weight vector over the three scored axes. */
export interface RoutingWeights {
  reliability: number;
  speed: number;
  intelligence: number;
}

/** priority = plain catalog order (intelligenceRank asc) with penalty demotion, no sampling; the rest are
 *  bandit presets. Each preset is just a weight vector — the engine is identical. */
export type RoutingStrategy = "priority" | "balanced" | "smartest" | "fastest" | "reliable";

/** All valid strategy ids (for settings validation + the keys/status surfaces). */
export const STRATEGIES: RoutingStrategy[] = ["priority", "balanced", "smartest", "fastest", "reliable"];

export const BANDIT_PRESETS: Record<Exclude<RoutingStrategy, "priority">, RoutingWeights> = {
  // Reliability leads; speed and intelligence split the rest evenly.
  balanced: { reliability: 0.5, speed: 0.25, intelligence: 0.25 },
  // Intelligence leads, but reliability still carries real weight so a smart model that keeps failing loses.
  smartest: { reliability: 0.35, speed: 0.1, intelligence: 0.55 },
  // Speed leads; reliability keeps a fast-but-broken model from winning.
  fastest: { reliability: 0.35, speed: 0.55, intelligence: 0.1 },
  // Reliability dominates — for callers that just want it to work.
  reliable: { reliability: 0.7, speed: 0.15, intelligence: 0.15 },
};

/** Default strategy — balanced (analytics-driven, on by default). */
export const DEFAULT_STRATEGY: RoutingStrategy = "balanced";

/** The weight vector for a strategy, or null for the non-scored `priority` order. */
export function weightsFor(strategy: RoutingStrategy): RoutingWeights | null {
  return strategy === "priority" ? null : BANDIT_PRESETS[strategy];
}

// ── Reliability (Beta posterior over decay-weighted pseudo-counts) ────────────
// Beta(1,1) prior = uniform: an unseen model is genuinely uncertain, not assumed good or bad.
export const PRIOR_SUCCESS = 1;
export const PRIOR_FAILURE = 1;

export function reliabilityPosterior(successes: number, failures: number): { alpha: number; beta: number } {
  return {
    alpha: Math.max(0, successes) + PRIOR_SUCCESS,
    beta: Math.max(0, failures) + PRIOR_FAILURE,
  };
}

/** Deterministic expected reliability — for a stable display score (not live routing). */
export function expectedReliability(successes: number, failures: number): number {
  const { alpha, beta } = reliabilityPosterior(successes, failures);
  return alpha / (alpha + beta);
}

// ── Speed (throughput + TTFB blended into one [0,1] axis) ────────────────────
export const SPEED_SCALE_TOK_S = 60; // tok/s at which throughput ≈ 0.63
export const TTFB_BEST_MS = 300; // ≤ this → full latency credit
export const TTFB_WORST_MS = 5000; // ≥ this → zero latency credit
const THROUGHPUT_WEIGHT = 0.6; // within the speed axis
const TTFB_WEIGHT = 0.4;
export const SPEED_PRIOR = 0.6; // optimistic prior so unmeasured models still get explored

function throughputScore(tokPerSec: number): number {
  if (tokPerSec <= 0) return 0;
  return 1 - Math.exp(-tokPerSec / SPEED_SCALE_TOK_S);
}

function ttfbScore(ttfbMs: number): number {
  if (ttfbMs <= TTFB_BEST_MS) return 1;
  if (ttfbMs >= TTFB_WORST_MS) return 0;
  return 1 - (ttfbMs - TTFB_BEST_MS) / (TTFB_WORST_MS - TTFB_BEST_MS);
}

/** Blend throughput + TTFB into a single [0,1] speed score. `tokPerSec <= 0` means no successful samples
 *  → the exploration prior; `ttfbMs === null` means throughput but no first-byte timing. */
export function speedScore(tokPerSec: number, ttfbMs: number | null): number {
  if (tokPerSec <= 0 && ttfbMs === null) return SPEED_PRIOR;
  const tp = throughputScore(tokPerSec);
  if (ttfbMs === null) return tp;
  if (tokPerSec <= 0) return ttfbScore(ttfbMs);
  return THROUGHPUT_WEIGHT * tp + TTFB_WEIGHT * ttfbScore(ttfbMs);
}

// ── Intelligence ──────────────────────────────────────────────────────────────
// size_label is the cross-provider capability tier (intelligence_rank is only meaningful within one
// provider), so tier dominates and intelligence_rank breaks ties inside a tier.
const TIER_VALUE: Record<string, number> = { Frontier: 4, Large: 3, Medium: 2, Small: 1 };

/** Composite intelligence: tier*1000 keeps tiers strictly separated; -rank prefers a lower rank in-tier. */
export function intelligenceComposite(sizeLabel: string, intelligenceRank: number): number {
  const tier = TIER_VALUE[sizeLabel] ?? 0;
  return tier * 1000 - intelligenceRank;
}

/** Min-max normalize a composite to [0,1], 1 = best. Single model / all-equal → neutral-high 1. */
export function intelligenceScore(composite: number, min: number, max: number): number {
  if (max <= min) return 1;
  return (composite - min) / (max - min);
}

// ── Guardrail: free-quota headroom (daily windows) ────────────────────────────
// Stays at 1 while a model has comfortable DAILY headroom and ramps to a floor as it approaches its cap,
// so we stop steering traffic at a model we're about to burn out. Unknown limit (null) → no opinion.
export const HEADROOM_FLOOR = 0.1;
export const HEADROOM_RAMP_START = 0.2; // start protecting at 20% remaining

function axisHeadroom(used: number, limit: number | null): number {
  if (limit == null || limit <= 0) return 1; // unknown cap → no opinion
  const remaining = Math.max(0, 1 - used / limit);
  if (remaining >= HEADROOM_RAMP_START) return 1;
  return HEADROOM_FLOOR + (1 - HEADROOM_FLOOR) * (remaining / HEADROOM_RAMP_START);
}

/** Daily-window headroom multiplier: the MIN of the request-per-day and token-per-day ramps (the tighter
 *  axis governs). Replaces the upstream monthly-budget headroom (monthlyTokenBudget is a display string). */
export function headroomFactor(dayReqs: number, rpd: number | null, dayTokens: number, tpd: number | null): number {
  return Math.min(axisHeadroom(dayReqs, rpd), axisHeadroom(dayTokens, tpd));
}

// ── Guardrail: live rate-limit penalty ────────────────────────────────────────
// Maps the 0..MAX_PENALTY 429 penalty to a multiplier. At max penalty a model keeps 40% of its score —
// demoted hard but never fully excluded, so it can recover once the penalty decays.
export const MAX_PENALTY = 10;
export const RATE_LIMIT_MAX_DAMP = 0.6;

export function rateLimitFactor(penalty: number): number {
  const p = Math.min(Math.max(0, penalty), MAX_PENALTY);
  return 1 - (p / MAX_PENALTY) * RATE_LIMIT_MAX_DAMP;
}

// ── Beta sampler (Marsaglia & Tsang via two Gamma draws) ──────────────────────
function randomNormal(): number {
  const u1 = Math.random() || Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random() || Number.EPSILON, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = randomNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Draw one sample from Beta(alpha, beta) ∈ (0,1). */
export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const sum = x + y;
  return sum > 0 ? x / sum : 0.5;
}

// ── The combined score ────────────────────────────────────────────────────────
export interface ScoreInputs {
  reliability: number; // [0,1] — sampled (routing) or expected (display)
  speed: number; // [0,1]
  intelligence: number; // [0,1]
  headroom: number; // [floor,1] multiplier
  rateLimit: number; // [floor,1] multiplier
}

/** Convex base (∈[0,1]) × the two guardrail multipliers. Weights are assumed to sum to 1; a non-normalized
 *  vector is renormalized so the base never escapes [0,1]. */
export function combineScore(inputs: ScoreInputs, weights: RoutingWeights): number {
  const wSum = weights.reliability + weights.speed + weights.intelligence || 1;
  const base =
    (weights.reliability * inputs.reliability +
      weights.speed * inputs.speed +
      weights.intelligence * inputs.intelligence) /
    wSum;
  return base * inputs.headroom * inputs.rateLimit;
}
