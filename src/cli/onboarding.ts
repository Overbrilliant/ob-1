// First-run onboarding (soft, pre-TUI). Runs once when the user has no configured model route:
// Start free (FreeLLMAPI) → own endpoint/env → hosted frontier. For the free path, OB-1 sets up and
// auto-wires the user's FreeLLMAPI proxy (see freellm-manage.ts). Plain readline prompts (same style as
// login.ts) so it works before the Ink TUI takes raw-mode stdin. Re-runnable via `ob1 onboard`.
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { detectEnvProvider, envRouteIsExplicitOverride, globalSettingsDir, loadAuthToken, persistActiveProvider, persistedSettings, persistSubscription, ob1ServerUrl } from "../config.ts";
import { runLogin, openBrowser, CLI_SOURCE, withSource } from "./login.ts";
import { banner, c } from "./ui.ts";
import { normalizeBaseUrl } from "../providers/profiles.ts";
import * as flm from "./freellm-manage.ts";

// ── decision helpers (pure — unit-tested) ─────────────────────────────────────
export interface OnboardState { tty: boolean; onboarded: boolean; hasProvider: boolean; hasEnvProvider: boolean }
/** Onboard interactively, once, only when there is no usable model route yet. The default route is the
 *  local FreeLLMAPI setup; hosted sign-in is now a deliberate paid-tier choice. */
export function decideOnboard(s: OnboardState): boolean {
  return s.tty && !s.onboarded && !s.hasProvider && !s.hasEnvProvider;
}
type ArrowSelection = number | "skip" | "abort";

/** A minimal up/down arrow selector for the pre-TUI onboarding (the Ink pickers aren't mounted yet).
 *  Returns the chosen index, "skip" for Esc, or "abort" for Ctrl-C. TTY-only (onboarding is). */
function arrowSelect(title: string, options: string[]): Promise<ArrowSelection> {
  return new Promise((resolve) => {
    let idx = 0;
    const draw = (first: boolean) => {
      if (!first) stdout.write(`\x1b[${options.length}A`); // back up to the first option row
      for (let i = 0; i < options.length; i++) {
        const sel = i === idx;
        stdout.write(`\r\x1b[2K  ${sel ? c.cyan("❯ ") + c.bold(options[i]) : "  " + c.dim(options[i])}\n`);
      }
    };
    stdout.write(`\n  ${c.bold(title)}  ${c.dim("(↑/↓ · Enter · Esc skips · Ctrl-C aborts)")}\n`);
    draw(true);
    const prevRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    const done = (val: ArrowSelection) => { stdin.off("data", onData); stdin.setRawMode?.(!!prevRaw); stdin.pause(); resolve(val); };
    const onData = (b: Buffer) => {
      const s = b.toString();
      if (s === "\x1b[A" || s === "k") { idx = (idx - 1 + options.length) % options.length; draw(false); }
      else if (s === "\x1b[B" || s === "j") { idx = (idx + 1) % options.length; draw(false); }
      else if (s === "\r" || s === "\n") done(idx);
      else if (s === "\x1b") done("skip");
      else if (s === "\x03") done("abort");
    };
    stdin.on("data", onData);
  });
}

function markerPath(dir = globalSettingsDir()): string { return join(dir, "onboarded"); }
export function isOnboarded(dir = globalSettingsDir()): boolean { return existsSync(markerPath(dir)); }
export function markOnboarded(dir = globalSettingsDir()): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(markerPath(dir), new Date().toISOString()); } catch { /* best-effort */ }
}
function abortOnboarding(out: (s?: string) => void): never {
  out("\n  Onboarding cancelled. Run `ob1 onboard` anytime.");
  process.exit(130);
}

/** Real-state gate used at boot. OB1_TOKEN is a deliberate opt-out for signed-in automation. A saved
 *  provider profile or existing auth token is a configured route. Named provider env keys are offered
 *  inside onboarding; only explicit OB1_BASE_URL suppresses it. */
export function shouldOnboard(): boolean {
  if (process.env.OB1_TOKEN) return false;
  const saved = persistedSettings(globalSettingsDir());
  const hasProvider = !!(saved.providerProfile && saved.providerUrl) || !!loadAuthToken();
  const envRoute = detectEnvProvider();
  return decideOnboard({ tty: !!stdin.isTTY, onboarded: isOnboarded(), hasProvider, hasEnvProvider: envRouteIsExplicitOverride(envRoute) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the flow ──────────────────────────────────────────────────────────────────
export async function runOnboarding(_opts: { force?: boolean } = {}): Promise<void> {
  const out = (s = "") => stdout.write(s + "\n");
  stdout.write(banner());                                   // the same OB-1 wordmark as the TUI
  out("");                                                  // breathing room above the welcome line
  out("");
  out("  Welcome — let's get you set up. Use ↑/↓ and Enter to choose.");
  let completed = false;
  try {
    const envRoute = detectEnvProvider();
    const p = await arrowSelect("How do you want to run models?", [
      "Start free       — OB-1 sets up FreeLLMAPI locally; anonymous bootstrap models + your keys",
      envRoute
        ? `Use ${envRoute.source} — ${envRoute.label}; runtime-only, no settings write`
        : "Use my endpoint — OpenAI-compatible URL/key, Ollama, LM Studio, llama.cpp, vLLM, LAN GPU",
      "Hosted frontier  — sign in + subscribe for Claude/GPT/Gemini/Qwen with one bill",
    ]);
    if (p === "abort") {
      abortOnboarding(out);
    } else if (p === "skip") {
      out("\n  Setup skipped. Run `ob1 onboard` anytime.");
      completed = true;
    } else if (p === 0) {
      // The free local path needs Docker or Node 20+. Detect the missing prereq UP FRONT: if neither is
      // present, don't dead-end the user with no model — say so and fall through to the other two routes
      // so onboarding always ends with a next action.
      if (!flm.detectRuntime()) {
        out("\n  ⚠ The free local path needs Docker or Node.js 20+, and neither was found.");
        out("    Install one (https://nodejs.org or https://docs.docker.com/get-docker/) to use it later —");
        out("    for now, let's get you a working model another way:");
        completed = await offerFallback(out, envRoute);
      } else {
        completed = await runFreeLLMSetup(out);
      }
    } else if (p === 1) {
      completed = await runOwnEndpointSetup(out, envRoute);
    } else if (p === 2) {
      completed = await runHostedSetup(out);
    }
  } catch (e) {
    out(`  Onboarding error: ${(e as Error).message} — you can finish setup later via /models.`);
  } finally {
    if (completed) markOnboarded();
    out("");
  }
}

/** Keep onboarding from dead-ending: when the free local path can't run (no Docker/Node) — or the user
 *  declines it — offer the two remaining routes so they ALWAYS leave with a working next action instead of
 *  no model at all. Returns true once a route is configured; false if the user skips (re-runnable via
 *  `ob1 onboard`). */
async function offerFallback(out: (s?: string) => void, envRoute = detectEnvProvider()): Promise<boolean> {
  const choice = await arrowSelect("How would you like to run models instead?", [
    envRoute
      ? `Use ${envRoute.source} — ${envRoute.label}; runtime-only, no settings write`
      : "Use my endpoint — OpenAI-compatible URL/key, Ollama, LM Studio, llama.cpp, vLLM, LAN GPU",
    "Hosted frontier  — sign in + subscribe for Claude/GPT/Gemini/Qwen with one bill",
  ]);
  if (choice === "abort") abortOnboarding(out);
  if (choice === 0) return runOwnEndpointSetup(out, envRoute);
  if (choice === 1) return runHostedSetup(out);
  out("\n  Setup skipped — run `ob1 onboard` anytime to finish.");
  return false;
}

// ── subscription (paid intelligent models via the managed server + Stripe) ────
/** Default model after subscribing — the frugal flagship default (registry `notes: "default"`); the
 *  user can switch to Opus/Sonnet/GPT/etc. anytime via /models. */
export const PAID_MODEL = "qwen/qwen3.6-plus";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type SubscribeResult = "activated" | "pending";
/** Side-effecting bits injected so the flow is unit-testable without a TTY or real network. */
export interface SubscribeDeps {
  server: string;
  token: string;
  fetchFn: typeof fetch;
  openUrl: (url: string) => void;
  persist: () => void;                 // wire the CLI to the managed server (persistSubscription)
  out: (s?: string) => void;
  pollMs?: number;
  maxPolls?: number;
  /** Attribution tag for the checkout URL opened in the browser (defaults to `${CLI_SOURCE}_upgrade`). */
  source?: string;
}

/** Forward the user to the server's pricing page — which owns cadence/tier selection and Stripe checkout
 *  end to end — then poll until the subscription activates. The browser is signed in via a one-time
 *  web-login ticket (traded from the CLI token), so "Choose a plan" flows straight to Stripe with no re-login.
 *  `persist()` runs first, so the CLI uses the managed server regardless of payment timing (chat then
 *  402s with an upgrade link until credits land). */
export async function subscribeFlow(d: SubscribeDeps): Promise<SubscribeResult> {
  // Point the CLI at the managed server now (so the provider is correct regardless of payment timing).
  d.persist();

  // Open the pricing page ALREADY SIGNED IN: trade the CLI bearer token for a one-time web-login URL so
  // the browser shares the same account. Then "Choose a plan" goes straight to Stripe (no login detour)
  // and the subscription attaches to this account automatically. Fall back to plain /pricing if the
  // handoff isn't available (older server) — the page will just prompt for sign-in.
  const source = d.source ?? `${CLI_SOURCE}_upgrade`;
  let pricingUrl = `${d.server}/pricing`;
  try {
    const r = await d.fetchFn(`${d.server}/v1/web-login`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ next: "/pricing", source }),
    });
    const b = await r.json().catch(() => ({})) as { url?: string };
    if (r.ok && b.url) pricingUrl = b.url;
  } catch { /* fall back to the plain pricing page */ }
  // Ensure the attribution tag is on the FINAL opened URL regardless of which branch produced it (the
  // server handoff or the plain fallback), so the checkout is always attributed to the CLI.
  pricingUrl = withSource(pricingUrl, source);

  d.out("\n  Opening the plans page in your browser — pick a plan and check out securely via Stripe.");
  d.out(`    ${pricingUrl}`);
  d.openUrl(pricingUrl);
  d.out("\n  Take your time — this advances automatically the moment your payment clears, so leave it");
  d.out("  running while you pick a plan and check out. (Press Ctrl-C to skip and set up later.)");

  // Patient by design: don't abandon a user who's mid-checkout. ~20 min at the 2s cadence; the loop
  // exits early the instant the plan goes paid, so a normal checkout never hits the cap.
  const maxPolls = d.maxPolls ?? 600;
  const pollMs = d.pollMs ?? 2000;
  for (let i = 0; i < maxPolls; i++) {
    try {
      const s = await (await d.fetchFn(`${d.server}/v1/billing/status`, { headers: { authorization: `Bearer ${d.token}` } })).json() as any;
      if (s?.plan && s.plan !== "free") {
        d.out(`\n  ✓ ${cap(s.plan)} plan active — $${s.credits_remaining ?? 0} of $${s.credits_per_month ?? 0} credits this month. You're all set.`);
        return "activated";
      }
    } catch { /* transient — keep polling */ }
    await sleep(pollMs);
  }
  d.out("\n  No active subscription yet — once payment completes, OB-1 uses it automatically.");
  d.out("  (Re-run `ob1 onboard` to re-check, or use /upgrade in the TUI.) Until then chat will prompt you to upgrade.");
  return "pending";
}

/** TTY wrapper: wires the managed server + browser, then forwards to the server's pricing page. */
async function runSubscriptionSetup(out: (s?: string) => void): Promise<void> {
  const token = loadAuthToken();
  if (!token) { out("\n  You need to be signed in first — re-run onboarding."); return; }
  await subscribeFlow({
    server: ob1ServerUrl(),
    token,
    fetchFn: fetch,
    openUrl: openBrowser,
    persist: () => persistSubscription(globalSettingsDir(), PAID_MODEL),
    out,
  });
}

async function runHostedSetup(out: (s?: string) => void): Promise<boolean> {
  if (!loadAuthToken()) {
    const choice = await arrowSelect("Hosted frontier models need an OB-1 account:", [
      "Create account",
      "Log in   (I already have one)",
    ]);
    if (choice === 0) await runLogin({ mode: "signup", source: `${CLI_SOURCE}_onboarding` });
    else if (choice === 1) await runLogin({ mode: "login", source: `${CLI_SOURCE}_onboarding` });
    else if (choice === "abort") {
      abortOnboarding(out);
    } else {
      out("\n  Hosted setup skipped. Start free anytime with `ob1 onboard` or /models.");
      return false;
    }
  } else {
    out("\n  ✓ Already signed in.");
  }
  if (!loadAuthToken()) return false;
  await runSubscriptionSetup(out);
  return true;
}

async function runOwnEndpointSetup(out: (s?: string) => void, envRoute = detectEnvProvider()): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (envRoute) {
      const ans = (await rl.question(`\n  Found ${envRoute.source} for ${envRoute.label}. Use it for this session? [Y/n] `)).trim().toLowerCase();
      if (!ans || ans === "y" || ans === "yes") {
        out(`  ✓ Using ${envRoute.label} from the environment. It is not written to ~/.ob1/settings.json.`);
        out(`    Endpoint: ${envRoute.baseUrl}`);
        out(`    Model: ${envRoute.model}`);
        return true;
      }
      out("  OK — let's save a custom endpoint instead.");
    }

    out("\n  Connect an OpenAI-compatible endpoint. Leave the API key blank for local servers with no auth.");
    const rawUrl = (await rl.question("    Endpoint URL (…/v1): ")).trim();
    const url = normalizeBaseUrl(rawUrl);
    if (!url) { out("  ✗ Need an endpoint URL. Start free anytime with `ob1 onboard`."); return false; }
    const model = (await rl.question("    Model id (e.g. auto, llama3.1, qwen2.5-coder): ")).trim();
    if (!model) { out("  ✗ Need a model id. Start free anytime with `ob1 onboard`."); return false; }
    const key = (await rl.question("    API key (optional): ")).trim();
    persistActiveProvider(globalSettingsDir(), "custom", url, key, model);
    out(`  ✓ Saved Custom endpoint ${url} with model ${model}.`);
    out("    Tip: named presets for OpenRouter, Ollama, LM Studio, llama.cpp, vLLM, and Groq are in /models.");

    return true;
  } finally {
    rl.close();
  }
}

/** I/O for the managed FreeLLMAPI setup, injected so the SAME pipeline runs under readline (onboarding,
 *  pre-TUI) and inside the Ink TUI (/freellm). `ask` is only used if an existing FreeLLMAPI dashboard
 *  account needs reconnecting; `waitForDone` resolves when the user signals they've finished adding keys
 *  on the dashboard (Enter), letting us do a final key count. */
export interface FreeLLMSetupDeps {
  ask: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  out: (s?: string) => void;
  openUrl: (url: string) => void;
  waitForDone: () => Promise<void>;
}

export function generatedDashboardCredentials(): { email: string; password: string } {
  const suffix = randomBytes(5).toString("hex");
  const password = randomBytes(18).toString("base64url");
  // Real TLD required: FreeLLMAPI's dashboard validates the email format and rejects invented TLDs
  // (`.ob1` → 400 "A valid email is required", which stalls first-run setup at the reconnect prompt).
  // The account is local-only and never emailed, so any well-formed domain we control works.
  return { email: `ob1-local-${suffix}@local.overbrilliant.com`, password };
}

/** The managed FreeLLMAPI pipeline: clone → run → dashboard account → auto-wire URL+unified key → open
 *  the dashboard for the user to add provider keys → wait → count. Best-effort + visibly narrated.
 *  Returns true once the proxy is connected (regardless of how many provider keys were added). */
export async function freeLLMSetupFlow(d: FreeLLMSetupDeps): Promise<boolean> {
  const runtime = flm.detectRuntime();
  if (!runtime) {
    d.out("  ⚠ Need Docker or Node.js (20+) to run Free LLM API locally. Install one and try again,");
    d.out("    or connect a provider manually via /models.");
    return false;
  }
  d.out(`  Using ${runtime === "docker" ? "Docker" : "Node.js"} to run the proxy.`);

  const dir = flm.installDir();
  d.out("  Downloading FreeLLMAPI…");
  if (!flm.ensureCloned(dir)) { d.out("  ✗ Couldn't download it (need git + network). Try again later."); return false; }

  const generated = generatedDashboardCredentials();
  d.out("\n  Creating a local FreeLLMAPI dashboard login for you.");
  d.out(`    Email: ${generated.email}`);
  d.out(`    Password: ${generated.password}`);
  d.out("    Use these if the dashboard asks you to sign in; change them later in the dashboard.");

  const port = await flm.freePort(3001);
  flm.ensureEnv(dir, port);
  const url = `http://localhost:${port}`;
  if (!flm.start(dir, runtime, port, flm.realRunner, (m) => d.out(`  ${m}`))) { d.out("  ✗ Failed to start the proxy. Check Docker/Node and try again."); return false; }
  d.out("  Waiting for the proxy to come up…");
  if (!(await flm.waitReady(url))) { d.out("  ✗ The proxy didn't come up in time. Try again."); return false; }

  let email = generated.email;
  let dashboardPassword = generated.password;
  let setup = await flm.dashboardSetupDetailed(url, generated.email, generated.password);
  let session = setup.ok ? setup.token : null;
  if (!setup.ok && setup.existing) {
    d.out("\n  An existing FreeLLMAPI dashboard account is already set up. Enter it to reconnect:");
    email = (await d.ask("Email")).trim();
    const password = (await d.ask("Password", { mask: true })).trim();
    if (!email || !password) { d.out("  ✗ Need the existing dashboard email and password. Try again."); return false; }
    dashboardPassword = password;
    setup = await flm.dashboardSetupDetailed(url, email, password);
    if (!setup.ok) {
      d.out(`  ✗ Couldn't sign in to the existing dashboard account: ${setup.message}. Try again.`);
      return false;
    }
    session = setup.token;
  } else if (!setup.ok) {
    d.out(`  ✗ Couldn't create the dashboard account: ${setup.message}. Try again.`);
    return false;
  }
  if (!session) { d.out("  ✗ Couldn't create the dashboard account: setup response did not include a session token. Try again."); return false; }
  const key = await flm.fetchUnifiedKey(url, session);
  if (!key) { d.out("  ✗ Couldn't read the proxy's API key. Try again."); return false; }

  // AUTO-WIRE: no manual URL/key entry — OB-1 knows both because it manages the proxy.
  persistActiveProvider(globalSettingsDir(), "freellmapi", `${url}/v1`, key);
  flm.saveManaged({ managed: true, dir, runtime, port, url, email, dashboardPassword, sessionToken: session, providerKeys: 0 });
  d.out(`  ✓ Connected OB-1 to your local proxy at ${url}/v1 (no key entry needed).`);
  d.out("    Anonymous bootstrap models may work right away; add your own provider keys for reliable capacity.");

  d.out("\n  Opening the dashboard — add your provider keys on the Keys page, then come back here.");
  d.openUrl(url);
  d.out("  Press Enter when you've added a provider key (or to skip — you can add them anytime)…");
  await d.waitForDone();
  let keys = 0;
  try { keys = await flm.providerKeyCount(url, session); } catch { keys = 0; }
  const st = flm.loadManaged();
  if (st) flm.saveManaged({ ...st, providerKeys: Math.max(0, keys) });
  d.out(keys > 0
    ? `  ✓ ${keys} provider key${keys === 1 ? "" : "s"} added — you're all set.`
    : "  No provider key added yet — anonymous bootstrap models are available when public pools have capacity. Add keys anytime; OB-1 picks them up. Manage with /freellm.");
  return true;
}

/** Onboarding (pre-TUI) entry: drive freeLLMSetupFlow with a plain readline (raw-mode arrow selectors
 *  above are closed by here, so a fresh rl is safe). */
async function runFreeLLMSetup(out: (s?: string) => void): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  // Masked prompt: readline still does the line editing, we just suppress the terminal ECHO so a password
  // isn't printed in cleartext (and left in scrollback). Without this, `{ mask: true }` was silently
  // ignored on the readline path. Falls back to a normal prompt if the echo hook isn't interceptable.
  const askMasked = async (q: string): Promise<string> => {
    const query = `    ${q}: `;
    const rlAny = rl as any;
    const orig = typeof rlAny._writeToOutput === "function" ? rlAny._writeToOutput.bind(rlAny) : (s: string) => stdout.write(s);
    let promptShown = false;
    rlAny._writeToOutput = (s: string) => {
      if (!promptShown) { orig(s); promptShown = true; return; } // show the prompt once
      if (s.includes("\n") || s.includes("\r")) orig("\n");      // keep the terminating newline
      // otherwise: swallow the echoed keystrokes (the value is still captured by readline)
    };
    try { return (await rl.question(query)).trim(); }
    finally { rlAny._writeToOutput = orig; }
  };
  try {
    return await freeLLMSetupFlow({
      ask: async (q, opts) => opts?.mask ? askMasked(q) : (await rl.question(`    ${q}: `)).trim(),
      out,
      openUrl: openBrowser,
      waitForDone: () => rl.question("").then(() => {}),
    });
  } finally {
    rl.close();
  }
}
