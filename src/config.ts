// OB-1 configuration. Kept deliberately small; session-locked values (model, effort)
// are chosen at startup to preserve prompt-cache hits (research R1).
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import type { Provider } from "./providers/types.ts";
import { normalizeBaseUrl, profileById } from "./providers/profiles.ts";
import { validateSettings } from "./config-validate.ts";

export type Mode = "solo" | "fusion";
export type SandboxMode = "off" | "read-only" | "workspace-write";
export type QualityMode = "off" | "normal" | "strict";
/** Routing strategy for the embedded free-models router (src/providers/free). Kept as a local string union
 *  so config.ts has no runtime import of the free module (avoids an import cycle: free/index imports config). */
export type FreeStrategy = "priority" | "balanced" | "smartest" | "fastest" | "reliable";
const FREE_STRATEGIES: FreeStrategy[] = ["priority", "balanced", "smartest", "fastest", "reliable"];
/** Permission mode: "autopilot" (the default) executes mutating tools without prompting; "ask" gates each
 *  one behind an approval prompt. (Default resolved in loadConfig: autopilot unless a saved value is "ask".) */
export type PermissionMode = "ask" | "autopilot";

export interface EnvProviderRoute {
  source: string;
  label: string;
  provider: Provider;
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  openrouter?: boolean;
}

export function envRouteIsExplicitOverride(route: EnvProviderRoute | undefined): boolean {
  return !!route && route.source.startsWith("OB1_BASE_URL");
}

function envVal(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Runtime-only provider routes from well-known environment variables. These never get written to
 *  settings.json; they are for "export a key and run ob1" workflows. Precedence is explicit generic
 *  OB1_BASE_URL/OB1_API_KEY first, then named hosted providers. Only OB1_BASE_URL is an explicit
 *  override; named provider keys are convenience routes when no saved provider or subscription exists. */
export function detectEnvProvider(env: NodeJS.ProcessEnv = process.env): EnvProviderRoute | undefined {
  const model = envVal(env, "OB1_MODEL");
  const ob1Base = envVal(env, "OB1_BASE_URL");
  const ob1Key = envVal(env, "OB1_API_KEY");
  if (ob1Base) {
    return {
      source: ob1Key ? "OB1_BASE_URL + OB1_API_KEY" : "OB1_BASE_URL",
      label: "Custom endpoint from OB1_BASE_URL",
      provider: "openai",
      apiKey: ob1Key,
      baseUrl: normalizeBaseUrl(ob1Base),
      model: model ?? "auto",
    };
  }

  const openRouter = envVal(env, "OPENROUTER_API_KEY");
  if (openRouter) {
    return {
      source: "OPENROUTER_API_KEY",
      label: "OpenRouter",
      provider: "openai",
      apiKey: openRouter,
      baseUrl: "https://openrouter.ai/api/v1",
      model: model ?? "qwen/qwen3.6-plus",
      openrouter: true,
    };
  }

  const openAI = envVal(env, "OPENAI_API_KEY");
  if (openAI) {
    return {
      source: "OPENAI_API_KEY",
      label: "OpenAI",
      provider: "openai",
      apiKey: openAI,
      baseUrl: "https://api.openai.com/v1",
      model: model ?? "gpt-4o-mini",
    };
  }

  const gemini = envVal(env, "GEMINI_API_KEY") ?? envVal(env, "GOOGLE_API_KEY");
  if (gemini) {
    return {
      source: envVal(env, "GEMINI_API_KEY") ? "GEMINI_API_KEY" : "GOOGLE_API_KEY",
      label: "Gemini",
      provider: "openai",
      apiKey: gemini,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: model ?? "gemini-2.5-pro",
    };
  }

  const groq = envVal(env, "GROQ_API_KEY");
  if (groq) {
    return {
      source: "GROQ_API_KEY",
      label: "Groq",
      provider: "openai",
      apiKey: groq,
      baseUrl: "https://api.groq.com/openai/v1",
      model: model ?? "llama-3.3-70b-versatile",
    };
  }

  return undefined;
}

/** Pick provider. Supported model routes:
 *  1. explicit runtime override (`OB1_BASE_URL`, optionally `OB1_API_KEY`),
 *  2. a provider profile configured via /models (the embedded Free models router, local presets, Custom API),
 *  3. the managed OB-1 server subscription route, where the server injects upstream keys,
 *  4. named env provider keys (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`)
 *     when nothing more deliberate is configured. */
function resolveProvider(saved: PersistedSettings): {
  provider: Provider;
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  providerProfile?: string;
  envProviderSource?: string;
} {
  const model = process.env.OB1_MODEL?.trim() || undefined;
  const envRoute = detectEnvProvider();
  if (envRoute && envRouteIsExplicitOverride(envRoute)) {
    return {
      provider: envRoute.provider,
      apiKey: envRoute.apiKey,
      baseUrl: envRoute.baseUrl,
      model: model ?? envRoute.model,
      envProviderSource: envRoute.source,
    };
  }
  // The embedded free-models router: no URL/key to restore — the wire provider is "free" (callFree routes
  // in-process across free-tier providers via the keys file). Checked before the URL-bearing profile branch
  // below because "free" has no providerUrl. Default model "auto" ⇒ strategy routing.
  if (saved.providerProfile === "free") {
    return {
      provider: "free",
      apiKey: undefined,
      baseUrl: "",
      model: model ?? saved.model ?? "auto",
      providerProfile: "free",
    };
  }
  // A URL-bearing provider profile (e.g. a named preset, or a bring-your-own Custom endpoint) set up via /models — creds
  // restored from persisted settings. The KEY is optional (a keyless Custom/LAN endpoint persists an empty
  // string), so a profile is restored on URL alone; apiKey stays undefined when no key was saved.
  const prof = profileById(saved.providerProfile);
  if (prof && saved.providerUrl) {
    return {
      provider: "openai",
      apiKey: saved.providerKey || undefined,
      baseUrl: saved.providerUrl,
      model: model ?? saved.model ?? prof?.defaultModel ?? "auto",
      providerProfile: saved.providerProfile,
    };
  }
  const token = loadAuthToken();
  if (token) {
    return { provider: "openai", apiKey: token, baseUrl: `${ob1ServerUrl()}/v1`, model: model ?? "qwen/qwen3.6-plus" };
  }
  if (envRoute) {
    return {
      provider: envRoute.provider,
      apiKey: envRoute.apiKey,
      baseUrl: envRoute.baseUrl,
      model: model ?? envRoute.model,
      envProviderSource: envRoute.source,
    };
  }
  // Nothing configured → route through the managed OB-1 server with the signed-in user's token (the
  // server injects the upstream key). No token yet → apiKey undefined: the app disables model calls and
  // prompts `ob1 onboard` or /models for Free models / BYOK / Custom API.
  return {
    provider: "openai",
    apiKey: undefined,
    baseUrl: `${ob1ServerUrl()}/v1`,
    model: model ?? "qwen/qwen3.6-plus",
  };
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
  /** Set when the active provider was configured via the /models setup flow (e.g. "free", "custom").
   *  Gates persistence of baseUrl/apiKey: only profile creds are written to disk — never an env key. */
  providerProfile?: string;
  /** Runtime-only env route source when an env provider is active; never persisted. */
  envProviderSource?: string;
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
  /** Output-token cap. undefined ⇒ governed by the model on the OpenAI-compatible route. Set
   *  OB1_MAX_TOKENS only to force a specific cap. */
  maxTokens?: number;
  /** Routing strategy for the embedded free-models router (priority|balanced|smartest|fastest|reliable).
   *  Default "balanced". Read by src/providers/free at call time; surfaced/changed by the phase-2 UX. */
  freeStrategy: FreeStrategy;
  mode: Mode;
  /** true = read-only Plan mode; false = Act mode (R6 — Cline plan/act). */
  planMode: boolean;
  /** "autopilot" never prompts (executes mutating tools freely); "ask" prompts before each one. The
   *  built-in default is autopilot, but a FIRST-RUN session in an UNTRUSTED folder is downgraded to "ask"
   *  by the trust gate (index.ts) — see permissionModeExplicit. */
  permissionMode: PermissionMode;
  /** Whether permissionMode was set EXPLICITLY (OB1_PERMISSION env, or any saved settings value) rather
   *  than left at the built-in default. The trust gate downgrades only an IMPLICIT autopilot in an
   *  untrusted folder, so a user who explicitly chose autopilot keeps it. Runtime-only (never persisted). */
  permissionModeExplicit: boolean;
  /** Parallel subagents. ON (default) → a Solo turn is offered the `spawn_subagents` tool to fan out
   *  independent read-only sub-tasks in parallel (the agent decides when; read-only, so low-risk). OFF →
   *  not offered. Env override: OB1_SUBAGENTS=on|off. */
  subagents: boolean;
  /** Verified escalation. ON (default) → when a Solo turn's auto-verify self-fix loop STILL fails after
   *  its round budget, the turn escalates to Fusion best-of-N with the failure report as context (so
   *  candidates FIX rather than restart). The objective SIGNAL decides this, not an LLM — no extra model
   *  call to route. OFF → never escalate; the changes are left for the user to review (the legacy
   *  behavior). Forced off on apply turns + Plan mode. Env override: OB1_ESCALATION=on|off. */
  escalation: boolean;
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
  /** Web-search backend. By DEFAULT `web_search` routes through the MANAGED OB-1 server
   *  (`${ob1ServerUrl()}/v1/search`), authenticated with the signed-in Bearer token — the paid-tier gate
   *  lives server-side (nothing is baked into the client). Point OB1_SEARXNG_URL at your OWN SearXNG
   *  instance to hit it directly (authenticated with the `X-API-Key` header from OB1_SEARXNG_KEY); set
   *  OB1_SEARXNG_URL="" to disable web_search. See searxngBearer for which auth header is used. */
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
  provider?: Provider; // guards the model: a saved model only applies under the same provider
  model?: string;
  mode?: Mode;
  planMode?: boolean;
  subagents?: boolean;
  escalation?: boolean;
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
  /** Routing strategy for the embedded free-models router (default "balanced"). */
  freeStrategy?: FreeStrategy;
  // A provider configured via the /models setup flow. Creds live here (the file is gitignored) so the
  // provider survives restarts without re-entry. Direct provider env keys are not model routes.
  // The single tuple names the ACTIVE provider (what resolveProvider restores on next launch).
  providerProfile?: string; // e.g. "free" | "ollama" | "custom"
  providerUrl?: string; // the active provider base URL (…/v1)
  providerKey?: string; // the active provider bearer token
  // Per-provider credential memory, keyed by profile id. Remembers EVERY configured provider's URL+key
  // so switching between providers from /models never needs re-entry. The active
  // provider above is one of these entries.
  providerCreds?: Record<string, { url: string; key: string }>;
}

const SETTINGS_FILE = "settings.json";
const MODES: Mode[] = ["solo", "fusion"];
const SANDBOXES: SandboxMode[] = ["off", "read-only", "workspace-write"];
const QUALITY_MODES: QualityMode[] = ["off", "normal", "strict"];

/** Parse OB1_MAX_TOKENS to a positive integer, or undefined (let the provider pick its own cap). A
 *  malformed value must NOT become NaN and leak into provider request bodies. */
function maxTokensFromEnv(): number | undefined {
  const n = Number(process.env.OB1_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The managed OB-1 backend holds the REAL provider keys (OpenRouter for models, SearXNG for search)
// and proxies every request per signed-in user. THE SINGLE SOURCE OF TRUTH for the server URL is this
// constant (everything goes through ob1ServerUrl()). Defaults to the managed PRODUCTION server so a
// fresh install works out of the box. OB1_SERVER can point at a remote self-hosted server; localhost
// overrides require OB1_ALLOW_LOCAL_SERVER=1 so stale shell exports do not break installed CLIs.
const DEFAULT_OB1_SERVER = "https://ob1-api.overbrilliant.com";

function allowLocalOb1Server(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.OB1_ALLOW_LOCAL_SERVER ?? "");
}

function isLoopbackServer(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || host === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export function ignoredLocalOb1ServerOverride(): string | undefined {
  const raw = process.env.OB1_SERVER?.trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/\/+$/, "");
  return isLoopbackServer(normalized) && !allowLocalOb1Server() ? normalized : undefined;
}

/** Base origin of the managed OB-1 server (no trailing slash). Override with OB1_SERVER. */
export function ob1ServerUrl(): string {
  const raw = process.env.OB1_SERVER?.trim();
  if (!raw) return DEFAULT_OB1_SERVER;
  const normalized = raw.replace(/\/+$/, "");
  return ignoredLocalOb1ServerOverride() ? DEFAULT_OB1_SERVER : normalized;
}

/** The signed-in user's OB-1 token for the managed proxy. Precedence: OB1_TOKEN env > ~/.ob1/auth.json.
 *  undefined when not logged in (the app then disables the model and prompts `ob1 login`). */
export function loadAuthToken(settingsDir = globalSettingsDir()): string | undefined {
  if (process.env.OB1_TOKEN) return process.env.OB1_TOKEN;
  try {
    const j = JSON.parse(readFileSync(join(settingsDir, "auth.json"), "utf8")) as { token?: string };
    return j.token || undefined;
  } catch {
    return undefined;
  }
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
    return migrateFreellmapiToFree(dir, validateSettings(raw).value);
  } catch {
    return {};
  } // missing / unreadable / corrupt → fall back to defaults
}

/** One-time migration: the old self-hosted FreeLLMAPI proxy profile is replaced by the embedded free-models
 *  router. Rewrite a persisted providerProfile "freellmapi" to "free" (model "auto") and persist the rewrite
 *  best-effort, so an existing user lands on the in-process router on the next launch without re-setup. */
function migrateFreellmapiToFree(dir: string, s: PersistedSettings): PersistedSettings {
  if (s.providerProfile !== "freellmapi") return s;
  // The embedded router has no URL/key of its own (it routes in-process); clear the stale FreeLLMAPI proxy
  // endpoint + token so they don't linger in settings.json (matching a fresh `free` activation, which
  // persists providerUrl:""/providerKey:"").
  const migrated: PersistedSettings = { ...s, providerProfile: "free", model: "auto", providerUrl: "", providerKey: "" };
  try {
    writeSettingsFile(dir, migrated);
  } catch {
    /* best-effort — routing still uses the in-memory rewrite */
  }
  return migrated;
}

/** Validate the on-disk settings WITHOUT applying — for a /doctor-style startup check. Returns the
 *  structured report (clean when the file is missing or fully valid). */
export function settingsHealth(dir: string): ReturnType<typeof validateSettings> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));
  } catch {
    return validateSettings({});
  }
  return validateSettings(raw);
}

/** Write settings.json with OWNER-ONLY perms — it holds provider API keys (providerKey / providerCreds).
 *  mode on create handles fresh installs; the explicit chmod also re-tightens a pre-existing file that an
 *  older build left world-readable (0o644). chmod is best-effort (no-op semantics differ on Windows). */
function writeSettingsFile(dir: string, data: PersistedSettings): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, SETTINGS_FILE);
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* perms are best-effort */
  }
}

function envSet(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

/** Persist the user-changeable settings. Best-effort — never throws (a failed write must not break a turn). */
export function saveSettings(cfg: Config): void {
  const prev = loadPersisted(cfg.settingsDir);
  // Both the OpenAI-compatible route and the embedded free router persist the active model (the free router
  // stores "auto"/a pin); an env route does not.
  const supportedProvider = cfg.provider === "openai" || cfg.provider === "free";
  const envRoute = detectEnvProvider();
  const envActive =
    !!envRoute &&
    cfg.provider === envRoute.provider &&
    cfg.baseUrl === envRoute.baseUrl &&
    (cfg.apiKey ?? "") === (envRoute.apiKey ?? "");
  const data: PersistedSettings = {
    provider: cfg.provider === "free" ? "free" : "openai",
    model: envActive || envSet("OB1_MODEL") ? prev.model : supportedProvider ? cfg.model : prev.model,
    mode: cfg.mode,
    planMode: cfg.planMode,
    subagents: envSet("OB1_SUBAGENTS") ? prev.subagents : cfg.subagents,
    escalation: envSet("OB1_ESCALATION") ? prev.escalation : cfg.escalation,
    repoMap: envSet("OB1_REPO_MAP") ? prev.repoMap : cfg.repoMap,
    memEvolve: envSet("OB1_MEM_EVOLVE") ? prev.memEvolve : cfg.memEvolve,
    memReflect: envSet("OB1_MEM_REFLECT") ? prev.memReflect : cfg.memReflect,
    memAutolink: envSet("OB1_MEM_AUTOLINK") ? prev.memAutolink : cfg.memAutolink,
    skillLearn: envSet("OB1_SKILL_LEARN") ? prev.skillLearn : cfg.skillLearn,
    qualityMode: envSet("OB1_QUALITY") ? prev.qualityMode : cfg.qualityMode,
    permissionMode: envSet("OB1_PERMISSION") ? prev.permissionMode : cfg.permissionMode,
    sandbox: envSet("OB1_SANDBOX") ? prev.sandbox : cfg.sandbox,
    checkpoint: envSet("OB1_CHECKPOINT") ? prev.checkpoint : cfg.checkpoint,
    effort: envSet("OB1_EFFORT") ? prev.effort : cfg.effort,
    freeStrategy: envSet("OB1_FREE_STRATEGY") ? prev.freeStrategy : cfg.freeStrategy,
  };
  // Provider creds. The single tuple (providerProfile/Url/Key) names the ACTIVE provider; the
  // providerCreds map remembers EVERY configured provider so switching between providers needs no
  // re-entry.
  // GLOBAL settings (~/.ob1) are the ONLY source of truth. We no longer fall back to a per-workspace
  // <cwd>/.ob1 file: that legacy migration kept resurrecting stale provider URLs (e.g. an old remote
  // provider host) into the global config. Providers are set up fresh via /models.
  const legacy = prev;
  const creds: Record<string, { url: string; key: string }> = { ...(prev.providerCreds ?? {}) };
  // Fold any legacy single-tuple into the map (back-compat for files written before the map existed).
  if (legacy.providerProfile && legacy.providerUrl && legacy.providerKey != null && !creds[legacy.providerProfile]) {
    creds[legacy.providerProfile] = { url: legacy.providerUrl, key: legacy.providerKey };
  }
  if (cfg.providerProfile) {
    // This session's provider IS a configured profile → record it as active AND remember it in the map.
    // The key may be absent (a keyless Custom/LAN endpoint): persist "" so the profile is restored on URL
    // alone next launch, without ever writing a bogus token.
    const key = cfg.apiKey ?? "";
    creds[cfg.providerProfile] = { url: cfg.baseUrl, key };
    data.providerProfile = cfg.providerProfile;
    data.providerUrl = cfg.baseUrl;
    data.providerKey = key;
  } else if (envActive && prev.providerProfile && prev.providerUrl && prev.providerKey != null) {
    data.providerProfile = prev.providerProfile;
    data.providerUrl = prev.providerUrl;
    data.providerKey = prev.providerKey;
  }
  if (Object.keys(creds).length) data.providerCreds = creds;
  try {
    writeSettingsFile(cfg.settingsDir, data);
  } catch {
    /* best-effort persistence */
  }
}

/** Whether a persisted settings file exists (for a "settings restored" startup note). */
export function hasPersistedSettings(settingsDir: string): boolean {
  try {
    readFileSync(join(settingsDir, SETTINGS_FILE), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Raw persisted settings (pre-migration) — used at boot to show the one-time retired-mode→Solo note. */
export function persistedSettings(settingsDir: string): PersistedSettings {
  return loadPersisted(settingsDir);
}

/** Persist a configured provider's creds as the ACTIVE provider (and remember it in the per-provider
 *  map) WITHOUT a full Config — used to activate a provider directly (e.g. the embedded Free models router,
 *  which persists profile "free" + model "auto" with no URL/key). Merges into settings.json (other prefs
 *  untouched); loadConfig's resolveProvider then restores it on the next launch. */
/** Switch the active provider to the managed OB-1 server (the paid SUBSCRIPTION path) with a default
 *  flagship model. Clears any provider PROFILE (e.g. Free models) so resolveProvider falls through to the
 *  server route (token + ${OB1_SERVER}/v1); keeps the per-provider cred memory. Chat then bills credits. */
export function persistSubscription(settingsDir: string, model: string): void {
  const prev = loadPersisted(settingsDir);
  const data: PersistedSettings = {
    ...prev,
    provider: "openai",
    model,
    providerProfile: undefined,
    providerUrl: undefined,
    providerKey: undefined,
  };
  try {
    writeSettingsFile(settingsDir, data);
  } catch {
    /* best-effort persistence */
  }
}

export function persistActiveProvider(
  settingsDir: string,
  profile: string,
  url: string,
  key: string,
  model?: string,
): void {
  const prev = loadPersisted(settingsDir);
  const creds: Record<string, { url: string; key: string }> = { ...(prev.providerCreds ?? {}) };
  creds[profile] = { url, key };
  const data: PersistedSettings = {
    ...prev,
    providerProfile: profile,
    providerUrl: url,
    providerKey: key,
    providerCreds: creds,
  };
  if (model) data.model = model;
  try {
    writeSettingsFile(settingsDir, data);
  } catch {
    /* best-effort persistence */
  }
}

/** The shipped, baked-in credentials for a provider. Kept as a tiny compatibility shim for older callers:
 *  no model-provider secrets ship in the client; use env keys or /models for BYOK routes. */
export function bakedProviderCreds(profileId: string): { url: string; key: string } | undefined {
  void profileId;
  return undefined;
}

/** Every configured provider's remembered creds, keyed by profile id. Used by the /models picker to
 *  switch between providers without re-prompting for a key already entered. Folds the legacy single
 *  tuple in for back-compat with settings files written before the per-provider map existed. */
export function savedProviderCreds(settingsDir: string): Record<string, { url: string; key: string }> {
  const s = loadPersisted(settingsDir);
  const map: Record<string, { url: string; key: string }> = { ...(s.providerCreds ?? {}) };
  if (s.providerProfile && s.providerUrl && s.providerKey != null && !map[s.providerProfile]) {
    map[s.providerProfile] = { url: s.providerUrl, key: s.providerKey };
  }
  return map;
}

/** Whether the active endpoint speaks OpenRouter semantics. The managed OB-1 server forwards model
 *  requests to OpenRouter, and a direct `OPENROUTER_API_KEY` route does too. Those paths take the unified
 *  `reasoning` param; plain OpenAI-compatible endpoints take the legacy `reasoning_effort` instead. */
export function isOpenRouterEndpoint(cfg: Pick<Config, "provider" | "baseUrl" | "providerProfile">): boolean {
  if (cfg.provider !== "openai") return false;
  if (!cfg.providerProfile && cfg.baseUrl.startsWith(ob1ServerUrl())) return true;
  try {
    return new URL(cfg.baseUrl).host === "openrouter.ai";
  } catch {
    return false;
  }
}

export function loadConfig(): Config {
  const cwd = process.cwd();
  const dataDir = join(cwd, ".ob1");
  const settingsDir = globalSettingsDir();
  const saved = loadPersisted(settingsDir);
  // NOTE: settings come ONLY from the global dir (~/.ob1). We intentionally do NOT migrate/adopt a
  // per-workspace <cwd>/.ob1/settings.json. That old migration kept resurrecting stale provider configs
  // (e.g. an old remote provider URL) into a freshly-reset global config every time `ob1` ran from a
  // folder that still had a legacy .ob1. The workspace .ob1 is now used only for memory.db, not settings.
  const p = resolveProvider(saved);
  const sameProvider = saved.provider === p.provider;
  // model: OB1_MODEL (already folded into p.model) wins; else the saved model when the provider matches.
  const model = process.env.OB1_MODEL ? p.model : sameProvider && saved.model ? saved.model : p.model;
  const effortRaw = (process.env.OB1_EFFORT as Effort | undefined) ?? saved.effort;
  const envPerm =
    process.env.OB1_PERMISSION === "autopilot" ? "autopilot" : process.env.OB1_PERMISSION === "ask" ? "ask" : undefined;
  // Explicit = the user chose the permission mode (env, or any previously-saved value); implicit = the
  // built-in default. A fresh install has no saved permissionMode → implicit → the trust gate may downgrade
  // it to "ask" in an untrusted folder (index.ts), so a first `ob1` in a real repo never runs autopilot unasked.
  const permissionModeExplicit = envPerm !== undefined || saved.permissionMode != null;
  const envSubagents = /^(1|true|on)$/i.test(process.env.OB1_SUBAGENTS ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_SUBAGENTS ?? "")
      ? false
      : undefined;
  const envEscalation = /^(1|true|on)$/i.test(process.env.OB1_ESCALATION ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_ESCALATION ?? "")
      ? false
      : undefined;
  const envRepoMap = /^(1|true|on)$/i.test(process.env.OB1_REPO_MAP ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_REPO_MAP ?? "")
      ? false
      : undefined;
  const envMemEvolve = /^(1|true|on)$/i.test(process.env.OB1_MEM_EVOLVE ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_MEM_EVOLVE ?? "")
      ? false
      : undefined;
  const envMemReflect = /^(1|true|on)$/i.test(process.env.OB1_MEM_REFLECT ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_MEM_REFLECT ?? "")
      ? false
      : undefined;
  const envMemAutolink = /^(1|true|on)$/i.test(process.env.OB1_MEM_AUTOLINK ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_MEM_AUTOLINK ?? "")
      ? false
      : undefined;
  const envSkillLearn = /^(1|true|on)$/i.test(process.env.OB1_SKILL_LEARN ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_SKILL_LEARN ?? "")
      ? false
      : undefined;
  const envQualityMode = QUALITY_MODES.includes(process.env.OB1_QUALITY as QualityMode)
    ? (process.env.OB1_QUALITY as QualityMode)
    : undefined;
  const envCheckpoint = /^(1|true|on)$/i.test(process.env.OB1_CHECKPOINT ?? "")
    ? true
    : /^(0|false|off)$/i.test(process.env.OB1_CHECKPOINT ?? "")
      ? false
      : undefined;
  const envSandbox = SANDBOXES.includes(process.env.OB1_SANDBOX as SandboxMode)
    ? (process.env.OB1_SANDBOX as SandboxMode)
    : undefined;
  const envFreeStrategy = FREE_STRATEGIES.includes(process.env.OB1_FREE_STRATEGY as FreeStrategy)
    ? (process.env.OB1_FREE_STRATEGY as FreeStrategy)
    : undefined;
  // Migration (multimind v2): the only interactive modes are now solo|fusion. The retired heavy modes
  // (council/personas) and the old adaptive router are gone — collapse ANY persisted mode that is not
  // solo|fusion back to Solo. MODES excludes them, so this ternary does the collapse; a later
  // saveSettings rewrites the file to mode:"solo". (config-validate accepts the legacy values so they
  // reach here rather than being dropped as invalid.)
  const mode: Mode = saved.mode && MODES.includes(saved.mode) ? saved.mode : "solo";
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
    envProviderSource: p.envProviderSource,
    cwd,
    dataDir,
    settingsDir,
    dbPath: join(dataDir, "memory.db"),
    // Guard against a non-numeric OB1_MAX_TOKENS (e.g. "8k"): Number("8k") is NaN, and NaN flows to the
    // provider body as max_tokens (NaN ?? x === NaN), breaking every request. Only accept a positive number.
    maxTokens: maxTokensFromEnv(),
    freeStrategy:
      envFreeStrategy ??
      (saved.freeStrategy && FREE_STRATEGIES.includes(saved.freeStrategy) ? saved.freeStrategy : "balanced"),
    mode,
    planMode: saved.planMode ?? false,
    subagents: envSubagents ?? saved.subagents ?? true,
    escalation: envEscalation ?? saved.escalation ?? true,
    repoMap: envRepoMap ?? saved.repoMap ?? true,
    memEvolve: envMemEvolve ?? saved.memEvolve ?? false,
    memReflect: envMemReflect ?? saved.memReflect ?? false,
    memAutolink: envMemAutolink ?? saved.memAutolink ?? false,
    skillLearn: envSkillLearn ?? saved.skillLearn ?? false,
    qualityMode:
      envQualityMode ?? (saved.qualityMode && QUALITY_MODES.includes(saved.qualityMode) ? saved.qualityMode : "normal"),
    permissionMode: envPerm ?? (saved.permissionMode === "ask" ? "ask" : "autopilot"),
    permissionModeExplicit,
    sandbox: envSandbox ?? (saved.sandbox && SANDBOXES.includes(saved.sandbox) ? saved.sandbox : "off"),
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
