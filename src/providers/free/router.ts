// Candidate selection for the embedded free-models router. Builds the chain from the catalog × active keys,
// applies the HARD gates (enabled flag, key/health, tools/vision requirements, context window, rate windows,
// cooldowns, provider-wide caps), orders by the active strategy, and returns the ordered candidates plus a
// per-reason tally for the exhaustion message. Adapts the freellmapi-suite router's ordering + gating; the
// SQLite/analytics/round-robin machinery is dropped (one key per provider here, in-memory windows).
import { CATALOG, type CatalogModel, type FreeProvider, modelKey, providerById } from "./registry.ts";
import {
  combineScore,
  intelligenceComposite,
  intelligenceScore,
  reliabilityPosterior,
  sampleBeta,
  speedScore,
  weightsFor,
  headroomFactor,
  rateLimitFactor,
  type RoutingStrategy,
} from "./scoring.ts";
import {
  dailyUsage,
  getHealth,
  getPenalty,
  getStats,
  isOnCooldown,
  withinModelLimits,
  withinProviderCaps,
} from "./state.ts";

/** One routable model = a catalog row bound to its provider connection metadata. */
export interface Candidate {
  id: string; // "platform/modelId"
  platform: string;
  modelId: string;
  model: CatalogModel;
  provider: FreeProvider;
}

export interface SelectionInput {
  strategy: RoutingStrategy;
  requireTools: boolean;
  requireVision: boolean;
  estimatedTokens: number;
  /** Active keys by provider id (empty for keyless). */
  keys: Map<string, string>;
  /** A pinned model to try first (still gated); undefined ⇒ pure strategy routing. */
  pin?: { platform: string; modelId: string };
  /** Ids already tried+failed this request (failover skip-set). */
  skip: Set<string>;
  now: number;
}

export interface Selection {
  candidates: Candidate[];
  /** reason → count, for the exhaustion diagnostic (no key material, aggregate only). */
  tally: Record<string, number>;
}

/** Does this provider have a usable credential? Keyless ⇒ always (anonymous); otherwise needs a key. */
function hasCredential(provider: FreeProvider, keys: Map<string, string>): boolean {
  return provider.keyless || keys.has(provider.id);
}

/** All models whose provider is registered — the full routable universe (before gating). Built once. */
const ALL_CANDIDATES: Candidate[] = CATALOG.models
  .map((model): Candidate | null => {
    const provider = providerById(model.platform);
    if (!provider) return null; // unknown platform (shouldn't happen post-sync) — drop
    return {
      id: modelKey(model.platform, model.modelId),
      platform: model.platform,
      modelId: model.modelId,
      model,
      provider,
    };
  })
  .filter((c): c is Candidate => c !== null);

/** The full catalog candidate list (all providers), for listing/status surfaces. */
export function allCandidates(): Candidate[] {
  return ALL_CANDIDATES;
}

/** Why one candidate can't serve RIGHT NOW, or null when it's servable. Reasons are coarse buckets so the
 *  exhaustion tally stays short + client-safe. Requirement checks (tools/vision) are only applied when the
 *  caller passes the corresponding require flag. */
export function gateReason(c: Candidate, input: SelectionInput): string | null {
  if (input.skip.has(c.id)) return "failed earlier this request";
  if (!c.model.enabled) return "disabled in catalog";
  if (!hasCredential(c.provider, input.keys)) return "no key";
  const health = getHealth(c.platform);
  if (health && (health.status === "disabled" || health.status === "invalid")) return "provider key unhealthy";
  if (input.requireTools && !c.model.supportsTools) return "no tool-calling support";
  if (input.requireVision && !c.model.supportsVision) return "no vision support";
  if (c.model.contextWindow != null && input.estimatedTokens > c.model.contextWindow)
    return "prompt larger than context window";
  if (!withinProviderCaps(c.platform, c.provider.providerRpmCap, c.provider.providerRpdCap, input.now))
    return "provider account cap reached";
  if (isOnCooldown(c.platform, c.modelId, input.now)) return "on cooldown";
  if (!withinModelLimits(c.model, input.estimatedTokens, input.now)) return "rate limit reached";
  return null;
}

/** Score one candidate under the given weights, Thompson-sampling reliability for live routing. */
function scoreCandidate(
  c: Candidate,
  weights: ReturnType<typeof weightsFor>,
  intelMin: number,
  intelMax: number,
  now: number,
): number {
  const stats = getStats(c.platform, c.modelId);
  const { alpha, beta } = reliabilityPosterior(stats?.succ ?? 0, stats?.fail ?? 0);
  const reliability = sampleBeta(alpha, beta);
  const speed = speedScore(stats?.tokPerSec ?? 0, stats && stats.ttfbMs > 0 ? stats.ttfbMs : null);
  const intelligence = intelligenceScore(
    intelligenceComposite(c.model.sizeLabel, c.model.intelligenceRank),
    intelMin,
    intelMax,
  );
  const usage = dailyUsage(c.model, now);
  const headroom = headroomFactor(usage.dayReqs, usage.rpd, usage.dayTokens, usage.tpd);
  const rl = rateLimitFactor(getPenalty(c.platform, c.modelId, now));
  return combineScore({ reliability, speed, intelligence, headroom, rateLimit: rl }, weights!);
}

/** Order servable candidates by the active strategy. `priority` = catalog order (intelligenceRank asc) with
 *  429-penalty demotion, no sampling; the bandit strategies = convex Thompson score desc, intelligenceRank
 *  as the deterministic tiebreaker. */
function orderCandidates(cands: Candidate[], strategy: RoutingStrategy, now: number): Candidate[] {
  const weights = weightsFor(strategy);
  if (!weights) {
    return cands
      .map((c) => ({ c, eff: c.model.intelligenceRank + getPenalty(c.platform, c.modelId, now) }))
      .sort((a, b) => a.eff - b.eff || a.c.model.intelligenceRank - b.c.model.intelligenceRank)
      .map((x) => x.c);
  }
  const composites = cands.map((c) => intelligenceComposite(c.model.sizeLabel, c.model.intelligenceRank));
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;
  return cands
    .map((c) => ({ c, s: scoreCandidate(c, weights, intelMin, intelMax, now) }))
    .sort((a, b) => b.s - a.s || a.c.model.intelligenceRank - b.c.model.intelligenceRank)
    .map((x) => x.c);
}

/** Select + order the candidates that can serve this request now. A pinned model that passes the gates is
 *  moved to the front (bypasses ordering); a pinned model that's gated out is ignored (fall over to strategy
 *  order) — the caller never dead-ends. */
export function selectCandidates(input: SelectionInput): Selection {
  const servable: Candidate[] = [];
  const tally: Record<string, number> = {};
  for (const c of ALL_CANDIDATES) {
    const reason = gateReason(c, input);
    if (reason) {
      tally[reason] = (tally[reason] ?? 0) + 1;
    } else {
      servable.push(c);
    }
  }

  let ordered = orderCandidates(servable, input.strategy, input.now);

  if (input.pin) {
    const pinId = modelKey(input.pin.platform, input.pin.modelId);
    const idx = ordered.findIndex((c) => c.id === pinId);
    if (idx > 0) {
      const [pinned] = ordered.splice(idx, 1);
      ordered = [pinned, ...ordered];
    }
    // idx === 0 → already first; idx < 0 → pin gated out or unknown → strategy order stands.
  }

  return { candidates: ordered, tally };
}
