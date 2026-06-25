// Deterministic test for weighted memory retrieval (PLAN-V2 #5). No API key / no UI.
// Covers the pure ranker (rank.ts): recency decay, min-max (incl. near-constant collapse), weighted
// re-rank where recency/importance flip the cosine order, and the (1,0,0)→cosine back-compat guarantee;
// plus the store path: the importance column + migration, and searchSemantic re-ranking by importance.
// Usage: bun run scripts/memory-rank-smoke.ts
import { recencyScore, minmax, rankCandidates, rankScores, parseWeights, DEFAULT_WEIGHTS, RECENCY_HALFLIFE_DAYS, type RankCandidate } from "../src/memory/rank.ts";
import { MemoryStore } from "../src/memory/store.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const HALF = RECENCY_HALFLIFE_DAYS * 86_400_000;

// ── recencyScore ──
check("recency is 1.0 at age 0", near(recencyScore(0), 1));
check("recency is 0.5 at one half-life", near(recencyScore(HALF), 0.5));
check("recency is 0.25 at two half-lives", near(recencyScore(2 * HALF), 0.25));
check("recency clamps future timestamps to 1", recencyScore(-1000) === 1);

// ── minmax (incl. degenerate + near-constant) ──
check("minmax scales to [0,1]", JSON.stringify(minmax([10, 20, 30])) === JSON.stringify([0, 0.5, 1]));
check("minmax of an all-equal set → neutral 0.5", minmax([7, 7, 7]).every((v) => v === 0.5));
check("minmax collapses a near-constant set (ms-apart recency) → 0.5", minmax([1, 1 - 1e-8, 1 - 2e-8]).every((v) => v === 0.5));
check("minmax of empty is empty", minmax([]).length === 0);

// ── parseWeights ──
check("parseWeights default", JSON.stringify(parseWeights(undefined)) === JSON.stringify(DEFAULT_WEIGHTS));
check("parseWeights custom", JSON.stringify(parseWeights("2,1,0.5")) === JSON.stringify({ relevance: 2, recency: 1, importance: 0.5 }));
check("parseWeights tolerates junk (falls back per-field)", JSON.stringify(parseWeights("x,,3")) === JSON.stringify({ relevance: DEFAULT_WEIGHTS.relevance, recency: DEFAULT_WEIGHTS.recency, importance: 3 }));

// ── rankCandidates ──
const now = 1_000 * HALF; // a large fixed "now" so ages are positive
// Back-compat: weights (1,0,0) → pure cosine order (highest relevance first), regardless of age/importance.
{
  const cands: RankCandidate[] = [
    { id: 1, relevance: 0.2, importance: 10, createdAtMs: now },        // newest + most important but least relevant
    { id: 2, relevance: 0.9, importance: 1, createdAtMs: now - 50 * HALF }, // most relevant but old + unimportant
    { id: 3, relevance: 0.5, importance: 5, createdAtMs: now - 10 * HALF },
  ];
  check("(1,0,0) reduces to cosine order", JSON.stringify(rankCandidates(cands, now, { relevance: 1, recency: 0, importance: 0 }, 3)) === JSON.stringify([2, 3, 1]));

  // Recency flips: a slightly-less-relevant but much newer fact wins when recency is weighted.
  const rc: RankCandidate[] = [
    { id: 1, relevance: 0.80, importance: 5, createdAtMs: now - 40 * HALF }, // very old
    { id: 2, relevance: 0.70, importance: 5, createdAtMs: now },             // brand new
  ];
  check("recency weight surfaces the newer fact over a higher-cosine old one", rankCandidates(rc, now, { relevance: 1, recency: 2, importance: 0 }, 1)[0] === 2);
  check("…but pure relevance still prefers the old higher-cosine fact", rankCandidates(rc, now, { relevance: 1, recency: 0, importance: 0 }, 1)[0] === 1);

  // Importance flips: a less-relevant but far more important fact wins when importance dominates.
  const ic: RankCandidate[] = [
    { id: 1, relevance: 0.80, importance: 2, createdAtMs: now },
    { id: 2, relevance: 0.60, importance: 10, createdAtMs: now },
  ];
  check("importance weight surfaces the salient fact", rankCandidates(ic, now, { relevance: 1, recency: 0, importance: 5 }, 1)[0] === 2);
  const scores = rankScores(ic, now, { relevance: 1, recency: 0, importance: 5 });
  check("rankScores exposes per-candidate scores", scores.length === 2 && scores.every((s) => typeof s.score === "number"));
}

// ── store path: importance column + migration + searchSemantic re-rank ──
{
  const m = new MemoryStore(":memory:", undefined); // no embedder → searchSemantic uses keyword; test the column instead
  const id = m.addFact("a fact about widgets");
  check("addFact defaults importance to the mid value (5)", m.listFacts()[0].importance === 5);
  check("setImportance updates + clamps to 1–10", m.setImportance(id, 99) && m.listFacts()[0].importance === 10);
  m.close();
}
{
  // Real embedder so searchSemantic runs the weighted path; emphasize importance and show a re-rank.
  const { makeEmbedder } = await import("../src/memory/embed.ts");
  const m = new MemoryStore(":memory:", makeEmbedder());
  const a = await m.remember("authentication uses JWT tokens for login security");
  const b = await m.remember("the build system is Bun with a single sqlite file");
  // Query closest to fact a. Default weights → a ranks first.
  const topDefault = (await m.searchSemantic("JWT login token auth", 2))[0];
  check("searchSemantic returns the most relevant fact by default", topDefault.id === a, `#${topDefault.id}`);
  // Crank importance weighting and make the OTHER fact maximally important → it should overtake.
  m.setImportance(b, 10); m.setImportance(a, 1);
  process.env.OB1_MEM_WEIGHTS = "1,0,8";
  const topImp = (await m.searchSemantic("JWT login token auth", 2))[0];
  check("a far-more-important fact overtakes under heavy importance weight", topImp.id === b, `#${topImp.id}`);
  delete process.env.OB1_MEM_WEIGHTS;
  m.close();
}

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
