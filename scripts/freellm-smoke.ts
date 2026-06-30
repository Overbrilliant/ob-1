// Deterministic test for the FreeLLMAPI provider integration (no network, no key). Covers:
//   - the provider-profile registry (FreeLLMAPI metadata)
//   - normalizeBaseUrl (forgiving paste handling: scheme, trailing slash, endpoint strip, /v1 append)
//   - fetchModels never throws on an unreachable host (returns a clean ok:false result)
//   - config persistence: a /models-configured profile round-trips through the settings file, with
//     direct provider env keys ignored for model routing
// Usage: bun run scripts/freellm-smoke.ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FREELLMAPI, CUSTOM, PROFILES, profileById, normalizeBaseUrl, fetchModels } from "../src/providers/profiles.ts";
import { loadConfig, saveSettings, savedProviderCreds, bakedProviderCreds, ob1ServerUrl } from "../src/config.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

// ── profile registry ──
check("profile registry exposes FreeLLMAPI", profileById("freellmapi") === FREELLMAPI);
check("unknown / undefined profile id → undefined", profileById("nope") === undefined && profileById(undefined) === undefined);
check("FreeLLMAPI is OpenAI-compatible on the wire", FREELLMAPI.wire === "openai");
check("FreeLLMAPI has a default model (auto router)", FREELLMAPI.defaultModel === "auto");
check("FreeLLMAPI ships a blurb so users know what it is", FREELLMAPI.blurb.join(" ").toLowerCase().includes("free") && FREELLMAPI.blurb.length >= 3);
check("FreeLLMAPI offers Local + Remote presets", FREELLMAPI.presets.length >= 2 && FREELLMAPI.presets.some((p) => p.label === "Local") && FREELLMAPI.presets.some((p) => p.label === "Remote"));
check("no secrets baked into the profile (presets carry no key)", !(FREELLMAPI as any).presets.some((p: any) => p.key));

// ── Custom endpoint: bring-your-own OpenAI-compatible server (local/LAN), key optional, model typed ──
check("profile registry exposes Custom endpoint", profileById("custom") === CUSTOM);
check("Custom endpoint is OpenAI-compatible on the wire", CUSTOM.wire === "openai");
check("Custom endpoint marks the key optional", CUSTOM.keyOptional === true);
check("Custom endpoint collects a typed model id (needsModel)", CUSTOM.needsModel === true);
check("Custom endpoint offers Local + LAN/Remote presets", CUSTOM.presets.length >= 2 && CUSTOM.presets.some((p) => p.label === "Local"));
check("Custom endpoint bakes no secret (presets carry no key)", !(CUSTOM as any).presets.some((p: any) => p.key));

// ── frontier (paid) models are served by the managed server, NOT a user-facing provider profile ──
check("user-facing profiles are exactly FreeLLMAPI + Custom", PROFILES.length === 2 && PROFILES.includes(FREELLMAPI) && PROFILES.includes(CUSTOM));
check("FreeLLMAPI is the free/default profile (listed first)", PROFILES[0] === FREELLMAPI);
check("no OpenRouter profile is surfaced to users", profileById("openrouter") === undefined);
check("profiles no longer name OpenRouter anywhere", !JSON.stringify(PROFILES).toLowerCase().includes("openrouter"));

// ── normalizeBaseUrl ──
const N = normalizeBaseUrl;
check("keeps a well-formed /v1 URL", N("https://api.host/v1") === "https://api.host/v1", N("https://api.host/v1"));
check("strips a trailing slash", N("https://api.host/v1/") === "https://api.host/v1", N("https://api.host/v1/"));
check("appends /v1 when only a host is given", N("https://api.host") === "https://api.host/v1", N("https://api.host"));
check("appends /v1 to a host:port", N("http://localhost:3001") === "http://localhost:3001/v1", N("http://localhost:3001"));
check("assumes http for a bare host (local default)", N("localhost:3001") === "http://localhost:3001/v1", N("localhost:3001"));
check("drops a pasted endpoint path (/chat/completions)", N("http://localhost:3001/v1/chat/completions") === "http://localhost:3001/v1", N("http://localhost:3001/v1/chat/completions"));
check("drops a pasted /models path", N("http://localhost:3001/v1/models") === "http://localhost:3001/v1", N("http://localhost:3001/v1/models"));
check("preserves the real sslip.io test host shape", N("https://freellm.example.sslip.io/v1") === "https://freellm.example.sslip.io/v1");
check("empty input → empty string", N("") === "" && N("   ") === "");

// ── fetchModels: never throws; clean failure on an unreachable host ──
{
  const r = await fetchModels("http://127.0.0.1:1/v1", "irrelevant", 1500);
  check("fetchModels returns ok:false on an unreachable host (no throw)", r.ok === false && Array.isArray(r.models) && r.models.length === 0);
  check("fetchModels surfaces an error string", typeof r.error === "string" && r.error.length > 0, r.error);
}

// ── config persistence round-trip ──
const tmp = mkdtempSync(join(tmpdir(), "ob1-freellm-"));
const origCwd = process.cwd();
const savedEnv = { ...process.env };
for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OB1_BASE_URL", "OB1_PROVIDER", "OB1_MODEL", "OB1_SANDBOX", "OB1_PERMISSION", "OB1_EFFORT", "OB1_AUTO_ROUTE", "OB1_SUBAGENTS", "OB1_TOKEN", "OB1_SERVER", "OB1_SEARXNG_URL", "OB1_SEARXNG_KEY"]) delete process.env[k];

try {
  process.chdir(tmp);
  process.env.OB1_SETTINGS_DIR = join(tmp, ".ob1"); // keep settings hermetic in the temp workspace (not real ~/.ob1)

  // ── no secrets in the client: models route through the managed OB-1 server, not a baked key ──
  check("OpenRouter ships NO baked key (shared key lives server-side only)", bakedProviderCreds("openrouter") === undefined);
  check("FreeLLMAPI has no baked key (user-configured proxy)", bakedProviderCreds("freellmapi") === undefined);
  // a clean workspace (no env key, not signed in) → routes to the managed OB-1 server with NO client
  // key (the app then prompts `ob1 login`); the real OpenRouter key is injected server-side.
  const clean = loadConfig();
  // routes through the managed OB-1 server (ob1ServerUrl() — the SINGLE source of truth for the URL,
  // localhost in dev) with no client key.
  check("clean workspace defaults to the managed OB-1 server (no client key)", clean.provider === "openai" && clean.baseUrl === `${ob1ServerUrl()}/v1` && clean.apiKey === undefined, `${clean.provider}/${clean.baseUrl}/${clean.apiKey}`);
  check("clean workspace default model is a flagship slug", clean.model === "qwen/qwen3.6-plus", clean.model);

  // a workspace where FreeLLMAPI was configured via the setup tab
  mkdirSync(join(tmp, ".ob1"), { recursive: true });
  writeFileSync(join(tmp, ".ob1", "settings.json"), JSON.stringify({
    provider: "openai", providerProfile: "freellmapi",
    providerUrl: "https://freellm.example.sslip.io/v1", providerKey: "freellmapi-secret", model: "auto",
  }));
  const cfg = loadConfig();
  check("persisted profile → provider resolves to openai", cfg.provider === "openai", cfg.provider);
  check("persisted profile → baseUrl restored", cfg.baseUrl === "https://freellm.example.sslip.io/v1", cfg.baseUrl);
  check("persisted profile → apiKey restored", cfg.apiKey === "freellmapi-secret");
  check("persisted profile → providerProfile flag set", cfg.providerProfile === "freellmapi", cfg.providerProfile);
  check("persisted profile → model restored (auto)", cfg.model === "auto", cfg.model);

  // direct provider env keys are not model routes; the saved profile remains active
  process.env.OPENROUTER_API_KEY = "or-key";
  process.env.OPENAI_API_KEY = "oa-key";
  process.env.ANTHROPIC_API_KEY = "anthropic-key";
  process.env.OB1_BASE_URL = "https://direct.example/v1";
  const envCfg = loadConfig();
  check("direct provider env keys do not override the persisted profile", envCfg.providerProfile === "freellmapi" && envCfg.baseUrl === "https://freellm.example.sslip.io/v1" && envCfg.apiKey === "freellmapi-secret", `${envCfg.providerProfile}/${envCfg.baseUrl}/${envCfg.apiKey}`);
  // saving from that session must not rewrite the active profile to any direct provider URL/key
  saveSettings(envCfg);
  const afterSave = JSON.parse(readFileSync(join(tmp, ".ob1", "settings.json"), "utf8"));
  check("saveSettings keeps the active profile creds", afterSave.providerProfile === "freellmapi" && afterSave.providerKey === "freellmapi-secret" && afterSave.providerUrl === "https://freellm.example.sslip.io/v1");
  delete process.env.OPENROUTER_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.OB1_BASE_URL;

  // the profile still loads after that save (creds intact)
  const reCfg = loadConfig();
  check("profile still active after the env-override save", reCfg.providerProfile === "freellmapi" && reCfg.apiKey === "freellmapi-secret");

  // saveSettings writes creds when the session IS the profile
  const fresh = loadConfig();
  fresh.providerProfile = "freellmapi"; fresh.baseUrl = "http://localhost:3001/v1"; fresh.apiKey = "freellmapi-local"; fresh.model = "kimi-k2.6";
  saveSettings(fresh);
  const written = JSON.parse(readFileSync(join(tmp, ".ob1", "settings.json"), "utf8"));
  check("saveSettings persists updated profile creds (URL/key/model)", written.providerUrl === "http://localhost:3001/v1" && written.providerKey === "freellmapi-local" && written.model === "kimi-k2.6");

  // ── per-provider credential memory (switch FreeLLMAPI⇄Custom without re-entry) ──
  // Start on FreeLLMAPI (just saved above), then SWITCH the active provider to Custom API and save.
  const sw = loadConfig();
  check("active provider is FreeLLMAPI before switching", sw.providerProfile === "freellmapi", sw.providerProfile);
  sw.provider = "openai"; sw.providerProfile = "custom"; sw.baseUrl = "http://localhost:11434/v1"; sw.apiKey = undefined; sw.model = "llama3.1";
  saveSettings(sw);
  const both = savedProviderCreds(sw.settingsDir);
  check("both providers remembered after switching to Custom API", both.freellmapi?.key === "freellmapi-local" && both.custom?.url === "http://localhost:11434/v1" && both.custom?.key === "", JSON.stringify(Object.keys(both)));
  check("active provider tuple now names Custom API", JSON.parse(readFileSync(join(tmp, ".ob1", "settings.json"), "utf8")).providerProfile === "custom");
  // reload → Custom API is the active provider with its typed model restored
  const customCfg = loadConfig();
  check("custom provider restored on reload", customCfg.providerProfile === "custom" && customCfg.apiKey === undefined && customCfg.baseUrl === "http://localhost:11434/v1", `${customCfg.providerProfile}/${customCfg.baseUrl}/${customCfg.apiKey}`);
  check("custom model restored on reload", customCfg.model === "llama3.1", customCfg.model);
  // switching BACK to FreeLLMAPI must still find the remembered free key (no re-entry needed)
  const backCreds = savedProviderCreds(customCfg.settingsDir);
  check("free key still remembered while on Custom API", backCreds.freellmapi?.key === "freellmapi-local" && backCreds.freellmapi?.url === "http://localhost:3001/v1");
} finally {
  process.chdir(origCwd);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

if (fail) { console.error("\n✗ freellm smoke FAILED"); process.exit(1); }
console.log("\n✓ freellm smoke passed (FreeLLMAPI + Custom profiles · no OpenRouter surfaced · managed-server default · url normalization · resilient probe · config round-trip + direct env ignored · per-provider cred memory)");
process.exit(0);
