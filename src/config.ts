// OB-1 configuration. Kept deliberately small; session-locked values (model, effort)
// are chosen at startup to preserve prompt-cache hits (research R1).
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import type { Provider } from "./providers/types.ts";
import { profileById } from "./providers/profiles.ts";
import { validateSettings } from "./config-validate.ts";

export type Mode = "solo" | "fusion" | "council" | "personas" | "adaptive";
export type SandboxMode = "off" | "read-only" | "workspace-write";
export type QualityMode = "off" | "normal" | "strict";
/** Permission mode: "autopilot" (the default) executes mutating tools without prompting; "ask" gates each
 *  one behind an approval prompt. (Default resolved in loadConfig: autopilot unless a saved value is "ask".) */
export type PermissionMode = "ask" | "autopilot";

/** Pick provider. Precedence: explicit env (OpenRouter / OpenAI) > a provider profile configured via
 *  the /models setup flow (creds persisted in the global ~/.ob1/settings.json) > the Anthropic default.
 *  OpenRouter, OpenAI and the profiles all use the OpenAI-compatible API. */
function resolveProvider(saved: PersistedSettings): { provider: Provider; apiKey: string | undefined; baseUrl: string; model: string; providerProfile?: string } {
  const model = process.env.OB1_MODEL;
  if (process.env.OPENROUTER_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENROUTER_API_KEY, baseUrl: process.env.OB1_BASE_URL ?? "https://openrouter.ai/api/v1", model: model ?? "qwen/qwen3.6-plus" };
  }
  if (process.env.OPENAI_API_KEY && process.env.OB1_BASE_URL) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OB1_BASE_URL, model: model ?? "gpt-4o" };
  }
  if (process.env.OB1_PROVIDER === "openai" && process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY, baseUrl: "https://api.openai.com/v1", model: model ?? "gpt-4o" };
  }
  // A provider profile (e.g. FreeLLMAPI) set up via /models — creds restored from persisted settings.
  if (saved.providerProfile && saved.providerUrl && saved.providerKey) {
    const prof = profileById(saved.providerProfile);
    return { provider: "openai", apiKey: saved.providerKey, baseUrl: saved.providerUrl, model: model ?? saved.model ?? prof?.defaultModel ?? "auto", providerProfile: saved.providerProfile };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: process.env.OB1_BASE_URL ?? "https://api.anthropic.com", model: model ?? "claude-sonnet-4-6" };
  }
  // Nothing configured → route through the managed OB-1 server with the signed-in user's token (the
  // server injects the real OpenRouter key). No token yet → apiKey undefined: the app disables the
  // model and prompts `ob1 login`. Power users can still set OPENROUTER_API_KEY to go direct (above).
  return { provider: "openai", apiKey: loadAuthToken(), baseUrl: `${ob1ServerUrl()}/v1`, model: model ?? "qwen/qwen3.6-plus" };
}

export type Effort = "low" | "medium" | "high";

export interface Config {
  provider: Provider;
  /** Default model. Sonnet for most coding; escalate deliberately (R1). */
  model: string;
  /** Reasoning effort, locked at session start to preserve prompt-cache hits (R1). */
  effort?: Effort;
  apiKey: string | undefined;
  baseUrl: string;
  /** Set when the active provider was configured via the /models setup flow (e.g. "freellmapi").
   *  Gates persistence of baseUrl/apiKey: only profile creds are written to disk — never an env key. */
  providerProfile?: string;
  /** Runtime-only (never persisted): when `model` is a router alias (`auto`), the concrete model the
   *  proxy routed the LAST request to — captured from the response so the system prompt can tell the
   *  model what it actually is, instead of it parroting "auto". Updated each turn; undefined until the
   *  first response or when the model is a concrete id. */
  resolvedModel?: string;
  cwd: string;
  /** Per-workspace data dir (memory db, skills, topics, worktrees) — relative to the launch folder. */
  dataDir: string;
  /** Global settings dir (provider/model/creds/preferences) — shared across every folder you launch
   *  from, so settings are identical everywhere. Defaults to ~/.ob1; override with OB1_SETTINGS_DIR. */
  settingsDir: string;
  dbPath: string;
  /** Output-token cap. undefined ⇒ governed by the model (OpenAI-compatible omits it; Anthropic
   *  uses the model registry). Set OB1_MAX_TOKENS only to force a specific cap. */
  maxTokens?: number;
  mode: Mode;
  /** true = read-only Plan mode; false = Act mode (R6 — Cline plan/act). */
  planMode: boolean;
  /** "autopilot" (default) never prompts (executes mutating tools freely); "ask" prompts before each one. */
  permissionMode: PermissionMode;
  /** Solo auto-routing. ON → a Solo turn may escalate to a deeper mode (Fusion/Council), but ONLY when
   *  the task warrants deeper analysis (suggestMode) AND Solo fails the objective check. OFF (default) →
   *  every Solo turn stays pure Solo; nothing auto-escalates. Env override: OB1_AUTO_ROUTE=on|off. */
  autoRoute: boolean;
  /** Parallel subagents. ON (default) → a Solo turn is offered the `spawn_subagents` tool to fan out
   *  independent read-only sub-tasks in parallel (the agent decides when; read-only, so low-risk). OFF →
   *  not offered. Env override: OB1_SUBAGENTS=on|off. */
  subagents: boolean;
  /** Auto repo map. ON (default) → a fresh, budgeted codebase map is injected into every system prompt
   *  so the model always knows the structure (rebuilt after file changes). OFF → not injected (the
   *  repo_map tool still works on demand). Env override: OB1_REPO_MAP=on|off. */
  repoMap: boolean;
  /** LLM-managed memory evolution. ON → `remember()` consolidates a new fact against its nearest
   *  neighbors (ADD/UPDATE/DELETE/NOOP) instead of blindly appending — costs one cheap LLM call per
   *  write, so OFF by default (opt-in). Env override: OB1_MEM_EVOLVE=on|off. */
  memEvolve: boolean;
  /** Reflection trees. ON → after enough salient facts accumulate, the agent distils them into
   *  higher-level "reflection" facts (item #6). Costs an LLM call only when the threshold trips; OFF by
   *  default (opt-in). Env override: OB1_MEM_REFLECT=on|off. */
  memReflect: boolean;
  /** Agentic auto-linking. ON → the evolution call also proposes bounded related-memory links (item #7).
   *  Rides the same LLM call, so it only takes effect when memEvolve is also ON. OFF by default. Env
   *  override: OB1_MEM_AUTOLINK=on|off. */
  memAutolink: boolean;
  /** Automatic skill learning. ON → after a substantive turn the agent distils the transcript into a
   *  reusable skill (create/update under .ob1/skills) via one cheap LLM call. Costs a call per
   *  substantive turn, so OFF by default (opt-in). Env override: OB1_SKILL_LEARN=on|off. */
  skillLearn: boolean;
  /** Per-task quality layer. normal (default) injects a compact contract + records .ob1/runs evidence;
   *  strict additionally blocks "completed" status in the ledger when required evidence is missing. */
  qualityMode: QualityMode;
  /** OS sandbox for run_bash (defense-in-depth). off | read-only | workspace-write. */
  sandbox: SandboxMode;
  /** Checkpointing for /rewind. ON (default) → before each prompt the whole worktree is snapshotted to a
   *  SHADOW git repo (separate git dir; never touches your real .git), so /rewind can revert code and/or
   *  conversation to an earlier prompt. Cheap + local. OFF → no snapshots. Env override: OB1_CHECKPOINT=on|off. */
  checkpoint: boolean;
  /** Web-search backend (SearXNG JSON API). Defaults to the shared baked-in endpoint so `web_search`
   *  works out of the box; the key is sent as the `X-API-Key` header. Override with OB1_SEARXNG_URL /
   *  OB1_SEARXNG_KEY, or set OB1_SEARXNG_URL="" to disable web_search. */
  searxngUrl?: string;
  searxngKey?: string;
  /** true → the search backend is the managed OB-1 server (authenticate with Bearer <token>);
   *  false/undefined → a direct SearXNG instance (authenticate with the X-API-Key header). */
  searxngBearer?: boolean;
}

// ─── persisted settings (survive restarts) ───────────────────────────────────
// The user-changeable subset is saved to the GLOBAL ~/.ob1/settings.json so /model, /mode, /sandbox,
// /settings, etc. are remembered across sessions AND identical no matter which folder you launch from.
// Precedence on load:  explicit env var (OB1_*)  >  persisted value  >  built-in default.
export interface PersistedSettings {
  provider?: Provider;          // guards the model: a saved model only applies under the same provider
  model?: string;
  mode?: Mode;
  planMode?: boolean;
  autoRoute?: boolean;
  subagents?: boolean;
  repoMap?: boolean;
  memEvolve?: boolean;
  memReflect?: boolean;
  memAutolink?: boolean;
  skillLearn?: boolean;
  qualityMode?: QualityMode;
  permissionMode?: PermissionMode;
  sandbox?: SandboxMode;
  checkpoint?: boolean;
  effort?: Effort;
  // A provider configured via the /models setup flow. Creds live here (the file is gitignored) so the
  // provider survives restarts without re-entry; an explicit env key always takes precedence on load.
  // The single tuple names the ACTIVE provider (what resolveProvider restores on next launch).
  providerProfile?: string;     // e.g. "freellmapi" | "openrouter"
  providerUrl?: string;         // the active provider base URL (…/v1)
  providerKey?: string;         // the active provider bearer token
  // Per-provider credential memory, keyed by profile id. Remembers EVERY configured provider's URL+key
  // so switching between the free proxy and a paid provider (OpenRouter) from /models never needs
  // re-entry. The active provider above is one of these entries.
  providerCreds?: Record<string, { url: string; key: string }>;
}

const SETTINGS_FILE = "settings.json";
const MODES: Mode[] = ["solo", "fusion", "council", "personas", "adaptive"];
const SANDBOXES: SandboxMode[] = ["off", "read-only", "workspace-write"];
const QUALITY_MODES: QualityMode[] = ["off", "normal", "strict"];

/** Parse OB1_MAX_TOKENS to a positive integer, or undefined (let the provider pick its own cap). A
 *  malformed value must NOT become NaN — that 400s the Anthropic API on every request. */
function maxTokensFromEnv(): number | undefined {
  const n = Number(process.env.OB1_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The managed OB-1 backend holds the REAL provider keys (OpenRouter for models, SearXNG for search)
// and proxies every request per signed-in user. THE SINGLE SOURCE OF TRUTH for the server URL is this
// constant (everything goes through ob1ServerUrl()). We're in local dev, so it points at the local
// server; set OB1_SERVER to override (e.g. the deployed origin in production).
const DEFAULT_OB1_SERVER = "http://localhost:8787";
const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1"; // public; used only by the BYOK env path

/** Base origin of the managed OB-1 server (no trailing slash). Override with OB1_SERVER. */
export function ob1ServerUrl(): string {
  return (process.env.OB1_SERVER ?? DEFAULT_OB1_SERVER).replace(/\/$/, "");
}

/** The signed-in user's OB-1 token for the managed proxy. Precedence: OB1_TOKEN env > ~/.ob1/auth.json.
 *  undefined when not logged in (the app then disables the model and prompts `ob1 login`). */
export function loadAuthToken(settingsDir = globalSettingsDir()): string | undefined {
  if (process.env.OB1_TOKEN) return process.env.OB1_TOKEN;
  try {
    const j = JSON.parse(readFileSync(join(settingsDir, "auth.json"), "utf8")) as { token?: string };
    return j.token || undefined;
  } catch { return undefined; }
}

/** Where global settings live. ~/.ob1 by default so they're shared across every launch folder;
 *  OB1_SETTINGS_DIR overrides it (used by tests, and handy for relocating the config). */
export function globalSettingsDir(): string {
  return process.env.OB1_SETTINGS_DIR || join(homedir(), ".ob1");
}

function loadPersisted(dir: string): PersistedSettings {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));
    // Schema-validate: drop any invalid field (a hand-edited sandbox:"yolo" must fall back to the
    // default, not silently mis-apply) and ignore unknown keys. Errors are surfaced by `settingsHealth`.
    return validateSettings(raw).value;
  }
  catch { return {}; } // missing / unreadable / corrupt → fall back to defaults
}

/** Validate the on-disk settings WITHOUT applying — for a /doctor-style startup check. Returns the
 *  structured report (clean when the file is missing or fully valid). */
export function settingsHealth(dir: string): ReturnType<typeof validateSettings> {
  let raw: unknown = {};
  try { raw = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8")); } catch { return validateSettings({}); }
  return validateSettings(raw);
}

/** Write settings.json with OWNER-ONLY perms — it holds provider API keys (providerKey / providerCreds).
 *  mode on create handles fresh installs; the explicit chmod also re-tightens a pre-existing file that an
 *  older build left world-readable (0o644). chmod is best-effort (no-op semantics differ on Windows). */
function writeSettingsFile(dir: string, data: PersistedSettings): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, SETTINGS_FILE);
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* perms are best-effort */ }
}

/** Persist the user-changeable settings. Best-effort — never throws (a failed write must not break a turn). */
export function saveSettings(cfg: Config): void {
  const data: PersistedSettings = {
    provider: cfg.provider, model: cfg.model, mode: cfg.mode, planMode: cfg.planMode,
    autoRoute: cfg.autoRoute, subagents: cfg.subagents, repoMap: cfg.repoMap, memEvolve: cfg.memEvolve, memReflect: cfg.memReflect, memAutolink: cfg.memAutolink, skillLearn: cfg.skillLearn, qualityMode: cfg.qualityMode, permissionMode: cfg.permissionMode, sandbox: cfg.sandbox, checkpoint: cfg.checkpoint, effort: cfg.effort,
  };
  // Provider creds. The single tuple (providerProfile/Url/Key) names the ACTIVE provider; the
  // providerCreds map remembers EVERY configured provider so switching free⇄paid needs no re-entry.
  const prev = loadPersisted(cfg.settingsDir);
  // GLOBAL settings (~/.ob1) are the ONLY source of truth. We no longer fall back to a per-workspace
  // <cwd>/.ob1 file: that legacy migration kept resurrecting stale provider URLs (e.g. an old remote
  // FreeLLMAPI host) into the global config. FreeLLMAPI is self-hosted/local, set up fresh via /models.
  const legacy = prev;
  const creds: Record<string, { url: string; key: string }> = { ...(prev.providerCreds ?? {}) };
  // Fold any legacy single-tuple into the map (back-compat for files written before the map existed).
  if (legacy.providerProfile && legacy.providerUrl && legacy.providerKey && !creds[legacy.providerProfile]) {
    creds[legacy.providerProfile] = { url: legacy.providerUrl, key: legacy.providerKey };
  }
  if (cfg.providerProfile && cfg.apiKey) {
    // This session's provider IS a configured profile → record it as active AND remember it in the map.
    creds[cfg.providerProfile] = { url: cfg.baseUrl, key: cfg.apiKey };
    data.providerProfile = cfg.providerProfile; data.providerUrl = cfg.baseUrl; data.providerKey = cfg.apiKey;
  } else if (legacy.providerProfile) {
    // Env-override session (no profile): carry forward the active provider so it survives.
    data.providerProfile = legacy.providerProfile; data.providerUrl = legacy.providerUrl; data.providerKey = legacy.providerKey;
  }
  if (Object.keys(creds).length) data.providerCreds = creds;
  try { writeSettingsFile(cfg.settingsDir, data); }
  catch { /* best-effort persistence */ }
}

/** Whether a persisted settings file exists (for a "settings restored" startup note). */
export function hasPersistedSettings(settingsDir: string): boolean {
  try { readFileSync(join(settingsDir, SETTINGS_FILE), "utf8"); return true; } catch { return false; }
}

/** Raw persisted settings (pre-migration) — used at boot to show the one-time adaptive→Solo note. */
export function persistedSettings(settingsDir: string): PersistedSettings { return loadPersisted(settingsDir); }

/** Persist a configured provider's creds as the ACTIVE provider (and remember it in the per-provider
 *  map) WITHOUT a full Config — used by the FreeLLMAPI manager to AUTO-WIRE the proxy it just started,
 *  so the user never enters a URL/key. Merges into settings.json (other prefs untouched); loadConfig's
 *  resolveProvider then restores it on the next launch. */
/** Switch the active provider to the managed OB-1 server (the paid SUBSCRIPTION path) with a default
 *  flagship model. Clears any provider PROFILE (e.g. FreeLLMAPI) so resolveProvider falls through to the
 *  server route (token + ${OB1_SERVER}/v1); keeps the per-provider cred memory. Chat then bills credits. */
export function persistSubscription(settingsDir: string, model: string): void {
  const prev = loadPersisted(settingsDir);
  const data: PersistedSettings = { ...prev, provider: "openai", model, providerProfile: undefined, providerUrl: undefined, providerKey: undefined };
  try { writeSettingsFile(settingsDir, data); }
  catch { /* best-effort persistence */ }
}

export function persistActiveProvider(settingsDir: string, profile: string, url: string, key: string): void {
  const prev = loadPersisted(settingsDir);
  const creds: Record<string, { url: string; key: string }> = { ...(prev.providerCreds ?? {}) };
  creds[profile] = { url, key };
  const data: PersistedSettings = { ...prev, providerProfile: profile, providerUrl: url, providerKey: key, providerCreds: creds };
  try { writeSettingsFile(settingsDir, data); }
  catch { /* best-effort persistence */ }
}

/** The shipped, baked-in credentials for a provider (currently OpenRouter, so the paid flagship models
 *  work without the user entering a key). Returns undefined for providers the user must configure
 *  themselves (e.g. the self-hosted FreeLLMAPI proxy). An env OPENROUTER_API_KEY overrides the key. */
export function bakedProviderCreds(profileId: string): { url: string; key: string } | undefined {
  // No secrets ship in the client anymore. OpenRouter is BYOK from /models: offer baked creds only
  // when the user has exported their own OPENROUTER_API_KEY. (The shared key lives in the OB-1 server.)
  if (profileId === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return { url: DEFAULT_OPENROUTER_URL, key: process.env.OPENROUTER_API_KEY };
  }
  return undefined;
}

/** Every configured provider's remembered creds, keyed by profile id. Used by the /models picker to
 *  switch free⇄paid without re-prompting for a key already entered. Folds the legacy single tuple in
 *  for back-compat with settings files written before the per-provider map existed. */
export function savedProviderCreds(settingsDir: string): Record<string, { url: string; key: string }> {
  const s = loadPersisted(settingsDir);
  const map: Record<string, { url: string; key: string }> = { ...(s.providerCreds ?? {}) };
  if (s.providerProfile && s.providerUrl && s.providerKey && !map[s.providerProfile]) {
    map[s.providerProfile] = { url: s.providerUrl, key: s.providerKey };
  }
  return map;
}

/** Whether the active endpoint is OpenRouter — directly (openrouter.ai) or via the managed OB-1 server,
 *  which forwards the request body verbatim to OpenRouter. Those take the unified `reasoning` param. A
 *  configured provider PROFILE (FreeLLMAPI) or a direct api.openai.com endpoint is plain OpenAI-compatible
 *  and takes the legacy `reasoning_effort` instead. */
export function isOpenRouterEndpoint(cfg: Pick<Config, "provider" | "baseUrl" | "providerProfile">): boolean {
  if (cfg.provider !== "openai") return false;        // direct Anthropic Messages API
  if (cfg.providerProfile) return false;              // a /models profile (FreeLLMAPI) → plain OpenAI wire
  if (/\bapi\.openai\.com\b/i.test(cfg.baseUrl)) return false; // direct OpenAI BYOK
  return true;                                        // managed OB-1 server (→OpenRouter) or direct openrouter.ai
}

export function loadConfig(): Config {
  const cwd = process.cwd();
  const dataDir = join(cwd, ".ob1");
  const settingsDir = globalSettingsDir();
  const saved = loadPersisted(settingsDir);
  // NOTE: settings come ONLY from the global dir (~/.ob1). We intentionally do NOT migrate/adopt a
  // per-workspace <cwd>/.ob1/settings.json. That old migration kept resurrecting stale provider configs
  // (e.g. an old remote FreeLLMAPI URL) into a freshly-reset global config every time `ob1` ran from a
  // folder that still had a legacy .ob1. The workspace .ob1 is now used only for memory.db, not settings.
  const p = resolveProvider(saved);
  const sameProvider = saved.provider === p.provider;
  // model: OB1_MODEL (already folded into p.model) wins; else the saved model when the provider matches.
  const model = process.env.OB1_MODEL ? p.model : (sameProvider && saved.model ? saved.model : p.model);
  const effortRaw = (process.env.OB1_EFFORT as Effort | undefined) ?? saved.effort;
  const envPerm = process.env.OB1_PERMISSION === "autopilot" ? "autopilot" : process.env.OB1_PERMISSION === "ask" ? "ask" : undefined;
  const envAutoRoute = /^(1|true|on)$/i.test(process.env.OB1_AUTO_ROUTE ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_AUTO_ROUTE ?? "") ? false : undefined;
  const envSubagents = /^(1|true|on)$/i.test(process.env.OB1_SUBAGENTS ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_SUBAGENTS ?? "") ? false : undefined;
  const envRepoMap = /^(1|true|on)$/i.test(process.env.OB1_REPO_MAP ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_REPO_MAP ?? "") ? false : undefined;
  const envMemEvolve = /^(1|true|on)$/i.test(process.env.OB1_MEM_EVOLVE ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_MEM_EVOLVE ?? "") ? false : undefined;
  const envMemReflect = /^(1|true|on)$/i.test(process.env.OB1_MEM_REFLECT ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_MEM_REFLECT ?? "") ? false : undefined;
  const envMemAutolink = /^(1|true|on)$/i.test(process.env.OB1_MEM_AUTOLINK ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_MEM_AUTOLINK ?? "") ? false : undefined;
  const envSkillLearn = /^(1|true|on)$/i.test(process.env.OB1_SKILL_LEARN ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_SKILL_LEARN ?? "") ? false : undefined;
  const envQualityMode = QUALITY_MODES.includes(process.env.OB1_QUALITY as QualityMode) ? process.env.OB1_QUALITY as QualityMode : undefined;
  const envCheckpoint = /^(1|true|on)$/i.test(process.env.OB1_CHECKPOINT ?? "") ? true
    : /^(0|false|off)$/i.test(process.env.OB1_CHECKPOINT ?? "") ? false : undefined;
  // Migration: `adaptive` is retired as an interactive mode — it's now the off-by-default Solo
  // auto-route toggle. Collapse ANY persisted adaptive workspace to Solo; a deliberate autoRoute:true
  // is preserved independently below, so "Solo + auto-route on" reproduces the old adaptive behaviour.
  let mode: Mode = saved.mode && MODES.includes(saved.mode) ? saved.mode : "solo";
  if (mode === "adaptive") mode = "solo";
  return {
    provider: p.provider,
    model,
    // Default reasoning effort is MEDIUM (a balanced thinking budget) — OB1_EFFORT / a saved value
    // override it, changeable live via /effort. Ignored by non-reasoning models. Session-locked at
    // start so the prompt-cache prefix stays stable (R1); /effort deliberately re-locks it.
    effort: effortRaw && ["low", "medium", "high"].includes(effortRaw) ? effortRaw : "medium",
    apiKey: p.apiKey,
    baseUrl: p.baseUrl,
    providerProfile: p.providerProfile,
    cwd,
    dataDir,
    settingsDir,
    dbPath: join(dataDir, "memory.db"),
    // Guard against a non-numeric OB1_MAX_TOKENS (e.g. "8k"): Number("8k") is NaN, and NaN flows to the
    // Anthropic body as max_tokens (NaN ?? x === NaN), 400ing every request. Only accept a positive number.
    maxTokens: maxTokensFromEnv(),
    mode,
    planMode: saved.planMode ?? false,
    autoRoute: envAutoRoute ?? saved.autoRoute ?? false,
    subagents: envSubagents ?? saved.subagents ?? true,
    repoMap: envRepoMap ?? saved.repoMap ?? true,
    memEvolve: envMemEvolve ?? saved.memEvolve ?? false,
    memReflect: envMemReflect ?? saved.memReflect ?? false,
    memAutolink: envMemAutolink ?? saved.memAutolink ?? false,
    skillLearn: envSkillLearn ?? saved.skillLearn ?? false,
    qualityMode: envQualityMode ?? (saved.qualityMode && QUALITY_MODES.includes(saved.qualityMode) ? saved.qualityMode : "normal"),
    permissionMode: envPerm ?? (saved.permissionMode === "ask" ? "ask" : "autopilot"),
    sandbox: (process.env.OB1_SANDBOX as SandboxMode | undefined) ?? (saved.sandbox && SANDBOXES.includes(saved.sandbox) ? saved.sandbox : "off"),
    checkpoint: envCheckpoint ?? saved.checkpoint ?? true,
    // Default: route web_search through the managed OB-1 server (Bearer-authenticated; the paid-tier
    // gate lives server-side). Set OB1_SEARXNG_URL to hit a SearXNG instance directly (X-API-Key auth).
    searxngUrl: process.env.OB1_SEARXNG_URL ?? `${ob1ServerUrl()}/v1/search`,
    // The OB-1 token is only a valid credential for the MANAGED default endpoint. When the user points at
    // their OWN SearXNG (OB1_SEARXNG_URL) without a key, don't leak the OB-1 bearer token to that 3rd-party
    // host (and it wouldn't authenticate there anyway) — fall back to no key instead.
    searxngKey: process.env.OB1_SEARXNG_KEY ?? (process.env.OB1_SEARXNG_URL ? undefined : loadAuthToken()),
    searxngBearer: !process.env.OB1_SEARXNG_URL,
  };
}
