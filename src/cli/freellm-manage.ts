// OB-1-managed FreeLLMAPI proxy lifecycle.
//
// FreeLLMAPI (github.com/tashfeenahmed/freellmapi) is the user's self-hosted, OpenAI-compatible proxy
// that stacks ~16 free LLM provider tiers behind one /v1 endpoint + a dashboard (default :3001). When
// OB-1 "manages" it, OB-1 clones it, generates its .env, runs it (Docker if available, else Node),
// creates the dashboard account, and AUTO-WIRES the proxy URL + the proxy's unified API key into OB-1's
// settings — so the user never types a URL or key, they just add their provider keys in the dashboard.
//
// Two secrets in FreeLLMAPI (see its server/src/routes/auth.ts + settings.ts):
//   • a DASHBOARD session (POST /api/auth/setup first-run | /api/auth/login) gating /api/*
//   • the UNIFIED API key (GET /api/settings/api-key, dashboard-session-gated) gating /v1 — what OB-1 sends
// "Linked" = GET /v1/models (with the unified key) returns ≥1 model (i.e. the user added ≥1 provider key).
//
// Side-effecting OS ops go through an injectable Runner so the smoke can drive the whole orchestration
// against a mock server without Docker/npm/network (mirrors the injectable exec in agent/verify.ts).
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, renameSync, cpSync } from "node:fs";
import { createServer } from "node:net";
import { globalSettingsDir } from "../config.ts";

export const FREELLM_REPOS = [
  "https://github.com/tashfeenahmed/freellmapi",
] as const;
export const FREELLM_REPO = FREELLM_REPOS[0];
const STATE_FILE = "freellm.json";
/** Default port for the OB-1-managed proxy. Deliberately in the private/dynamic range (49152–65535) so it
 *  doesn't collide with the crowded dev ports people actually use (3000/3001/8000/8080/8888). freePort()
 *  falls back to an OS-assigned port if even this is taken, so a collision still self-heals. */
export const MANAGED_PORT = 49317;
/** Path (relative to the clone) of the built Node entrypoint. */
const NODE_ENTRY = "server/dist/index.js";
const PRESERVED_REPAIR_PATHS = [".env", "data", "server/data"] as const;

export type Runtime = "docker" | "node";

export interface ManagedState {
  managed: boolean;
  dir: string;
  runtime: Runtime;
  port: number;
  url: string;            // http://localhost:<port>
  email?: string;
  dashboardPassword?: string; // generated/entered dashboard password; freellm.json is owner-only
  sessionToken?: string;  // dashboard session (to re-fetch the unified key / check provider keys)
  providerKeys?: number;  // how many provider keys the user has added in the dashboard
}

export interface ManagedStatus {
  proxyUp: boolean;
  anonymousModelsUsable: boolean | null;
  providerKeys: number | null;
}

// ── injectable OS runner ──────────────────────────────────────────────────────
export interface Runner {
  has(cmd: string): boolean;                                                          // is a binary on PATH
  exec(argv: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): { code: number; out: string };
  spawnDetached(argv: string[], opts: { cwd: string; env?: Record<string, string> }): number; // returns pid
}

export const realRunner: Runner = {
  has: (cmd) => !!Bun.which(cmd),
  exec: (argv, opts = {}) => {
    const r = Bun.spawnSync(argv, {
      cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) },
      stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs,
    });
    return { code: r.exitCode ?? 1, out: `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}` };
  },
  spawnDetached: (argv, opts) => {
    const p = Bun.spawn(argv, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
    p.unref();
    return p.pid;
  },
};

// ── state persistence (~/.ob1/freellm.json) ───────────────────────────────────
function stateFile(dir = globalSettingsDir()): string { return join(dir, STATE_FILE); }
export function installDir(settingsDir = globalSettingsDir()): string { return join(settingsDir, "freellmapi"); }

export function loadManaged(settingsDir = globalSettingsDir()): ManagedState | null {
  try { return JSON.parse(readFileSync(stateFile(settingsDir), "utf8")) as ManagedState; } catch { return null; }
}
export function saveManaged(s: ManagedState, settingsDir = globalSettingsDir()): void {
  // freellm.json holds dashboard credentials/session + email — owner-only (0o600), re-tightened on rewrite.
  try { mkdirSync(settingsDir, { recursive: true, mode: 0o700 }); const p = stateFile(settingsDir); writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 }); chmodSync(p, 0o600); } catch { /* best-effort */ }
}
export function clearManaged(settingsDir = globalSettingsDir()): void { try { rmSync(stateFile(settingsDir), { force: true }); } catch { /* nothing to clear */ } }

// ── runtime + ports ───────────────────────────────────────────────────────────
/** Prefer Docker (persistent across OB-1 restarts), else Node (npm), else null (→ manual setup). */
export function detectRuntime(runner: Runner = realRunner): Runtime | null {
  if (runner.has("docker") && runner.exec(["docker", "info"], { timeoutMs: 5000 }).code === 0) return "docker";
  if (runner.has("node") && runner.has("npm")) return "node";
  return null;
}

/** An open TCP port — `preferred` if free, else an OS-assigned one. */
export function freePort(preferred = MANAGED_PORT): Promise<number> {
  const tryListen = (port: number) => new Promise<number | null>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(null));
    srv.listen(port, "127.0.0.1", () => { const p = (srv.address() as any).port as number; srv.close(() => resolve(p)); });
  });
  return tryListen(preferred).then((p) => p ?? tryListen(0).then((q) => q ?? preferred));
}

// ── filesystem setup ──────────────────────────────────────────────────────────
export function isCloned(dir: string): boolean { return existsSync(join(dir, "package.json")); }

function preservedPath(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

function snapshotPreservedPaths(dir: string, parent: string, base: string): string | null {
  if (!existsSync(dir)) return null;
  const backup = join(parent, `.${base}.preserve-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let copied = false;
  for (const rel of PRESERVED_REPAIR_PATHS) {
    const src = preservedPath(dir, rel);
    if (!existsSync(src)) continue;
    try {
      const dest = preservedPath(backup, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true, preserveTimestamps: true });
      copied = true;
    } catch { /* best-effort; other paths may still be preserved */ }
  }
  if (!copied) {
    rmSync(backup, { recursive: true, force: true });
    return null;
  }
  return backup;
}

function restorePreservedPaths(backup: string | null, dir: string): void {
  if (!backup) return;
  for (const rel of PRESERVED_REPAIR_PATHS) {
    const src = preservedPath(backup, rel);
    const dest = preservedPath(dir, rel);
    if (!existsSync(src) || existsSync(dest)) continue;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true, preserveTimestamps: true });
      if (rel === ".env") chmodSync(dest, 0o600);
    } catch { /* best-effort; do not fail a successful repair */ }
  }
}

/** Clone the repo (or `git pull` if already present). Returns false on failure (caller falls back). */
export function ensureCloned(dir: string, runner: Runner = realRunner): boolean {
  if (isCloned(dir)) { runner.exec(["git", "-C", dir, "pull", "--ff-only"], { timeoutMs: 60000 }); return true; }
  const parent = dirname(dir);
  const base = basename(dir);
  const envPath = join(dir, ".env");
  let existingEnv: string | null = null;
  try { existingEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : null; } catch { existingEnv = null; }
  mkdirSync(parent, { recursive: true });
  const preserved = snapshotPreservedPaths(dir, parent, base);

  for (const repo of FREELLM_REPOS) {
    const tmp = join(parent, `.${base}.clone-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    rmSync(tmp, { recursive: true, force: true });
    const ok = runner.exec(["git", "clone", "--depth", "1", repo, tmp], { timeoutMs: 120000 }).code === 0 && isCloned(tmp);
    if (ok) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
      restorePreservedPaths(preserved, dir);
      if (existingEnv && !existsSync(envPath)) {
        writeFileSync(envPath, existingEnv, { mode: 0o600 });
        try { chmodSync(envPath, 0o600); } catch { /* perms are best-effort */ }
      }
      if (preserved) rmSync(preserved, { recursive: true, force: true });
      return true;
    }
    rmSync(tmp, { recursive: true, force: true });
  }

  if (preserved) rmSync(preserved, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (existingEnv && !existsSync(envPath)) {
    writeFileSync(envPath, existingEnv, { mode: 0o600 });
    try { chmodSync(envPath, 0o600); } catch { /* perms are best-effort */ }
  }
  return false;
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Write .env with a generated ENCRYPTION_KEY + PORT. Preserves an existing .env (keeps the key that
 *  the at-rest provider keys were encrypted with). */
export function ensureEnv(dir: string, port: number): void {
  const envPath = join(dir, ".env");
  if (existsSync(envPath)) return;
  mkdirSync(dir, { recursive: true });
  // .env carries the ENCRYPTION_KEY that protects the user's provider keys at rest — owner-only.
  writeFileSync(envPath, `ENCRYPTION_KEY=${randomHex(32)}\nPORT=${port}\nHOST_BIND=127.0.0.1\n`, { mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* perms are best-effort */ }
}

// ── process lifecycle ─────────────────────────────────────────────────────────
/** Ensure a Node-run clone is buildable: install deps if `node_modules` is missing, build if the
 *  `dist/` entrypoint is absent. Idempotent and cheap on the happy path (both checks are stat-only), so
 *  it's safe to call before every (re)spawn — this is what hardens the heal path: a respawn no longer
 *  assumes a prior build survived. Returns false if a needed step fails. */
export function nodeBuild(dir: string, runner: Runner = realRunner, onProgress?: (m: string) => void): boolean {
  if (!existsSync(join(dir, "node_modules"))) {
    onProgress?.("installing dependencies (first run, may take a minute)…");
    if (runner.exec(["npm", "install"], { cwd: dir, timeoutMs: 600000 }).code !== 0) return false;
  }
  if (!existsSync(join(dir, NODE_ENTRY))) {
    onProgress?.("building the proxy…");
    if (runner.exec(["npm", "run", "build"], { cwd: dir, timeoutMs: 600000 }).code !== 0) return false;
  }
  return true;
}

/** Start the proxy. Docker: `docker compose up -d` (daemon-managed, persists). Node: ensure built
 *  (nodeBuild), then a detached `node server/dist/index.js` (pid recorded for stop()). Returns false on failure. */
export function start(dir: string, runtime: Runtime, port: number, runner: Runner = realRunner, onProgress?: (m: string) => void): boolean {
  const env = { PORT: String(port), HOST_BIND: "127.0.0.1" };
  if (runtime === "docker") {
    onProgress?.("starting the proxy (docker compose)…");
    return runner.exec(["docker", "compose", "up", "-d"], { cwd: dir, env, timeoutMs: 180000 }).code === 0;
  }
  if (!nodeBuild(dir, runner, onProgress)) return false;
  onProgress?.("launching the proxy…");
  const pid = runner.spawnDetached(["node", NODE_ENTRY], { cwd: dir, env });
  try { writeFileSync(join(dir, ".ob1-pid"), String(pid)); } catch { /* best-effort */ }
  return pid > 0;
}

/** Is the proxy responding? (GET /api/auth/status returns 200 once Express is up.) */
export async function isUp(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try { return (await fetchFn(`${url}/api/auth/status`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}

/** Poll until the proxy is up, or time out. */
export async function waitReady(url: string, fetchFn: typeof fetch = fetch, timeoutMs = 60000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await isUp(url, fetchFn)) return true; await new Promise((r) => setTimeout(r, 500)); }
  return false;
}

/** Ensure a previously-managed proxy is running again (called at boot). Docker: `up -d` is idempotent.
 *  Node: respawn if not already responding (the subprocess died with the last OB-1 session). */
export async function ensureRunning(s: ManagedState, runner: Runner = realRunner, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (await isUp(s.url, fetchFn)) return true;
  if (s.runtime === "docker") return start(s.dir, "docker", s.port, runner);
  // Node: a respawn can't assume a prior build survived (cleaned dist/, wiped node_modules, a `git pull`
  // that changed sources) — rebuild if needed before relaunching, else we'd spawn a process that exits.
  if (!nodeBuild(s.dir, runner)) return false;
  const pid = runner.spawnDetached(["node", NODE_ENTRY], { cwd: s.dir, env: { PORT: String(s.port), HOST_BIND: "127.0.0.1" } });
  try { writeFileSync(join(s.dir, ".ob1-pid"), String(pid)); } catch { /* best-effort — stop() also falls back */ }
  return pid > 0 && waitReady(s.url, fetchFn, 15000);
}

export function stop(s: ManagedState, runner: Runner = realRunner): void {
  if (s.runtime === "docker") { runner.exec(["docker", "compose", "down"], { cwd: s.dir }); return; }
  try { const pid = Number(readFileSync(join(s.dir, ".ob1-pid"), "utf8")); if (pid > 1) process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

export function formatManagedStatus(status: ManagedStatus): string {
  const proxy = status.proxyUp ? "proxy running" : "proxy stopped";
  const anon = status.anonymousModelsUsable === null
    ? "anonymous models unknown"
    : status.anonymousModelsUsable
      ? "anonymous models usable"
      : "anonymous models unavailable";
  const keys = status.providerKeys === null
    ? "provider keys unknown"
    : `${status.providerKeys} provider key${status.providerKeys === 1 ? "" : "s"}`;
  return `${proxy} · ${anon} · ${keys}`;
}

// ── dashboard auth + unified key (HTTP — tested against a mock) ────────────────
export type DashboardSetupResult =
  | { ok: true; token: string; existing: boolean }
  | { ok: false; existing: boolean; status?: number; message: string };

async function setupError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    return body?.error?.message ?? body?.error?.type ?? body?.error ?? body?.message ?? `HTTP ${res.status}`;
  } catch {
    return text.trim().slice(0, 300) || `HTTP ${res.status}`;
  }
}

async function tokenFromResponse(res: Response): Promise<string | null> {
  const body = await res.json().catch(() => ({})) as { token?: string };
  return body.token ?? null;
}

/** First-run dashboard account creation; falls back to login only when setup is already done. */
export async function dashboardSetupDetailed(url: string, email: string, password: string, fetchFn: typeof fetch = fetch): Promise<DashboardSetupResult> {
  const post = (path: string) => fetchFn(`${url}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10000),
  });
  try {
    const setup = await post("/api/auth/setup");
    if (setup.ok) {
      const token = await tokenFromResponse(setup);
      return token
        ? { ok: true, token, existing: false }
        : { ok: false, existing: false, status: setup.status, message: "setup response did not include a session token" };
    }
    if (setup.status !== 409) {
      return { ok: false, existing: false, status: setup.status, message: await setupError(setup) };
    }

    const login = await post("/api/auth/login");
    if (!login.ok) return { ok: false, existing: true, status: login.status, message: await setupError(login) };
    const token = await tokenFromResponse(login);
    return token
      ? { ok: true, token, existing: true }
      : { ok: false, existing: true, status: login.status, message: "login response did not include a session token" };
  } catch (e) {
    return { ok: false, existing: false, message: (e as Error).message };
  }
}

/** Back-compat helper: returns the dashboard SESSION token (gates /api/*), or null on failure. */
export async function dashboardSetup(url: string, email: string, password: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const result = await dashboardSetupDetailed(url, email, password, fetchFn);
  return result.ok ? result.token : null;
}

/** Fetch the proxy's unified API key (gates /v1) using the dashboard session. */
export async function fetchUnifiedKey(url: string, sessionToken: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`${url}/api/settings/api-key`, { headers: { authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return ((await res.json()) as { apiKey?: string }).apiKey ?? null;
  } catch { return null; }
}

/** Is the proxy serving any models? Note FreeLLMAPI ships anonymous providers (Pollinations/LLM7/OVH/
 *  Kilo), so /v1/models is non-empty even with ZERO user keys — i.e. this means "usable", NOT "the user
 *  added keys". Use providerKeyCount() for the latter. */
export async function isUsable(url: string, unifiedKey: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${url}/v1/models`, { headers: { authorization: `Bearer ${unifiedKey}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const body = await res.json() as { data?: unknown[] };
    return Array.isArray(body.data) && body.data.length > 0;
  } catch { return false; }
}

/** How many provider keys the user has added in the dashboard (GET /api/keys, dashboard-session-gated).
 *  This is the real "did they add keys?" signal (vs the always-on anonymous providers). -1 on error. */
export async function providerKeyCount(url: string, sessionToken: string, fetchFn: typeof fetch = fetch): Promise<number> {
  try {
    const res = await fetchFn(`${url}/api/keys`, { headers: { authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return -1;
    const body = await res.json() as unknown;
    const arr = Array.isArray(body) ? body : ((body as any)?.keys ?? (body as any)?.data);
    return Array.isArray(arr) ? arr.length : -1;
  } catch { return -1; }
}

export async function probeManagedStatus(s: ManagedState, fetchFn: typeof fetch = fetch): Promise<ManagedStatus> {
  const proxyUp = await isUp(s.url, fetchFn);
  if (!proxyUp) return { proxyUp, anonymousModelsUsable: null, providerKeys: s.providerKeys ?? null };

  const session = s.sessionToken;
  if (!session) return { proxyUp, anonymousModelsUsable: null, providerKeys: s.providerKeys ?? null };

  const unifiedKey = await fetchUnifiedKey(s.url, session, fetchFn);
  const anonymousModelsUsable = unifiedKey ? await isUsable(s.url, unifiedKey, fetchFn) : null;
  const count = await providerKeyCount(s.url, session, fetchFn);
  return {
    proxyUp,
    anonymousModelsUsable,
    providerKeys: count >= 0 ? count : (s.providerKeys ?? null),
  };
}
