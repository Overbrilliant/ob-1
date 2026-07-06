// Persistent router state for the embedded free-models router — ~/.ob1/free-state.json (0o600).
//
// Holds everything that must survive a (short) CLI session: fixed-window rate-limit counters, escalating
// cooldowns, 429 penalties, self-learned limit overrides, per-provider key health, and per-model
// reliability/speed stats. Load-tolerant (corrupt/missing ⇒ fresh state). Writes are DEBOUNCED (~500ms)
// and best-effort (never throw — a failed persist must not break a turn), flushed on process exit.
//
// Concurrency: multiple OB-1 processes share this file with LAST-WRITER-WINS semantics (each process holds
// its own in-memory copy; the last to flush overwrites). Acceptable — the counters are approximations and
// re-converge; nothing here is money-critical.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalSettingsDir } from "../../config.ts";
import type { CatalogLimits, CatalogModel } from "./registry.ts";
import { modelKey } from "./registry.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STATE_VERSION = 1;

/** Fixed-window (bucket) approximation of the rpm/rpd/tpm/tpd counters. `minuteStart`/`dayStartUTC` are the
 *  bucket START timestamps (UTC-aligned via floor(now/window)); a counter resets when its bucket rolls. */
export interface WindowState {
  minuteStart: number;
  minuteReqs: number;
  minuteTokens: number;
  dayStartUTC: number;
  dayReqs: number;
  dayTokens: number;
}

/** Cooldown for one model: benched until `until`, at escalation `level` (index into COOLDOWN_DURATIONS).
 *  `setAt` records when it was last set so the 24h escalation window can be computed on the next 429. */
export interface CooldownState {
  until: number;
  level: number;
  setAt: number;
}

/** 429 penalty for one model: `value` in [0,10], decayed lazily (1 per 2 min) from `updatedAt`. */
export interface PenaltyState {
  value: number;
  updatedAt: number;
}

/** Self-learned limit overrides parsed from provider 429 bodies — they only ever LOWER catalog limits. */
export interface LearnedLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

export type HealthStatus = "healthy" | "invalid" | "error" | "unknown" | "disabled";

/** Per-provider key health. `keyHash` is a short non-crypto hash of the active key so a key CHANGE resets
 *  `consecutiveAuthFails` (and re-opens a disabled provider) without storing the key itself. */
export interface HealthState {
  status: HealthStatus;
  lastCheckedAt: number;
  consecutiveAuthFails: number;
  keyHash: string;
}

/** Per-model reliability + latency stats feeding the bandit. `succ`/`fail` are decay-weighted pseudo-counts
 *  (Beta priors when absent); `tokPerSec`/`ttfbMs` are EWMAs; catalog ranks are the priors with no data. */
export interface StatState {
  succ: number;
  fail: number;
  tokPerSec: number;
  ttfbMs: number;
  lastUsedAt: number;
}

export interface FreeState {
  v: number;
  windows: Record<string, WindowState>;
  providerWindows: Record<string, WindowState>;
  cooldowns: Record<string, CooldownState>;
  penalties: Record<string, PenaltyState>;
  learnedLimits: Record<string, LearnedLimits>;
  health: Record<string, HealthState>;
  stats: Record<string, StatState>;
}

function freshState(): FreeState {
  return {
    v: STATE_VERSION,
    windows: {},
    providerWindows: {},
    cooldowns: {},
    penalties: {},
    learnedLimits: {},
    health: {},
    stats: {},
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────
let cache: FreeState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let exitHooked = false;

/** Absolute path to the state file. Honors OB1_SETTINGS_DIR via globalSettingsDir(). */
export function statePath(): string {
  return join(globalSettingsDir(), "free-state.json");
}

/** Load (and cache) the router state. Corrupt/missing/legacy-version ⇒ a fresh state, never a throw. */
export function loadState(): FreeState {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<FreeState>;
    if (!raw || raw.v !== STATE_VERSION) {
      cache = freshState();
    } else {
      // Merge onto a fresh shape so a partially-written file (missing a sub-map) can't crash accessors.
      const base = freshState();
      cache = {
        v: STATE_VERSION,
        windows: raw.windows ?? base.windows,
        providerWindows: raw.providerWindows ?? base.providerWindows,
        cooldowns: raw.cooldowns ?? base.cooldowns,
        penalties: raw.penalties ?? base.penalties,
        learnedLimits: raw.learnedLimits ?? base.learnedLimits,
        health: raw.health ?? base.health,
        stats: raw.stats ?? base.stats,
      };
    }
  } catch {
    cache = freshState(); // missing / unreadable / corrupt → fresh
  }
  return cache;
}

/** Drop the in-memory cache (tests only) so the next loadState() re-reads from disk. */
export function resetStateCache(): void {
  cache = null;
  dirty = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** Write the state file NOW (0o600, best-effort). */
export function saveStateNow(): void {
  if (!cache) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
  try {
    const dir = globalSettingsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = statePath();
    writeFileSync(path, JSON.stringify(cache), { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* perms best-effort (Windows) */
    }
  } catch {
    /* best-effort persistence — a failed write must not break a turn */
  }
}

/** Schedule a debounced (~500ms) flush. Also flushes on process exit so short sessions still persist. */
function markDirty(): void {
  dirty = true;
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => {
      if (dirty) saveStateNow();
    });
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateNow();
  }, 500);
  // Don't keep the event loop alive just to flush state.
  (saveTimer as unknown as { unref?: () => void }).unref?.();
}

/** Force a debounced flush from callers that mutate state directly via getState(). */
export function persistSoon(): void {
  markDirty();
}

/** The raw state object (for status/reporting). Mutations should go through the helpers below so a flush
 *  is scheduled; direct mutators must call persistSoon(). */
export function getState(): FreeState {
  return loadState();
}

// ── Window (rate-limit) accounting ──────────────────────────────────────────
function emptyWindow(now: number): WindowState {
  return {
    minuteStart: Math.floor(now / MINUTE) * MINUTE,
    minuteReqs: 0,
    minuteTokens: 0,
    dayStartUTC: Math.floor(now / DAY) * DAY,
    dayReqs: 0,
    dayTokens: 0,
  };
}

function rollWindow(w: WindowState, now: number): void {
  const minuteBucket = Math.floor(now / MINUTE) * MINUTE;
  if (w.minuteStart !== minuteBucket) {
    w.minuteStart = minuteBucket;
    w.minuteReqs = 0;
    w.minuteTokens = 0;
  }
  const dayBucket = Math.floor(now / DAY) * DAY;
  if (w.dayStartUTC !== dayBucket) {
    w.dayStartUTC = dayBucket;
    w.dayReqs = 0;
    w.dayTokens = 0;
  }
}

function windowFor(map: Record<string, WindowState>, key: string, now: number): WindowState {
  const w = (map[key] ??= emptyWindow(now));
  rollWindow(w, now);
  return w;
}

/** The effective limits for a model: catalog limits LOWERED by any self-learned override (never raised).
 *  A `null` on an axis means "no published cap" (unlimited on that axis). */
export function effectiveLimits(model: CatalogModel): CatalogLimits {
  const learned = loadState().learnedLimits[modelKey(model.platform, model.modelId)];
  const pick = (cat: number | null, over: number | undefined): number | null => {
    if (cat == null && over == null) return null;
    if (cat == null) return over ?? null;
    if (over == null) return cat;
    return Math.min(cat, over);
  };
  return {
    rpm: pick(model.limits.rpm, learned?.rpm),
    rpd: pick(model.limits.rpd, learned?.rpd),
    tpm: pick(model.limits.tpm, learned?.tpm),
    tpd: pick(model.limits.tpd, learned?.tpd),
  };
}

/** Is `estTokens` within this model's rate windows RIGHT NOW? (fixed-window approximation). */
export function withinModelLimits(model: CatalogModel, estTokens: number, now: number): boolean {
  const eff = effectiveLimits(model);
  const w = windowFor(loadState().windows, modelKey(model.platform, model.modelId), now);
  if (eff.rpm != null && w.minuteReqs >= eff.rpm) return false;
  if (eff.rpd != null && w.dayReqs >= eff.rpd) return false;
  if (eff.tpm != null && w.minuteTokens + estTokens > eff.tpm) return false;
  if (eff.tpd != null && w.dayTokens + estTokens > eff.tpd) return false;
  return true;
}

/** The daily-window snapshot a model's headroom factor is computed from. */
export function dailyUsage(
  model: CatalogModel,
  now: number,
): { dayReqs: number; dayTokens: number; rpd: number | null; tpd: number | null } {
  const eff = effectiveLimits(model);
  const w = windowFor(loadState().windows, modelKey(model.platform, model.modelId), now);
  return { dayReqs: w.dayReqs, dayTokens: w.dayTokens, rpd: eff.rpd, tpd: eff.tpd };
}

/** Is a provider within its ACCOUNT-WIDE caps (NVIDIA rpm, OpenRouter :free rpd)? */
export function withinProviderCaps(
  platform: string,
  rpmCap: number | undefined,
  rpdCap: number | undefined,
  now: number,
): boolean {
  if (rpmCap == null && rpdCap == null) return true;
  const w = windowFor(loadState().providerWindows, platform, now);
  if (rpmCap != null && w.minuteReqs >= rpmCap) return false;
  if (rpdCap != null && w.dayReqs >= rpdCap) return false;
  return true;
}

/** Reserve one request + its estimated tokens against BOTH the model and provider windows, BEFORE the
 *  call (so a burst inside one turn can't over-fire). Adjust with recordTokenDelta() once actuals are known. */
export function reserveRequest(platform: string, modelId: string, estTokens: number, now: number): void {
  const st = loadState();
  const mw = windowFor(st.windows, modelKey(platform, modelId), now);
  mw.minuteReqs += 1;
  mw.dayReqs += 1;
  mw.minuteTokens += estTokens;
  mw.dayTokens += estTokens;
  const pw = windowFor(st.providerWindows, platform, now);
  pw.minuteReqs += 1;
  pw.dayReqs += 1;
  pw.minuteTokens += estTokens;
  pw.dayTokens += estTokens;
  markDirty();
}

/** Reconcile the reserved token estimate with the real usage once the call returns (delta may be negative
 *  when the estimate over-counted). Clamped at 0 so a window can never go negative. */
export function recordTokenDelta(platform: string, modelId: string, deltaTokens: number, now: number): void {
  if (!deltaTokens) return;
  const st = loadState();
  const mw = windowFor(st.windows, modelKey(platform, modelId), now);
  mw.minuteTokens = Math.max(0, mw.minuteTokens + deltaTokens);
  mw.dayTokens = Math.max(0, mw.dayTokens + deltaTokens);
  const pw = windowFor(st.providerWindows, platform, now);
  pw.minuteTokens = Math.max(0, pw.minuteTokens + deltaTokens);
  pw.dayTokens = Math.max(0, pw.dayTokens + deltaTokens);
  markDirty();
}

// ── Cooldowns (escalation ladder 2m → 10m → 1h → 24h) ─────────────────────────
export const COOLDOWN_DURATIONS = [2 * MINUTE, 10 * MINUTE, HOUR, DAY];

export function isOnCooldown(platform: string, modelId: string, now: number): boolean {
  const cd = loadState().cooldowns[modelKey(platform, modelId)];
  return !!cd && now < cd.until;
}

/** Escalate a model's cooldown after a 429: step up the 2m→10m→1h→24h ladder if the previous cooldown was
 *  set within the last 24h, else start at 2m. An upstream Retry-After (ms) is honored as a FLOOR (never
 *  benches shorter than our heuristic, but extends up to a day when the provider asks for longer). */
export function coolDownLadder(platform: string, modelId: string, now: number, retryAfterMs?: number | null): void {
  const st = loadState();
  const key = modelKey(platform, modelId);
  const prev = st.cooldowns[key];
  const level = prev && now - prev.setAt < DAY ? Math.min(prev.level + 1, COOLDOWN_DURATIONS.length - 1) : 0;
  let dur = COOLDOWN_DURATIONS[level];
  if (retryAfterMs != null && retryAfterMs > dur) dur = Math.min(retryAfterMs, DAY);
  st.cooldowns[key] = { until: now + dur, level, setAt: now };
  markDirty();
}

/** Set a fixed-duration cooldown (402/403/404 ⇒ 24h; a transient 5xx/network ⇒ ladder level 0 = 2m). Does
 *  not escalate; used for failures whose right response is a specific, non-escalating bench. */
export function coolDownFixed(platform: string, modelId: string, durationMs: number, now: number): void {
  const st = loadState();
  const key = modelKey(platform, modelId);
  // Record a plausible ladder level so a subsequent 429 escalates from here rather than restarting at 2m.
  const level = durationMs >= DAY ? COOLDOWN_DURATIONS.length - 1 : 0;
  st.cooldowns[key] = { until: now + durationMs, level, setAt: now };
  markDirty();
}

/** The soonest active cooldown expiry (ms since epoch), or null when nothing is cooling down — for the
 *  exhaustion message's "soonest reset" hint. */
export function soonestCooldownExpiry(now: number): number | null {
  let soonest: number | null = null;
  for (const cd of Object.values(loadState().cooldowns)) {
    if (cd.until > now && (soonest == null || cd.until < soonest)) soonest = cd.until;
  }
  return soonest;
}

// ── 429 penalties (demotion in ordering; decay 1 per 2 min) ───────────────────
const PENALTY_PER_429 = 3;
const MAX_PENALTY = 10;
const DECAY_INTERVAL_MS = 2 * MINUTE;

/** Current penalty for a model, with lazy time-decay applied (pure read — does not mutate/persist). */
export function getPenalty(platform: string, modelId: string, now: number): number {
  const p = loadState().penalties[modelKey(platform, modelId)];
  if (!p) return 0;
  const steps = Math.floor((now - p.updatedAt) / DECAY_INTERVAL_MS);
  return Math.max(0, p.value - steps);
}

/** Add a 429 penalty (+3, capped at 10), applying decay first so repeated hits accumulate correctly. */
export function addPenalty(platform: string, modelId: string, now: number): void {
  const st = loadState();
  const key = modelKey(platform, modelId);
  const decayed = getPenalty(platform, modelId, now);
  st.penalties[key] = { value: Math.min(decayed + PENALTY_PER_429, MAX_PENALTY), updatedAt: now };
  markDirty();
}

// ── Self-learned limits (parse a provider 429 body; only ever LOWER) ──────────
export type LearnedLimitKind = "tpm" | "tpd" | "rpm" | "rpd";
export interface LearnedLimit {
  kind: LearnedLimitKind;
  limit: number;
}

// Per-DAY axes before per-MINUTE (so "tokens per day" isn't shadowed by the tpm word-boundary), and tokens
// before requests (a body mentioning both lands on the more specific token ceiling).
const LIMIT_AXIS_PATTERNS: Array<{ kind: LearnedLimitKind; re: RegExp }> = [
  { kind: "tpd", re: /tokens?\s*per\s*day|\btpd\b/i },
  { kind: "tpm", re: /tokens?\s*per\s*min(?:ute)?|\btpm\b/i },
  { kind: "rpd", re: /requests?\s*per\s*day|\brpd\b/i },
  { kind: "rpm", re: /requests?\s*per\s*min(?:ute)?|\brpm\b/i },
];

/** Pure parser: pull a provider-reported ceiling out of a 429 body. Returns null unless BOTH a numeric
 *  "Limit N" and a confident axis (TPM/TPD/RPM/RPD) are present — guessing the axis would mis-route every
 *  future request, so we refuse to guess. (Ported from freeapi ratelimit.parseProviderLimit.) */
export function parseProviderLimit(message: string | undefined | null): LearnedLimit | null {
  if (!message) return null;
  const m = message.match(/\blimit[:\s]+([\d,]+)/i);
  if (!m) return null;
  const limit = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  for (const { kind, re } of LIMIT_AXIS_PATTERNS) {
    if (re.test(message)) return { kind, limit };
  }
  return null;
}

/** Learn a provider-reported limit from a 429 body, persisting it ONLY when it makes us more conservative
 *  (fills an unknown axis, or lowers an existing override). Returns the learned limit when stored, else null. */
export function learnLimitFromError(
  platform: string,
  modelId: string,
  message: string | undefined,
): LearnedLimit | null {
  const parsed = parseProviderLimit(message);
  if (!parsed) return null;
  const st = loadState();
  const key = modelKey(platform, modelId);
  const cur = (st.learnedLimits[key] ??= {});
  const prev = cur[parsed.kind];
  if (prev == null || parsed.limit < prev) {
    cur[parsed.kind] = parsed.limit;
    markDirty();
    return parsed;
  }
  return null;
}

// ── Reliability + latency stats (decay-weighted counts + EWMAs) ───────────────
const STAT_HALF_LIFE_MS = 2 * DAY; // a 2-day-old observation counts half as much
const EWMA_ALPHA = 0.3; // latency/throughput smoothing

function decayCounts(s: StatState, now: number): void {
  if (!s.lastUsedAt) return;
  const w = Math.pow(0.5, Math.max(0, now - s.lastUsedAt) / STAT_HALF_LIFE_MS);
  s.succ *= w;
  s.fail *= w;
}

export function getStats(platform: string, modelId: string): StatState | undefined {
  return loadState().stats[modelKey(platform, modelId)];
}

function ensureStat(key: string): StatState {
  return (loadState().stats[key] ??= { succ: 0, fail: 0, tokPerSec: 0, ttfbMs: 0, lastUsedAt: 0 });
}

/** Record a successful call: decay-weighted +1 success, and blend the throughput/first-byte EWMAs. */
export function recordSuccessStats(
  platform: string,
  modelId: string,
  tokPerSec: number,
  ttfbMs: number | null,
  now: number,
): void {
  const s = ensureStat(modelKey(platform, modelId));
  decayCounts(s, now);
  s.succ += 1;
  if (tokPerSec > 0)
    s.tokPerSec = s.tokPerSec > 0 ? EWMA_ALPHA * tokPerSec + (1 - EWMA_ALPHA) * s.tokPerSec : tokPerSec;
  if (ttfbMs != null && ttfbMs > 0)
    s.ttfbMs = s.ttfbMs > 0 ? EWMA_ALPHA * ttfbMs + (1 - EWMA_ALPHA) * s.ttfbMs : ttfbMs;
  s.lastUsedAt = now;
  markDirty();
}

/** Record a failed call: decay-weighted +1 failure (feeds the Beta reliability posterior). */
export function recordFailStats(platform: string, modelId: string, now: number): void {
  const s = ensureStat(modelKey(platform, modelId));
  decayCounts(s, now);
  s.fail += 1;
  s.lastUsedAt = now;
  markDirty();
}

// ── Per-provider key health ─────────────────────────────────────────────────
export function getHealth(platform: string): HealthState | undefined {
  return loadState().health[platform];
}

/** Merge a patch into a provider's health record (creating it if absent) and schedule a flush. */
export function setHealth(platform: string, patch: Partial<HealthState>): void {
  const st = loadState();
  const cur = st.health[platform] ?? {
    status: "unknown" as HealthStatus,
    lastCheckedAt: 0,
    consecutiveAuthFails: 0,
    keyHash: "",
  };
  st.health[platform] = { ...cur, ...patch };
  markDirty();
}

/** A tiny non-crypto hash (FNV-1a) of a key, hex — used ONLY to detect a key CHANGE (never stored plain,
 *  never reversible). Empty for a keyless/absent key. */
export function keyHash(key: string | undefined): string {
  if (!key) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
