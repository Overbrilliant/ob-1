// Smoke: settings persistence (global ~/.ob1/settings.json). Verifies the round-trip (change →
// saveSettings → loadConfig restores), the env-over-persisted precedence, a corrupt file falling back
// to defaults, and the one-time legacy per-folder → global migration. Runs in a throwaway cwd with
// OB1_SETTINGS_DIR pinned to a temp dir (never touches the real ~/.ob1); no API key or network needed.
// Usage: bun run scripts/settings-persist-smoke.ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveSettings, hasPersistedSettings } from "../src/config.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

const tmp = mkdtempSync(join(tmpdir(), "ob1-settings-"));
const origCwd = process.cwd();
const savedEnv = { ...process.env };
delete process.env.OPENROUTER_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.OB1_BASE_URL; delete process.env.OB1_API_KEY; delete process.env.OB1_PROVIDER; delete process.env.OB1_TOKEN; delete process.env.OB1_SERVER;
delete process.env.OB1_MODEL; delete process.env.OB1_SANDBOX; delete process.env.OB1_PERMISSION; delete process.env.OB1_EFFORT; delete process.env.OB1_AUTO_ROUTE; delete process.env.OB1_SUBAGENTS; delete process.env.OB1_REPO_MAP; delete process.env.OB1_MEM_EVOLVE; delete process.env.OB1_MEM_REFLECT; delete process.env.OB1_MEM_AUTOLINK; delete process.env.OB1_SKILL_LEARN; delete process.env.OB1_QUALITY; delete process.env.OB1_CHECKPOINT;

try {
  process.chdir(tmp);
  // Pin settings to the temp workspace's .ob1 for scenarios 1–7 (settingsDir === dataDir here, so the
  // legacy migration is a no-op); the migration scenario (8) re-points it to a separate empty dir.
  process.env.OB1_SETTINGS_DIR = join(tmp, ".ob1");

  // 1) defaults when nothing is saved
  const base = loadConfig();
  check("settings live in the global settings dir", base.settingsDir === join(tmp, ".ob1"), base.settingsDir);
  check("fresh workspace → defaults", base.mode === "solo" && base.sandbox === "off" && base.permissionMode === "autopilot");
  check("auto-route defaults OFF", base.autoRoute === false);
  check("subagents default ON (parallel subagents available out of the box)", base.subagents === true);
  check("quality mode defaults normal", base.qualityMode === "normal");
  check("no settings file yet", !hasPersistedSettings(base.settingsDir));

  // 2) change settings + save
  base.mode = "fusion";
  base.sandbox = "read-only";
  base.permissionMode = "ask"; // deliberate ask must survive the autopilot default
  base.autoRoute = true;
  base.subagents = false; // toggled off → must persist (so the on default doesn't clobber a deliberate off)
  base.qualityMode = "strict";
  base.model = "anthropic/claude-opus-4.8"; // canonical OpenRouter slug, same provider
  saveSettings(base);
  check("settings file written", hasPersistedSettings(base.settingsDir));

  // 3) reload → persisted values restored
  const restored = loadConfig();
  check("mode restored", restored.mode === "fusion", restored.mode);
  check("sandbox restored", restored.sandbox === "read-only", restored.sandbox);
  check("permission mode restored (deliberate ask survives the autopilot default)", restored.permissionMode === "ask", restored.permissionMode);
  check("auto-route restored", restored.autoRoute === true);
  check("subagents restored (a deliberate OFF survives the ON default)", restored.subagents === false);
  check("quality mode restored", restored.qualityMode === "strict", restored.qualityMode);
  check("model restored (same provider)", restored.model === "anthropic/claude-opus-4.8", restored.model);

  // 4) explicit env var wins over persisted
  process.env.OB1_SANDBOX = "off";
  process.env.OB1_MODEL = "x-ai/grok-4.3";
  const envWins = loadConfig();
  check("env OB1_SANDBOX overrides persisted", envWins.sandbox === "off", envWins.sandbox);
  check("env OB1_MODEL overrides persisted", envWins.model === "x-ai/grok-4.3", envWins.model);
  process.env.OB1_AUTO_ROUTE = "off"; // persisted is true (above) → env must win
  check("env OB1_AUTO_ROUTE overrides persisted", loadConfig().autoRoute === false);
  process.env.OB1_SUBAGENTS = "on"; // persisted is false (above) → env must win
  check("env OB1_SUBAGENTS overrides persisted", loadConfig().subagents === true);
  process.env.OB1_QUALITY = "off"; // persisted is strict (above) → env must win
  check("env OB1_QUALITY overrides persisted", loadConfig().qualityMode === "off");
  delete process.env.OB1_SANDBOX; delete process.env.OB1_MODEL; delete process.env.OB1_AUTO_ROUTE; delete process.env.OB1_SUBAGENTS; delete process.env.OB1_QUALITY;

  // 4b) env overrides must NOT become permanent just because a slash command saved settings.
  process.env.OB1_MODEL = "env-only-model";
  process.env.OB1_SANDBOX = "workspace-write";
  process.env.OB1_AUTO_ROUTE = "off";
  const envOnly = loadConfig();
  check("env-only model/sandbox/autoroute apply at runtime", envOnly.model === "env-only-model" && envOnly.sandbox === "workspace-write" && envOnly.autoRoute === false, `${envOnly.model}/${envOnly.sandbox}/${envOnly.autoRoute}`);
  saveSettings(envOnly);
  delete process.env.OB1_MODEL; delete process.env.OB1_SANDBOX; delete process.env.OB1_AUTO_ROUTE;
  const afterEnvOnly = loadConfig();
  check("env-only model/sandbox/autoroute were not persisted", afterEnvOnly.model === "anthropic/claude-opus-4.8" && afterEnvOnly.sandbox === "read-only" && afterEnvOnly.autoRoute === true, `${afterEnvOnly.model}/${afterEnvOnly.sandbox}/${afterEnvOnly.autoRoute}`);

  process.env.OB1_SANDBOX = "yolo";
  check("invalid OB1_SANDBOX env falls back to persisted/default", loadConfig().sandbox === "read-only", loadConfig().sandbox);
  delete process.env.OB1_SANDBOX;

  process.env.OPENROUTER_API_KEY = "or-test-key";
  process.env.OPENAI_API_KEY = "openai-test-key";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  process.env.OB1_BASE_URL = "https://direct.example/v1";
  process.env.OB1_API_KEY = "direct-key";
  const oldSettingsDir = process.env.OB1_SETTINGS_DIR;
  process.env.OB1_SETTINGS_DIR = join(tmp, "direct-env-settings");
  const directEnv = loadConfig();
  check("direct provider env keys route the model at runtime", directEnv.apiKey === "direct-key" && directEnv.baseUrl === "https://direct.example/v1" && directEnv.provider === "openai" && directEnv.providerProfile === undefined, `${directEnv.provider}/${directEnv.baseUrl}/${directEnv.apiKey}/${directEnv.providerProfile}`);
  saveSettings(directEnv);
  check("direct env route does not create a settings file with env secrets", !hasPersistedSettings(directEnv.settingsDir) || !readFileSync(join(directEnv.settingsDir, "settings.json"), "utf8").includes("direct-key"));
  delete process.env.OB1_BASE_URL; delete process.env.OB1_API_KEY;
  const openRouterEnv = loadConfig();
  check("OPENROUTER_API_KEY routes when generic OB1_BASE_URL is absent", openRouterEnv.baseUrl === "https://openrouter.ai/api/v1" && openRouterEnv.apiKey === "or-test-key", `${openRouterEnv.baseUrl}/${openRouterEnv.apiKey}`);
  delete process.env.OPENROUTER_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  process.env.OB1_SETTINGS_DIR = oldSettingsDir;

  // 5) a direct Anthropic provider config is not persisted as a model route.
  saveSettings({ ...base, provider: "anthropic", model: "claude-some-direct-id" } as any);
  const crossProvider = loadConfig();
  const afterDirectAnthropic = JSON.parse(readFileSync(join(tmp, ".ob1", "settings.json"), "utf8"));
  check("direct Anthropic provider is not persisted", afterDirectAnthropic.provider === "openai", afterDirectAnthropic.provider);
  check("model from direct Anthropic provider is ignored", crossProvider.model !== "claude-some-direct-id", crossProvider.model);

  // 6) corrupt settings file → safe fallback to defaults
  mkdirSync(join(tmp, ".ob1"), { recursive: true });
  writeFileSync(join(tmp, ".ob1", "settings.json"), "{ not valid json ");
  const corrupt = loadConfig();
  check("corrupt settings file falls back to defaults", corrupt.mode === "solo" && corrupt.sandbox === "off");

  // 7) migration: a pre-toggle `adaptive` workspace (no autoRoute persisted) lands back in Solo, off.
  writeFileSync(join(tmp, ".ob1", "settings.json"), JSON.stringify({ provider: "openai", mode: "adaptive" }));
  const migrated = loadConfig();
  check("adaptive (no autoRoute) migrates to solo", migrated.mode === "solo", migrated.mode);
  check("migrated workspace has auto-route off", migrated.autoRoute === false);
  // `adaptive` is fully retired: ANY persisted adaptive collapses to Solo, but a deliberate
  // autoRoute:true is preserved — so "Solo + auto-route on" reproduces the old adaptive behaviour.
  writeFileSync(join(tmp, ".ob1", "settings.json"), JSON.stringify({ provider: "openai", mode: "adaptive", autoRoute: true }));
  const kept = loadConfig();
  check("adaptive + autoRoute:true → solo, auto-route preserved on", kept.mode === "solo" && kept.autoRoute === true, `${kept.mode}/${kept.autoRoute}`);
  // and adaptive + autoRoute:false → solo with auto-route OFF (no contradictory auto-escalation)
  writeFileSync(join(tmp, ".ob1", "settings.json"), JSON.stringify({ provider: "openai", mode: "adaptive", autoRoute: false }));
  const keptOff = loadConfig();
  check("adaptive + autoRoute:false → solo, auto-route off", keptOff.mode === "solo" && keptOff.autoRoute === false, `${keptOff.mode}/${keptOff.autoRoute}`);

  // 8) NO per-folder migration: a <cwd>/.ob1/settings.json is IGNORED by a fresh global dir. Settings
  //    come only from the global dir now — this stops a stale workspace file (e.g. an old remote
  //    FreeLLMAPI URL) from resurrecting itself into a freshly-reset global config.
  writeFileSync(join(tmp, ".ob1", "settings.json"), JSON.stringify({ provider: "openai", mode: "council", sandbox: "read-only", providerProfile: "freellmapi", providerUrl: "https://stale.example/v1", providerKey: "k-stale" }));
  const gdir = join(tmp, "global-ob1");
  process.env.OB1_SETTINGS_DIR = gdir; // a fresh, empty global location
  check("global settings empty before load", !hasPersistedSettings(gdir));
  const mig = loadConfig();
  check("workspace settings are NOT adopted → defaults used", mig.mode === "solo" && mig.sandbox === "off", `${mig.mode}/${mig.sandbox}`);
  check("no stale provider profile leaks in from the workspace", mig.providerProfile === undefined, String(mig.providerProfile));
  check("load did NOT seed a global file from the workspace", !hasPersistedSettings(gdir));
  check("config still points at the global dir", mig.settingsDir === gdir, mig.settingsDir);

  // 9) subscription protection: a global file that EXISTS but has NO provider profile is the managed-
  //    server SUBSCRIPTION state — the migration must NOT re-inject a stale legacy profile over it
  //    (doing so silently clobbered subscriptions, reverting to an old FreeLLMAPI/remote URL).
  const gdir2 = join(tmp, "global-ob1-2");
  mkdirSync(gdir2, { recursive: true });
  writeFileSync(join(gdir2, "settings.json"), JSON.stringify({ provider: "openai", model: "anthropic/claude-sonnet-4.6", mode: "solo" })); // subscribed: NO providerProfile
  writeFileSync(join(tmp, ".ob1", "settings.json"), JSON.stringify({ provider: "openai", providerProfile: "freellmapi", providerUrl: "https://x/v1", providerKey: "k-123" }));
  process.env.OB1_SETTINGS_DIR = gdir2;
  const subCfg = loadConfig();
  const subKept = JSON.parse(readFileSync(join(gdir2, "settings.json"), "utf8"));
  check("subscribed (profile-less) global is NOT clobbered by a legacy profile", subKept.providerProfile === undefined, JSON.stringify(subKept.providerProfile));
  check("subscribed config keeps the managed-server provider (no legacy profile)", subCfg.providerProfile === undefined, String(subCfg.providerProfile));

  // 10) freeStrategy (embedded free-models router) round-trips across save/reload.
  const gdirFS = join(tmp, "global-fs");
  mkdirSync(gdirFS, { recursive: true });
  process.env.OB1_SETTINGS_DIR = gdirFS;
  const fsCfg = loadConfig();
  check("freeStrategy defaults to balanced", fsCfg.freeStrategy === "balanced", fsCfg.freeStrategy);
  fsCfg.freeStrategy = "smartest";
  saveSettings(fsCfg);
  check("freeStrategy survives a save/reload", loadConfig().freeStrategy === "smartest", loadConfig().freeStrategy);

  // 11) legacy migration: a GLOBAL settings.json with providerProfile "freellmapi" loads as the embedded
  //     "free" router (model "auto") and the rewrite is persisted. Guards the config-validate ORDERING bug:
  //     validateSettings must accept the legacy alias so migrateFreellmapiToFree can rewrite it (otherwise the
  //     value is stripped first and the user is silently un-onboarded).
  const gdirMig = join(tmp, "global-mig");
  mkdirSync(gdirMig, { recursive: true });
  writeFileSync(join(gdirMig, "settings.json"), JSON.stringify({ provider: "openai", providerProfile: "freellmapi", providerUrl: "http://localhost:3001/v1", providerKey: "k", model: "kimi" }));
  process.env.OB1_SETTINGS_DIR = gdirMig;
  const migFree = loadConfig();
  check("legacy freellmapi profile migrates to the embedded free router", migFree.providerProfile === "free" && migFree.provider === "free" && migFree.model === "auto", `${migFree.providerProfile}/${migFree.provider}/${migFree.model}`);
  check("migration drops the stale FreeLLMAPI endpoint/key from the live config", (migFree.baseUrl ?? "") === "" && !migFree.apiKey, `${migFree.baseUrl}/${migFree.apiKey}`);
  const migPersisted = JSON.parse(readFileSync(join(gdirMig, "settings.json"), "utf8"));
  check("migration is persisted to disk (freellmapi → free / auto)", migPersisted.providerProfile === "free" && migPersisted.model === "auto", JSON.stringify(migPersisted.providerProfile));
  check("migration clears stale providerUrl/providerKey on disk", migPersisted.providerUrl === "" && migPersisted.providerKey === "", `${JSON.stringify(migPersisted.providerUrl)}/${JSON.stringify(migPersisted.providerKey)}`);
} finally {
  process.chdir(origCwd);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

if (fail) { console.error("\n✗ settings-persist smoke FAILED"); process.exit(1); }
console.log("\n✓ settings-persist smoke passed (global round-trip · env precedence · provider guard · corrupt fallback · adaptive + legacy→global migration + subscription not clobbered · freeStrategy round-trip · freellmapi→free migration)");
process.exit(0);
