// Regression guard for the managed-server routing added when the baked keys were removed:
//   • loadAuthToken precedence (OB1_TOKEN env > ~/.ob1/auth.json)
//   • clean config routes to the OB-1 server /v1 with the token as apiKey (undefined when not signed in)
//   • web_search defaults to the server /v1/search with Bearer auth; OB1_SEARXNG_URL → direct X-API-Key
//   • the paid (402) and not-signed-in (401) search responses produce actionable errors
// Pure + hermetic (temp settings dir, injected fetch). Usage: bun run scripts/auth-route-smoke.ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoredLocalOb1ServerOverride, loadConfig, loadAuthToken, ob1ServerUrl } from "../src/config.ts";
import { webSearch, type Fetcher } from "../src/tools/web.ts";

let fail = false;
const check = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${ok || !d ? "" : `  — ${d}`}`); if (!ok) fail = true; };

const savedEnv = { ...process.env };
for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "OB1_BASE_URL", "OB1_API_KEY", "OB1_PROVIDER", "OB1_TOKEN", "OB1_SERVER", "OB1_ALLOW_LOCAL_SERVER", "OB1_SEARXNG_URL", "OB1_SEARXNG_KEY"]) delete process.env[k];

const tmp = mkdtempSync(join(tmpdir(), "ob1-auth-"));
const settingsDir = join(tmp, ".ob1");
mkdirSync(settingsDir, { recursive: true });
process.env.OB1_SETTINGS_DIR = settingsDir;
const origCwd = process.cwd();
process.chdir(tmp); // hermetic: avoid the repo's own .ob1/settings.json legacy fallback

try {
  // ── token precedence ──
  check("no token when nothing is configured", loadAuthToken() === undefined);
  writeFileSync(join(settingsDir, "auth.json"), JSON.stringify({ token: "file-token" }));
  check("token read from ~/.ob1/auth.json", loadAuthToken() === "file-token");
  process.env.OB1_TOKEN = "env-token";
  check("OB1_TOKEN env overrides auth.json", loadAuthToken() === "env-token");
  delete process.env.OB1_TOKEN;

  // ── clean config routes to the managed server ──
  const cfg = loadConfig();
  check("baseUrl is the OB-1 server /v1", cfg.baseUrl === `${ob1ServerUrl()}/v1`, cfg.baseUrl);
  check("apiKey is the signed-in token", cfg.apiKey === "file-token", String(cfg.apiKey));
  check("web_search defaults to the server /v1/search + Bearer", cfg.searxngUrl === `${ob1ServerUrl()}/v1/search` && cfg.searxngBearer === true);
  check("web_search key is the token", cfg.searxngKey === "file-token");

  // ── managed server override safety ──
  process.env.OB1_SERVER = "https://selfhost.example";
  check("remote OB1_SERVER overrides managed server", ob1ServerUrl() === "https://selfhost.example", ob1ServerUrl());
  process.env.OB1_SERVER = "http://localhost:8787";
  delete process.env.OB1_ALLOW_LOCAL_SERVER;
  check("localhost OB1_SERVER is ignored by default", ob1ServerUrl() === "https://ob1-api.overbrilliant.com" && ignoredLocalOb1ServerOverride() === "http://localhost:8787", ob1ServerUrl());
  process.env.OB1_ALLOW_LOCAL_SERVER = "1";
  check("localhost OB1_SERVER works when explicitly allowed", ob1ServerUrl() === "http://localhost:8787" && ignoredLocalOb1ServerOverride() === undefined, ob1ServerUrl());
  delete process.env.OB1_SERVER; delete process.env.OB1_ALLOW_LOCAL_SERVER;

  // ── model-provider env precedence ──
  process.env.OPENROUTER_API_KEY = "or-test";
  process.env.OPENAI_API_KEY = "oa-test";
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  process.env.OB1_BASE_URL = "https://direct.example/v1";
  process.env.OB1_API_KEY = "direct-test";
  const cfgDirectIgnored = loadConfig();
  check("OB1_BASE_URL/OB1_API_KEY bypass the managed route", cfgDirectIgnored.baseUrl === "https://direct.example/v1" && cfgDirectIgnored.apiKey === "direct-test" && cfgDirectIgnored.providerProfile === undefined, `${cfgDirectIgnored.baseUrl}/${cfgDirectIgnored.apiKey}/${cfgDirectIgnored.providerProfile}`);
  delete process.env.OB1_BASE_URL; delete process.env.OB1_API_KEY;
  const cfgNamedWithToken = loadConfig();
  check("named provider env keys do not shadow a signed-in managed route", cfgNamedWithToken.baseUrl === `${ob1ServerUrl()}/v1` && cfgNamedWithToken.apiKey === "file-token" && cfgNamedWithToken.providerProfile === undefined, `${cfgNamedWithToken.baseUrl}/${cfgNamedWithToken.apiKey}/${cfgNamedWithToken.providerProfile}`);
  rmSync(join(settingsDir, "auth.json"), { force: true });
  const cfgOpenRouter = loadConfig();
  check("OPENROUTER_API_KEY routes to OpenRouter when no token/profile exists", cfgOpenRouter.baseUrl === "https://openrouter.ai/api/v1" && cfgOpenRouter.apiKey === "or-test" && cfgOpenRouter.providerProfile === undefined, `${cfgOpenRouter.baseUrl}/${cfgOpenRouter.apiKey}/${cfgOpenRouter.providerProfile}`);
  delete process.env.OPENROUTER_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

  // ── direct SearXNG override uses X-API-Key (not Bearer) ──
  process.env.OB1_SEARXNG_URL = "https://searx.example/search";
  process.env.OB1_SEARXNG_KEY = "direct-key";
  const cfg2 = loadConfig();
  check("OB1_SEARXNG_URL override → direct (no bearer)", cfg2.searxngUrl === "https://searx.example/search" && cfg2.searxngBearer === false && cfg2.searxngKey === "direct-key");
  delete process.env.OB1_SEARXNG_URL; delete process.env.OB1_SEARXNG_KEY;

  // ── webSearch auth header selection ──
  let captured: any = {};
  const okFetch = ((async (url: string | URL, init: any) => { captured = { url: String(url), headers: init.headers }; return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } }); }) as any) as Fetcher;
  await webSearch({ base: "https://api.ob1.dev/v1/search", key: "tok", bearer: true, query: "x", fetchFn: okFetch });
  check("bearer mode sends Authorization: Bearer", captured.headers.authorization === "Bearer tok" && !captured.headers["X-API-Key"]);
  await webSearch({ base: "https://searx.example/search", key: "k", bearer: false, query: "x", fetchFn: okFetch });
  check("apikey mode sends X-API-Key", captured.headers["X-API-Key"] === "k" && !captured.headers.authorization);

  // ── error mapping ──
  const status = (code: number): Fetcher => ((async () => new Response(JSON.stringify({ error: "e" }), { status: code })) as any);
  let msg = "";
  try { await webSearch({ base: "https://api.ob1.dev/v1/search", key: "t", bearer: true, query: "x", fetchFn: status(402) }); } catch (e) { msg = (e as Error).message; }
  check("402 → 'paid feature' error", /paid feature/i.test(msg), msg);
  msg = "";
  try { await webSearch({ base: "https://api.ob1.dev/v1/search", key: "t", bearer: true, query: "x", fetchFn: status(401) }); } catch (e) { msg = (e as Error).message; }
  check("401 (bearer) → 'ob1 login' error", /ob1 login/i.test(msg), msg);
} finally {
  process.chdir(origCwd);
  process.env = savedEnv;
}

console.log("");
if (fail) { console.error("✗ auth-route smoke FAILED"); process.exit(1); }
console.log("✓ auth-route smoke passed");
