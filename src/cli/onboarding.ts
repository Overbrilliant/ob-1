// First-run onboarding (soft, skippable, pre-TUI). Runs once when the user is not signed in and has no
// provider configured: sign in → choose how to run models → for the free path, OB-1 sets up and
// auto-wires the user's FreeLLMAPI proxy (see freellm-manage.ts). Plain readline prompts (same style as
// login.ts) so it works before the Ink TUI takes raw-mode stdin. Re-runnable via `ob1 onboard`.
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { globalSettingsDir, loadAuthToken, persistActiveProvider, persistSubscription, ob1ServerUrl } from "../config.ts";
import { runLogin, openBrowser } from "./login.ts";
import { banner, c } from "./ui.ts";
import * as flm from "./freellm-manage.ts";

// ── decision helpers (pure — unit-tested) ─────────────────────────────────────
export interface OnboardState { tty: boolean; onboarded: boolean; signedIn: boolean }
/** Onboard whenever the user isn't signed in to OB-1 — interactively, once (the marker prevents
 *  nagging). Not gated on a configured provider: "not logged in → ask to log in or sign up". */
export function decideOnboard(s: OnboardState): boolean {
  return s.tty && !s.onboarded && !s.signedIn;
}
/** A minimal up/down arrow selector for the pre-TUI onboarding (the Ink pickers aren't mounted yet).
 *  Returns the chosen index, or null if the user skips (Ctrl-C / Esc). TTY-only (onboarding is). */
function arrowSelect(title: string, options: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    let idx = 0;
    const draw = (first: boolean) => {
      if (!first) stdout.write(`\x1b[${options.length}A`); // back up to the first option row
      for (let i = 0; i < options.length; i++) {
        const sel = i === idx;
        stdout.write(`\r\x1b[2K  ${sel ? c.cyan("❯ ") + c.bold(options[i]) : "  " + c.dim(options[i])}\n`);
      }
    };
    stdout.write(`\n  ${c.bold(title)}  ${c.dim("(↑/↓ · Enter · Esc skips)")}\n`);
    draw(true);
    const prevRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    const done = (val: number | null) => { stdin.off("data", onData); stdin.setRawMode?.(!!prevRaw); stdin.pause(); resolve(val); };
    const onData = (b: Buffer) => {
      const s = b.toString();
      if (s === "\x1b[A" || s === "k") { idx = (idx - 1 + options.length) % options.length; draw(false); }
      else if (s === "\x1b[B" || s === "j") { idx = (idx + 1) % options.length; draw(false); }
      else if (s === "\r" || s === "\n") done(idx);
      else if (s === "\x03" || s === "\x1b") done(null); // Ctrl-C / Esc → skip
    };
    stdin.on("data", onData);
  });
}

function markerPath(dir = globalSettingsDir()): string { return join(dir, "onboarded"); }
export function isOnboarded(dir = globalSettingsDir()): boolean { return existsSync(markerPath(dir)); }
export function markOnboarded(dir = globalSettingsDir()): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(markerPath(dir), new Date().toISOString()); } catch { /* best-effort */ }
}

/** Real-state gate used at boot. An explicit provider/token via ENV is a deliberate opt-out (BYOK
 *  power users — and test harnesses that pre-set a key): don't onboard. A saved provider PROFILE does
 *  NOT suppress it, so "logged out → ask to log in or sign up" still fires for normal users. */
export function shouldOnboard(): boolean {
  if (process.env.OB1_TOKEN || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || (process.env.OPENAI_API_KEY && process.env.OB1_BASE_URL)) return false;
  return decideOnboard({ tty: !!stdin.isTTY, onboarded: isOnboarded(), signedIn: !!loadAuthToken() });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the flow ──────────────────────────────────────────────────────────────────
export async function runOnboarding(_opts: { force?: boolean } = {}): Promise<void> {
  const out = (s = "") => stdout.write(s + "\n");
  stdout.write(banner());                                   // the same OB-1 wordmark as the TUI
  out("");                                                  // breathing room above the welcome line
  out("");
  out("  Welcome — let's get you set up. Use ↑/↓ and Enter to choose; Esc skips.");
  try {
    // 1) Authenticate — opens the server's sign-in page in the browser and waits for it to hand a token
    //    back (no passwords typed in the terminal). Choose Create account or Log in; Esc skips.
    if (!loadAuthToken()) {
      const choice = await arrowSelect("Sign in to OB-1 in your browser:", [
        "Create account",
        "Log in   (I already have one)",
      ]);
      if (choice === 0) await runLogin({ mode: "signup" });
      else if (choice === 1) await runLogin({ mode: "login" });
      else { out("\n  Skipped — run `ob1 login` later. The model stays disabled until you do."); markOnboarded(); out(""); return; }
    } else {
      out("\n  ✓ Already signed in.");
    }
    if (!loadAuthToken()) { markOnboarded(); out(""); return; } // sign-in skipped or failed → stop here

    // 2) Choose how to run models (arrow selector)
    const p = await arrowSelect("How do you want to run models?", [
      "Subscription   — frontier models (Opus, Sonnet, GPT, Gemini), monthly or yearly, no rate limits",
      "Free LLM API   — free, self-hosted, managed by OB-1, BYOK",
    ]);
    if (p === 0) await runSubscriptionSetup(out);
    else if (p === 1) await runFreeLLMSetup(out);
    else out("\n  Skipped — connect a provider anytime via /models.");
  } catch (e) {
    out(`  Onboarding error: ${(e as Error).message} — you can finish setup later via /models.`);
  } finally {
    markOnboarded();
    out("");
  }
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
  let pricingUrl = `${d.server}/pricing`;
  try {
    const r = await d.fetchFn(`${d.server}/v1/web-login`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ next: "/pricing" }),
    });
    const b = await r.json().catch(() => ({})) as { url?: string };
    if (r.ok && b.url) pricingUrl = b.url;
  } catch { /* fall back to the plain pricing page */ }

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
  d.out("  (Re-run `ob1 onboard` to re-check, or open /settings.) Until then chat will prompt you to upgrade.");
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

/** I/O for the managed FreeLLMAPI setup, injected so the SAME pipeline runs under readline (onboarding,
 *  pre-TUI) and inside the Ink TUI (Settings → Free LLM API). `ask` returns the entered text (mask hides
 *  it — readline can't, the TUI does); `waitForDone` resolves when the user signals they've finished
 *  adding keys on the dashboard (Enter), letting us do a final key count. */
export interface FreeLLMSetupDeps {
  ask: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  out: (s?: string) => void;
  openUrl: (url: string) => void;
  waitForDone: () => Promise<void>;
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

  d.out("\n  Set a login for your local FreeLLMAPI dashboard (you'll use it to add provider keys):");
  const email = (await d.ask("Email")).trim();
  const password = (await d.ask("Password (min 8 chars)", { mask: true })).trim();
  if (!email || password.length < 8) { d.out("  ✗ Need a valid email and an 8+ char password. Try again."); return false; }

  const port = await flm.freePort(3001);
  flm.ensureEnv(dir, port);
  const url = `http://localhost:${port}`;
  if (!flm.start(dir, runtime, port, flm.realRunner, (m) => d.out(`  ${m}`))) { d.out("  ✗ Failed to start the proxy. Check Docker/Node and try again."); return false; }
  d.out("  Waiting for the proxy to come up…");
  if (!(await flm.waitReady(url))) { d.out("  ✗ The proxy didn't come up in time. Try again."); return false; }

  const session = await flm.dashboardSetup(url, email, password);
  if (!session) { d.out("  ✗ Couldn't create the dashboard account. Try again."); return false; }
  const key = await flm.fetchUnifiedKey(url, session);
  if (!key) { d.out("  ✗ Couldn't read the proxy's API key. Try again."); return false; }

  // AUTO-WIRE: no manual URL/key entry — OB-1 knows both because it manages the proxy.
  persistActiveProvider(globalSettingsDir(), "freellmapi", `${url}/v1`, key);
  flm.saveManaged({ managed: true, dir, runtime, port, url, email, sessionToken: session, providerKeys: 0 });
  d.out(`  ✓ Connected OB-1 to your local proxy at ${url}/v1 (no key entry needed).`);
  d.out("    The free anonymous models work right away — add your own provider keys for more/better models.");

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
    : "  No provider key added yet — the free anonymous models still work. Add keys anytime; OB-1 picks them up. Manage under /settings → Free LLM API.");
  return true;
}

/** Onboarding (pre-TUI) entry: drive freeLLMSetupFlow with a plain readline (raw-mode arrow selectors
 *  above are closed by here, so a fresh rl is safe). */
async function runFreeLLMSetup(out: (s?: string) => void): Promise<void> {
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
    await freeLLMSetupFlow({
      ask: async (q, opts) => opts?.mask ? askMasked(q) : (await rl.question(`    ${q}: `)).trim(),
      out,
      openUrl: openBrowser,
      waitForDone: () => rl.question("").then(() => {}),
    });
  } finally {
    rl.close();
  }
}
