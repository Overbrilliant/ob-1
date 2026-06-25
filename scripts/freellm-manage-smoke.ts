// Deterministic smoke for the OB-1-managed FreeLLMAPI pipeline (src/cli/freellm-manage.ts).
// Drives the whole orchestration against a MOCK FreeLLMAPI (Bun.serve) — no Docker/npm/network — and
// asserts the auto-wire writes the proxy URL + unified key into settings.json so loadConfig resolves it
// as the active provider. Mirrors the ob1-server smoke's mock-upstream pattern + freellm-smoke's temp dir.
// Usage: bun run scripts/freellm-manage-smoke.ts
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRuntime, freePort, isCloned, ensureCloned, ensureEnv, waitReady, nodeBuild, MANAGED_PORT,
  dashboardSetup, fetchUnifiedKey, isUsable, providerKeyCount, loadManaged, saveManaged, clearManaged,
  type Runner, type ManagedState,
} from "../src/cli/freellm-manage.ts";

let fail = false;
const check = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${ok || !d ? "" : `  — ${d}`}`); if (!ok) fail = true; };

// ── mock FreeLLMAPI (the endpoints OB-1 calls) ────────────────────────────────
const UNIFIED = "freellmapi-unified-test-key";
const state = { users: 0, providerKeys: 0 };
const sessions = new Set<string>();
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (pathname === "/api/auth/status") return Response.json({ needsSetup: state.users === 0, authenticated: false });
    if (pathname === "/api/auth/setup" && req.method === "POST") {
      if (state.users > 0) return Response.json({ error: { type: "setup_complete" } }, { status: 409 });
      state.users++; const tok = "sess-" + Math.random().toString(36).slice(2); sessions.add(tok);
      return Response.json({ token: tok, email: "u@x" }, { status: 201 });
    }
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const tok = "sess-" + Math.random().toString(36).slice(2); sessions.add(tok);
      return Response.json({ token: tok, email: "u@x" });
    }
    if (pathname === "/api/settings/api-key") {
      if (!auth || !sessions.has(auth)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ apiKey: UNIFIED });
    }
    if (pathname === "/v1/models") { // anonymous providers serve models even with ZERO user keys
      if (auth !== UNIFIED) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ data: [{ id: "auto" }, { id: "pollinations" }] });
    }
    if (pathname === "/api/keys") { // the user's added provider keys (dashboard-session-gated)
      if (!auth || !sessions.has(auth)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(Array.from({ length: state.providerKeys }, (_, i) => ({ id: i + 1, platform: "groq" })));
    }
    return new Response("not found", { status: 404 });
  },
});
const url = `http://localhost:${mock.port}`;

// hermetic settings dir (avoid the repo's own .ob1 + real ~/.ob1)
const tmp = mkdtempSync(join(tmpdir(), "ob1-flm-"));
const settingsDir = join(tmp, ".ob1");
mkdirSync(settingsDir, { recursive: true });
const savedEnv = { ...process.env };
for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OB1_TOKEN", "OB1_SERVER", "OB1_SEARXNG_URL"]) delete process.env[k];
process.env.OB1_SETTINGS_DIR = settingsDir;
const origCwd = process.cwd();
process.chdir(tmp);

try {
  // ── runtime detection (injected runner) ──
  const mk = (has: (c: string) => boolean, infoCode = 0): Runner => ({ has, exec: (a) => ({ code: a[1] === "info" ? infoCode : 0, out: "" }), spawnDetached: () => 4242 });
  check("detectRuntime → docker when docker present + healthy", detectRuntime(mk(() => true, 0)) === "docker");
  check("detectRuntime → node when no docker but node+npm", detectRuntime(mk((c) => c !== "docker")) === "node");
  check("detectRuntime → null when neither", detectRuntime(mk(() => false)) === null);
  check("detectRuntime → node when docker present but daemon down", detectRuntime(mk(() => true, 1)) === "node");

  // ── ports + filesystem setup ──
  const port = await freePort(0);
  check("freePort returns a usable port", Number.isInteger(port) && port > 0);
  const repoDir = join(tmp, "freellmapi");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), "{}"); // pretend already cloned
  check("isCloned true once package.json exists", isCloned(repoDir));
  check("ensureCloned no-ops (pull) on an existing clone", ensureCloned(repoDir, mk(() => true)) === true);
  ensureEnv(repoDir, port);
  const env = readFileSync(join(repoDir, ".env"), "utf8");
  check("ensureEnv writes ENCRYPTION_KEY (64 hex) + PORT", /ENCRYPTION_KEY=[0-9a-f]{64}/.test(env) && env.includes(`PORT=${port}`));
  const before = readFileSync(join(repoDir, ".env"), "utf8");
  ensureEnv(repoDir, port + 1);
  check("ensureEnv preserves an existing .env (key not rotated)", readFileSync(join(repoDir, ".env"), "utf8") === before);

  // ── uncommon managed port (avoid the crowded 3000/3001/8080/8888 range) ──
  check("MANAGED_PORT is in the private/dynamic range", MANAGED_PORT >= 49152 && MANAGED_PORT <= 65535);

  // ── Node build hardening: install if node_modules missing, build if dist/ missing, no-op when built ──
  const buildDir = join(tmp, "freellm-build");
  mkdirSync(buildDir, { recursive: true });
  const calls: string[][] = [];
  const recRunner: Runner = { has: () => true, exec: (a) => { calls.push(a); return { code: 0, out: "" }; }, spawnDetached: () => 1234 };
  const nb1 = nodeBuild(buildDir, recRunner); // nothing built yet
  check("nodeBuild installs + builds from scratch", nb1 && calls.some((a) => a.join(" ") === "npm install") && calls.some((a) => a.join(" ") === "npm run build"));
  // mark as fully built
  mkdirSync(join(buildDir, "node_modules"), { recursive: true });
  mkdirSync(join(buildDir, "server", "dist"), { recursive: true });
  writeFileSync(join(buildDir, "server", "dist", "index.js"), "// built");
  calls.length = 0;
  check("nodeBuild no-ops when already built", nodeBuild(buildDir, recRunner) && calls.length === 0);
  // dist wiped (but deps intact) → rebuild only, no reinstall (the heal-path hardening)
  rmSync(join(buildDir, "server", "dist", "index.js"));
  calls.length = 0;
  const nb3 = nodeBuild(buildDir, recRunner);
  check("nodeBuild rebuilds a wiped dist/ without reinstalling", nb3 && calls.length === 1 && calls[0].join(" ") === "npm run build");
  // a failed build propagates false (so a respawn won't spawn a process that immediately dies). dist/ is
  // still absent (the mock runner above doesn't actually produce build output), so this exercises build.
  const failRunner: Runner = { has: () => true, exec: () => ({ code: 1, out: "boom" }), spawnDetached: () => 0 };
  check("nodeBuild returns false when the build fails", nodeBuild(buildDir, failRunner) === false);

  // ── proxy reachability ──
  check("waitReady detects the running proxy", await waitReady(url, fetch, 5000));

  // ── dashboard setup → session, then unified key ──
  const session = await dashboardSetup(url, "u@x", "supersecret1");
  check("dashboardSetup (first run) returns a session token", !!session);
  const session2 = await dashboardSetup(url, "u@x", "supersecret1");
  check("dashboardSetup falls back to login when already set up (409)", !!session2);
  const key = await fetchUnifiedKey(url, session!);
  check("fetchUnifiedKey returns the unified API key", key === UNIFIED);
  check("fetchUnifiedKey rejects a bad session", (await fetchUnifiedKey(url, "nope")) === null);

  // ── usable vs "user added keys" (anon providers serve models with 0 user keys) ──
  check("isUsable true even with 0 user keys (anon providers)", (await isUsable(url, key!)) === true);
  check("providerKeyCount 0 before any key is added", (await providerKeyCount(url, session!)) === 0);
  state.providerKeys = 2; // user adds keys in the dashboard
  check("providerKeyCount reflects added keys", (await providerKeyCount(url, session!)) === 2);

  // ── AUTO-WIRE: persist creds → loadConfig resolves FreeLLMAPI as the active provider ──
  const { persistActiveProvider, loadConfig } = await import("../src/config.ts");
  persistActiveProvider(settingsDir, "freellmapi", `${url}/v1`, key!);
  const cfg = loadConfig();
  check("auto-wired: active provider is freellmapi (openai wire)", cfg.providerProfile === "freellmapi" && cfg.provider === "openai");
  check("auto-wired: baseUrl + apiKey come from the managed proxy", cfg.baseUrl === `${url}/v1` && cfg.apiKey === UNIFIED, `${cfg.baseUrl} / ${cfg.apiKey}`);

  // ── managed-state round-trip ──
  const st: ManagedState = { managed: true, dir: repoDir, runtime: "docker", port, url, email: "u@x", sessionToken: session!, providerKeys: 2 };
  saveManaged(st, settingsDir);
  const reloaded = loadManaged(settingsDir);
  check("managed state round-trips", reloaded?.url === url && reloaded?.runtime === "docker" && reloaded?.providerKeys === 2);
  clearManaged(settingsDir);
  check("clearManaged removes the state file", loadManaged(settingsDir) === null && !existsSync(join(settingsDir, "freellm.json")));
} finally {
  mock.stop(true);
  process.chdir(origCwd);
  process.env = savedEnv;
}

console.log("");
if (fail) { console.error("✗ freellm-manage smoke FAILED"); process.exit(1); }
console.log("✓ freellm-manage smoke passed");
