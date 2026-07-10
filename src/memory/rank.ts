// Weighted memory retrieval — PLAN-V2 item #5.
//
// Until now top-k retrieval ranked by cosine RELEVANCE alone. The Stanford "Generative Agents"
// retrieval function (the reference design, verified against Park et al. 2023 §4) ranks by a weighted
// sum of three signals, each MIN-MAX normalized to [0,1] ACROSS THE CANDIDATE SET:
//   • relevance — semantic similarity to the query (cosine);
//   • recency   — exponential decay on the memory's age (recent facts surface first);
//   • importance— a 1–10 salience score per fact (set at write time by the evolution pass, item #4;
//                 legacy/un-scored facts default to a mid value, so ranking always has a number).
// score = w_rel·relevance' + w_rec·recency' + w_imp·importance'   (primes = min-max normalized).
//
// Min-max-per-set is what the paper does and it's what keeps the weighted sum meaningful — a flat
// (cos+1)/2 map compresses real cosines into a narrow band and kills discrimination (web-research
// finding). Because each min-max is monotonic in its raw signal, weights (1,0,0) still reduce EXACTLY
// to cosine order — the back-compat guarantee the smoke pins.
// Pure (caller passes `now`) so ranking is deterministically testable.
// Source: Park et al. 2023, "Generative Agents" §4 (arxiv 2304.03442).

export interface RankWeights { relevance: number; recency: number; importance: number; }

// Relevance-led defaults (web-research recommendation for a *coding/task* agent, vs the paper's social
// sim which used equal 1/1/1): cosine dominates; recency and importance are tie-breakers. Override
// per-session via OB1_MEM_WEIGHTS="rel,rec,imp" (e.g. "1,1,1" for the paper's equal weighting).
export const DEFAULT_WEIGHTS: RankWeights = { relevance: 1, recency: 0.5, importance: 0.3 };

// Recency half-life: the recency signal halves every N days of age. The paper's 0.995/hour decay is a
// ~5.75-day half-life tuned to compressed "game hours"; 7d suits a coding agent's real-time facts
// (this week's decisions outrank last month's) without erasing older context.
export const RECENCY_HALFLIFE_DAYS = 7;
export const DEFAULT_IMPORTANCE = 5; // mid of the 1–10 scale, for facts the evolution pass never scored
const DAY_MS = 86_400_000;

/** Parse OB1_MEM_WEIGHTS="rel,rec,imp" (any missing/negative/NaN field falls back to the default). */
export function parseWeights(env: string | undefined): RankWeights {
  if (!env) return { ...DEFAULT_WEIGHTS };
  const p = env.split(",").map((s) => (s.trim() === "" ? NaN : Number(s.trim()))); // empty field → default
  const pick = (i: number, d: number) => (Number.isFinite(p[i]) && p[i] >= 0 ? p[i] : d);
  return { relevance: pick(0, DEFAULT_WEIGHTS.relevance), recency: pick(1, DEFAULT_WEIGHTS.recency), importance: pick(2, DEFAULT_WEIGHTS.importance) };
}

/** Exponential decay on age → (0,1]; 1.0 at age 0, 0.5 at one half-life. Future timestamps clamp to 1. */
export function recencyScore(ageMs: number, halfLifeDays = RECENCY_HALFLIFE_DAYS): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / (halfLifeDays * DAY_MS));
}

/** Min-max normalize a vector to [0,1]. A degenerate OR near-constant set (range tiny relative to the
 *  magnitude) maps to a neutral 0.5 so the signal contributes nothing to the ranking — without this,
 *  facts created milliseconds apart would have their ~1e-8 recency spread amplified to a full [0,1]
 *  swing, making essentially-same-age facts look decisively recency-ranked. eps is RELATIVE so it works
 *  across signals of different magnitude (recency ~1, cosine ~0.7, importance ~5). */
export function minmax(vals: number[], eps = 1e-6): number[] {
  if (vals.length === 0) return [];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const range = hi - lo;
  const scale = Math.max(Math.abs(hi), Math.abs(lo), 1);
  if (range <= eps * scale) return vals.map(() => 0.5);
  return vals.map((v) => (v - lo) / range);
}

export interface RankCandidate {
  id: number;
  relevance: number;   // raw cosine
  importance: number;  // 1–10
  createdAtMs: number; // Date.parse(fact.created_at)
}

/** Weighted Generative-Agents score per candidate (min-max normalized across the set). */
export function rankScores(cands: RankCandidate[], nowMs: number, w: RankWeights = DEFAULT_WEIGHTS): { id: number; score: number }[] {
  const rel = minmax(cands.map((c) => c.relevance));
  const rec = minmax(cands.map((c) => recencyScore(nowMs - c.createdAtMs)));
  const imp = minmax(cands.map((c) => c.importance));
  return cands.map((c, i) => ({ id: c.id, score: w.relevance * rel[i] + w.recency * rec[i] + w.importance * imp[i] }));
}

/** Rank by weighted score (desc), id asc as the deterministic tiebreak; return top-k ids. */
export function rankCandidates(cands: RankCandidate[], nowMs: number, w: RankWeights, k: number): number[] {
  return rankScores(cands, nowMs, w)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, k)
    .map((x) => x.id);
}
