// Embedded free-models router — public API. This module is the CONTRACT the later UX/docs phase codes
// against; the exported types are the stable surface. OB-1 routes across ~20 free-tier CLOUD providers
// IN-PROCESS: one editable keys file activates providers, keyless ones work with zero setup, and callFree
// picks the best available model per request (strategy-ordered) with automatic failover, rate-limit windows,
// escalating cooldowns, and a bandit reliability score — no HTTP server, no second process.
import { callOpenAI } from "../openai.ts";
import { AbortedError } from "../http.ts";
import { toSystemBlocks, type CallOpts, type ModelResponse } from "../types.ts";
import { globalSettingsDir, persistedSettings } from "../../config.ts";
import { CATALOG, type CatalogQuirk, FREE_PROVIDERS, resolveConnection, splitModelKey } from "./registry.ts";
import { allCandidates, gateReason, selectCandidates } from "./router.ts";
import { DEFAULT_STRATEGY, type RoutingStrategy, STRATEGIES } from "./scoring.ts";
import {
  coolDownFixed,
  coolDownLadder,
  addPenalty,
  getHealth,
  type HealthStatus,
  learnLimitFromError,
  recordFailStats,
  recordSuccessStats,
  recordTokenDelta,
  reserveRequest,
  setHealth,
  soonestCooldownExpiry,
} from "./state.ts";
import { keysFilePath, keysChangedSinceCache, loadKeys } from "./keys.ts";
import { kickHealthIfStale, kickHealthNow, startHealthLoop } from "./health.ts";
import { postProcessResponse } from "./tool-repair.ts";

export { ensureKeysFile, keysFilePath } from "./keys.ts";
export { runFreeHealthCheck } from "./health.ts";
export type { RoutingStrategy } from "./scoring.ts";
export { STRATEGIES, DEFAULT_STRATEGY } from "./scoring.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_ATTEMPTS = 8; // failover hops per logical call (callModel's outer retry loops on top for backoff)

// ── Public types (the phase-2 UX contract) ────────────────────────────────────

/** One model in the free catalog, with its current availability. */
export interface FreeModelInfo {
  /** "platform/modelId" — the pin string callFree accepts as opts.model. */
  id: string;
  platform: string;
  providerName: string;
  displayName: string;
  /** True when this model can serve a general (no tools/vision requirement) request right now. */
  available: boolean;
  /** Coarse reason it can't serve (no key, on cooldown, rate limit reached, …); undefined when available. */
  unavailableReason?: string;
  supportsTools: boolean;
  supportsVision: boolean;
  /** Input context window in tokens (0 when the catalog doesn't publish one). */
  contextWindow: number;
  intelligenceRank: number; // 1 = smartest
  sizeLabel: string; // Frontier | Large | Medium | Small
  quirks: CatalogQuirk[];
}

/** One provider's rollup for the status surface. */
export interface FreeProviderStatus {
  id: string;
  name: string;
  keyless: boolean;
  hasKey: boolean;
  health: HealthStatus;
  modelCount: number;
  availableCount: number;
  signupUrl: string;
}

/** The whole free-router status (for a `/free` UX and diagnostics). */
export interface FreeStatus {
  keysPath: string;
  strategy: RoutingStrategy;
  providers: FreeProviderStatus[];
  totalModels: number;
  availableModels: number;
  /** Variable names in keys.env that don't match any provider (a hand-edit warning). */
  unknownKeys: string[];
  /** The vendored catalog version, so the UX can show how fresh the model list is. */
  catalogVersion: string;
}

// ── Strategy resolution ───────────────────────────────────────────────────────

/** The active routing strategy: OB1_FREE_STRATEGY env override > persisted `freeStrategy` > "balanced". */
export function getFreeStrategy(): RoutingStrategy {
  const env = process.env.OB1_FREE_STRATEGY?.trim();
  if (env && (STRATEGIES as string[]).includes(env)) return env as RoutingStrategy;
  try {
    const s = persistedSettings(globalSettingsDir()).freeStrategy;
    if (s && (STRATEGIES as string[]).includes(s)) return s as RoutingStrategy;
  } catch {
    /* settings unreadable → default */
  }
  return DEFAULT_STRATEGY;
}

// ── Request analysis ──────────────────────────────────────────────────────────

/** Estimate total request tokens (≈ chars/4 of system + messages) plus the reserved output (maxTokens),
 *  so the TPM/context checks account for the whole budget the call will consume. */
function estimateTokens(opts: CallOpts): number {
  const sysChars = toSystemBlocks(opts.system).reduce((n, b) => n + b.text.length, 0);
  const msgChars = opts.messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
    0,
  );
  return Math.ceil((sysChars + msgChars) / 4) + (opts.maxTokens ?? 0);
}

/** True when any message carries an image (a standalone image block or a tool_result with image content) —
 *  drives requireVision so an image turn never routes to a text-only model. */
function messagesHaveImage(messages: CallOpts["messages"]): boolean {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "image") return true;
      if (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((x) => x.type === "image"))
        return true;
    }
  }
  return false;
}

/** Pull the HTTP status out of an http.ts error (`API <status>: …`), or 0 when it's a network/idle error. */
function parseStatus(message: string): number {
  const m = message.match(/API (\d{3})/);
  return m ? Number(m[1]) : 0;
}

/** Best-effort Retry-After (ms) parsed from a 429 BODY text (the header isn't surfaced by http.ts). Matches
 *  "retry after 30", "try again in 12.5s", "in 45 seconds". Null when nothing parseable. */
function parseRetryAfter(message: string): number | null {
  const m = message.match(/(?:retry[- ]after|try again in|in)[:\s]+(\d+(?:\.\d+)?)\s*(m?s|seconds?|minutes?|m)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") return n;
  if (unit.startsWith("m") && unit !== "ms") return n * MINUTE; // minutes
  return n * 1000; // seconds (default)
}

function formatEta(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 90) return `~${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `~${mins}m`;
  return `~${Math.round(mins / 60)}h`;
}

// ── The heart: callFree ───────────────────────────────────────────────────────

/** Route ONE logical model call across the free providers with failover. `opts.model` is "auto"/"" for
 *  strategy routing, or a "platform/modelId" pin (tried first, then falls back to strategy order). Never
 *  fails over once output has streamed to the caller (mirrors the gateway's `produced` rule). Exhaustion
 *  throws an "API 429: …" error so the gateway's retry/backoff treats it as retryable (windows expire).
 *
 *  `_call` is an injectable seam (defaults to callOpenAI) exactly like gateway.ts's `_dispatch`, so tests
 *  can drive routing without network. */
export async function callFree(
  opts: CallOpts,
  _call: (o: CallOpts) => Promise<ModelResponse> = callOpenAI,
): Promise<ModelResponse> {
  // 1. Refresh keys if the file changed; kick background health (never blocks the turn).
  const keysChanged = keysChangedSinceCache();
  const keys = loadKeys();
  startHealthLoop();
  if (keysChanged) kickHealthNow();
  else kickHealthIfStale();

  const strategy = getFreeStrategy();
  const requireTools = !!opts.tools?.length;
  const requireVision = messagesHaveImage(opts.messages);
  const estimatedTokens = estimateTokens(opts);

  // Pin parsing: "auto"/"" ⇒ strategy routing; else split on the FIRST "/" (platform ids never contain "/",
  // modelIds may). A bare string with no "/" can't match a model → treated as auto (best-effort).
  const raw = (opts.model ?? "").trim();
  const isAuto = raw === "" || /^(auto|router|default)$/i.test(raw);
  const pin = isAuto ? undefined : splitModelKey(raw);

  const skip = new Set<string>();
  let produced = false; // any delta emitted to the CALLER (opts.onText/onReasoning) → don't fail over
  const timing = { start: 0, firstByte: 0 };
  const onText = (d: string) => {
    if (!timing.firstByte) timing.firstByte = performance.now();
    if (opts.onText) {
      produced = true;
      opts.onText(d);
    }
  };
  const onReasoning = (d: string) => {
    if (!timing.firstByte) timing.firstByte = performance.now();
    if (opts.onReasoning) {
      produced = true;
      opts.onReasoning(d);
    }
  };

  let lastTally: Record<string, number> = {};
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw new AbortedError();
    const now = Date.now();
    const { candidates, tally } = selectCandidates({
      strategy,
      requireTools,
      requireVision,
      estimatedTokens,
      keys: keys.byProvider,
      pin,
      skip,
      now,
    });
    lastTally = tally;
    const cand = candidates[0];
    if (!cand) break; // nothing servable → exhausted

    // Reserve the request + estimated tokens BEFORE the call so an in-turn burst can't over-fire a window.
    reserveRequest(cand.platform, cand.modelId, estimatedTokens, now);

    const key = keys.byProvider.get(cand.platform) ?? "";
    const conn = resolveConnection(cand.provider, key);
    const extraHeaders = conn.extraHeaders && Object.keys(conn.extraHeaders).length ? conn.extraHeaders : undefined;
    timing.start = performance.now();
    timing.firstByte = 0;

    try {
      const resp = await _call({
        provider: "openai",
        apiKey: conn.apiKey,
        baseUrl: conn.baseUrl,
        model: cand.modelId,
        extraHeaders,
        openrouter: cand.platform === "openrouter",
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        maxTokens: opts.maxTokens,
        effort: opts.effort,
        onText,
        onReasoning,
        signal: opts.signal,
        onRetry: opts.onRetry,
        idempotencyKey: opts.idempotencyKey,
      });

      // Success: reconcile token windows with actuals, record reliability/latency, reset auth fails.
      const done = Date.now();
      const usage = resp.usage;
      const actualTokens = usage
        ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens
        : estimatedTokens;
      recordTokenDelta(cand.platform, cand.modelId, actualTokens - estimatedTokens, done);
      const elapsedMs = performance.now() - timing.start;
      const outTok = usage?.output_tokens ?? 0;
      const tokPerSec = elapsedMs > 0 && outTok > 0 ? (outTok * 1000) / elapsedMs : 0;
      const ttfbMs = timing.firstByte ? timing.firstByte - timing.start : null;
      recordSuccessStats(cand.platform, cand.modelId, tokPerSec, ttfbMs, done);
      const h = getHealth(cand.platform);
      if (!cand.provider.keyless && h && h.consecutiveAuthFails > 0)
        setHealth(cand.platform, { status: "healthy", consecutiveAuthFails: 0 });

      return postProcessResponse(resp, cand.id, opts.tools);
    } catch (e) {
      const err = e as Error;
      lastErr = err;
      if (err.name === "AbortError") throw err; // ESC — never fail over
      if (produced) throw err; // already streamed to the caller — a re-run would duplicate output
      handleFailure(cand, err, skip);
      // fall through to the next candidate
    }
  }

  throw exhaustionError(lastTally, keys, lastErr);
}

/** Classify one attempt's failure and update router state so the next selection skips/benches it. */
function handleFailure(cand: ReturnType<typeof allCandidates>[number], err: Error, skip: Set<string>): void {
  const now = Date.now();
  const msg = err.message || "";
  const status = parseStatus(msg);
  recordFailStats(cand.platform, cand.modelId, now);

  if (status === 401 || status === 403) {
    // Auth failure: bench this model a day, mark the provider unhealthy, and skip ALL of its models this call.
    if (!cand.provider.keyless) {
      const h = getHealth(cand.platform);
      const fails = (h?.consecutiveAuthFails ?? 0) + 1;
      setHealth(cand.platform, { status: fails >= 3 ? "disabled" : "invalid", consecutiveAuthFails: fails });
    }
    coolDownFixed(cand.platform, cand.modelId, DAY, now);
    for (const c of allCandidates()) if (c.platform === cand.platform) skip.add(c.id);
    return;
  }
  if (status === 404) {
    // Wrong/removed model id: bench a day and rule the model out for this request.
    coolDownFixed(cand.platform, cand.modelId, DAY, now);
    skip.add(cand.id);
    return;
  }
  if (status === 429) {
    // Rate limit: escalating cooldown ladder + penalty + learn the real ceiling from the body.
    coolDownLadder(cand.platform, cand.modelId, now, parseRetryAfter(msg));
    addPenalty(cand.platform, cand.modelId, now);
    learnLimitFromError(cand.platform, cand.modelId, msg);
    skip.add(cand.id);
    return;
  }
  if (status === 402) {
    // Out of credits: won't recover this window — bench a full day.
    coolDownFixed(cand.platform, cand.modelId, DAY, now);
    skip.add(cand.id);
    return;
  }
  // 5xx / network / idle timeout / non-stream body: short cooldown (ladder level 0) and rotate.
  coolDownFixed(cand.platform, cand.modelId, 2 * MINUTE, now);
  skip.add(cand.id);
}

/** Build the retryable exhaustion error. Starts with "API 429: " so gateway.isRetryable backs off (windows
 *  expire), and summarizes per-reason WHY the pool was empty plus a hint to add keys. */
function exhaustionError(
  tally: Record<string, number>,
  keys: ReturnType<typeof loadKeys>,
  lastErr: Error | undefined,
): Error {
  const now = Date.now();
  const reset = soonestCooldownExpiry(now);
  const parts = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`);
  const summary = parts.length ? ` (${parts.join(", ")})` : "";
  const eta = reset ? ` Soonest reset ${formatEta(reset - now)}.` : "";
  const hint =
    keys.byProvider.size === 0
      ? `Only keyless providers are active — add API keys to ${keysFilePath()} to unlock more models.`
      : `Add more keys to ${keysFilePath()}, switch strategy, or wait for limits to reset.`;
  const tail = lastErr ? ` Last error: ${lastErr.message.slice(0, 160)}` : "";
  return new Error(`API 429: all free models exhausted${summary}.${eta} ${hint}${tail}`);
}

// ── Status / listing surfaces ─────────────────────────────────────────────────

/** Every catalog model with its current availability (general request — no tools/vision requirement). */
export function listFreeModels(): FreeModelInfo[] {
  const keys = loadKeys();
  const now = Date.now();
  return allCandidates().map((c) => {
    const reason = gateReason(c, {
      strategy: DEFAULT_STRATEGY,
      requireTools: false,
      requireVision: false,
      estimatedTokens: 0,
      keys: keys.byProvider,
      skip: new Set(),
      now,
    });
    return {
      id: c.id,
      platform: c.platform,
      providerName: c.provider.name,
      displayName: c.model.displayName,
      available: reason === null,
      unavailableReason: reason ?? undefined,
      supportsTools: c.model.supportsTools,
      supportsVision: c.model.supportsVision,
      contextWindow: c.model.contextWindow ?? 0,
      intelligenceRank: c.model.intelligenceRank,
      sizeLabel: c.model.sizeLabel,
      quirks: c.model.quirks,
    };
  });
}

/** The whole free-router status: keys path, active strategy, and a per-provider rollup. */
export function freeStatus(): FreeStatus {
  const keys = loadKeys();
  const models = listFreeModels();
  const byPlatform = new Map<string, FreeModelInfo[]>();
  for (const m of models) {
    const arr = byPlatform.get(m.platform);
    if (arr) arr.push(m);
    else byPlatform.set(m.platform, [m]);
  }
  const providers: FreeProviderStatus[] = FREE_PROVIDERS.map((p) => {
    const ms = byPlatform.get(p.id) ?? [];
    const hasKey = keys.byProvider.has(p.id);
    const h = getHealth(p.id);
    // Keyless ⇒ always healthy; keyed-with-key ⇒ the probed status (unknown until validated); no key ⇒ unknown.
    const health: HealthStatus = p.keyless ? "healthy" : hasKey ? (h?.status ?? "unknown") : "unknown";
    return {
      id: p.id,
      name: p.name,
      keyless: p.keyless,
      hasKey,
      health,
      modelCount: ms.length,
      availableCount: ms.filter((m) => m.available).length,
      signupUrl: p.signupUrl,
    };
  });
  return {
    keysPath: keysFilePath(),
    strategy: getFreeStrategy(),
    providers,
    totalModels: models.length,
    availableModels: models.filter((m) => m.available).length,
    unknownKeys: keys.unknown,
    catalogVersion: CATALOG.version,
  };
}
