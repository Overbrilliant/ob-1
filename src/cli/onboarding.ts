// First-run onboarding (soft, pre-TUI). Runs once when the user has no configured model route:
// Start free (embedded free-models router) → own endpoint/env → hosted frontier. The free path activates
// the in-process router (src/providers/free) — keyless providers work with zero setup — and offers to open
// the keys file so the user can unlock the bigger pools. Plain readline prompts (same style as login.ts) so
// it works before the Ink TUI takes raw-mode stdin. Re-runnable via `ob1 onboard`.
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { detectEnvProvider, envRouteIsExplicitOverride, globalSettingsDir, loadAuthToken, persistActiveProvider, persistedSettings, persistSubscription, ob1ServerUrl } from "../config.ts";
import { ensureKeysFile, freeStatus, runFreeHealthCheck } from "../providers/free/index.ts";
import { runLogin, openBrowser, CLI_SOURCE, withSource } from "./login.ts";
import { banner, c } from "./ui.ts";
import { normalizeBaseUrl } from "../providers/profiles.ts";

// ── decision helpers (pure — unit-tested) ─────────────────────────────────────
export interface OnboardState { tty: boolean; onboarded: boolean; hasProvider: boolean; hasEnvProvider: boolean }
/** Onboard interactively, once, only when there is no usable model route yet. The default route is the
 *  embedded free-models router; hosted sign-in is now a deliberate paid-tier choice. */
export function decideOnboard(s: OnboardState): boolean {
  return s.tty && !s.onboarded && !s.hasProvider && !s.hasEnvProvider;
}
type ArrowSelection = number | "skip" | "abort";

/** Grace window (ms) after a lone ESC byte before it counts as the Escape key. A split escape sequence
 *  (ESC then "[A" for an arrow) arrives within microseconds over a pty, so this disambiguates the two
 *  imperceptibly — and, crucially, a bare ESC resolves after the window instead of hanging forever. */
const ESC_GRACE_MS = 50;

/** A minimal up/down arrow selector for the pre-TUI onboarding (the Ink pickers aren't mounted yet).
 *  Returns the chosen index, "skip" for Esc, or "abort" for Ctrl-C. TTY-only (onboarding is). `input` is
 *  an injectable seam (defaults to process.stdin) so the key handling is unit-testable without a real pty. */
export function arrowSelect(
  title: string,
  options: string[],
  opts: { escHint?: string } = {},
  input: NodeJS.ReadStream = stdin,
): Promise<ArrowSelection> {
  return new Promise((resolve) => {
    let idx = 0;
    const draw = (first: boolean) => {
      if (!first) stdout.write(`\x1b[${options.length}A`); // back up to the first option row
      for (let i = 0; i < options.length; i++) {
        const sel = i === idx;
        stdout.write(`\r\x1b[2K  ${sel ? c.cyan("❯ ") + c.bold(options[i]) : "  " + c.dim(options[i])}\n`);
      }
    };
    // Esc's meaning differs by picker: the FIRST-RUN picker selects the free default (escHint), the
    // sub-pickers (hosted account / fallback) truly skip. Keep the hint honest per caller.
    stdout.write(`\n  ${c.bold(title)}  ${c.dim(`(↑/↓ · Enter · ${opts.escHint ?? "Esc skips"} · Ctrl-C aborts)`)}\n`);
    draw(true);
    const prevRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    let escTimer: ReturnType<typeof setTimeout> | undefined;
    const clearEsc = () => { if (escTimer) { clearTimeout(escTimer); escTimer = undefined; } };
    const done = (val: ArrowSelection) => { clearEsc(); input.off("data", onData); input.setRawMode?.(!!prevRaw); input.pause(); resolve(val); };
    const up = () => { idx = (idx - 1 + options.length) % options.length; draw(false); };
    const down = () => { idx = (idx + 1) % options.length; draw(false); };
    const onData = (b: Buffer) => {
      const s = b.toString();
      // A bare ESC is pending (grace window open): this chunk decides what it was. The tail of a split
      // escape sequence (an arrow) cancels the skip; anything else means it really was the Escape key.
      if (escTimer) {
        clearEsc();
        if (s === "[A" || s === "OA") return up();
        if (s === "[B" || s === "OB") return down();
        return done("skip"); // ESC stood alone (or was followed by an unrelated key) → skip
      }
      if (s === "\x1b[A" || s === "\x1bOA" || s === "k") return up();
      if (s === "\x1b[B" || s === "\x1bOB" || s === "j") return down();
      if (s === "\r" || s === "\n") return done(idx);
      if (s === "\x03") return done("abort");
      if (s === "\x1b") {
        // Lone ESC byte: the Escape key OR the first byte of an arrow's escape sequence delivered split
        // across reads (seen over some ptys). Wait a very short grace window; if no continuation arrives,
        // honor it as Escape → skip. THIS is what makes a bare ESC resolve instead of hanging.
        escTimer = setTimeout(() => { escTimer = undefined; done("skip"); }, ESC_GRACE_MS);
      }
    };
    input.on("data", onData);
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
      "Start free       — 150+ free models from 20+ providers; works instantly, add keys for more",
      envRoute
        ? `Use ${envRoute.source} — ${envRoute.label}; runtime-only, no settings write`
        : "Use my endpoint — OpenAI-compatible URL/key, Ollama, LM Studio, llama.cpp, vLLM, LAN GPU",
      "Hosted frontier  — sign in + subscribe for Claude/GPT/Gemini/Qwen with one bill",
    ], { escHint: "Esc starts free" });
    if (p === "abort") {
      abortOnboarding(out);
    } else if (p === 1) {
      completed = await runOwnEndpointSetup(out, envRoute);
    } else if (p === 2) {
      completed = await runHostedSetup(out);
    } else {
      // p === 0 (Start free) OR p === "skip" (Esc): Esc SELECTS the free default so the first-run picker
      // always ends with a working setup instead of a skipped-then-confusing state (README: "Pressing Esc at
      // the first picker starts the free path"). The embedded router has NO runtime dependency — no Docker,
      // no Node, no second process — so this path can't fail for lack of one: it activates immediately and
      // serves on keyless providers with zero keys.
      if (p === "skip") out("\n  Starting free (Ctrl-C to abort setup).");
      completed = await runFreeSetup(out);
    }
  } catch (e) {
    out(`  Onboarding error: ${(e as Error).message} — you can finish setup later via /models.`);
  } finally {
    if (completed) markOnboarded();
    out("");
  }
}

// ── the free path (embedded router — no runtime dependency) ───────────────────
const sleepFree = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open the keys file for editing during pre-TUI onboarding. Prefers the user's terminal editor
 *  ($VISUAL/$EDITOR, run synchronously with inherited stdio — safe HERE because the Ink TUI isn't mounted
 *  yet, so a full-screen terminal editor won't fight the raw-mode UI); else the OS "open with default app"
 *  (macOS `open -t`, Linux `xdg-open`); else just prints the path. Best-effort — never throws. */
function openKeysFile(path: string, out: (s?: string) => void): void {
  const editor = (process.env.VISUAL || process.env.EDITOR || "").trim();
  try {
    if (editor) {
      const [bin, ...args] = editor.split(/\s+/); // honor e.g. `EDITOR="code -w"`
      out(`\n  Opening ${path} in ${bin}…`);
      spawnSync(bin, [...args, path], { stdio: "inherit" });
      return;
    }
    if (process.platform === "darwin") {
      spawnSync("open", ["-t", path]);
      out(`\n  Opened ${path} in your default text editor.`);
      return;
    }
    if (process.platform === "linux") {
      spawnSync("xdg-open", [path]);
      out(`\n  Opened ${path}.`);
      return;
    }
  } catch {
    /* fall through to just printing the path */
  }
  out(`\n  Add your keys here: ${path}`);
}

/** The embedded free-models onboarding path. Activates the in-process router IMMEDIATELY (keyless providers
 *  serve with zero setup — no key, no account, no second process), creates the keys file, and OFFERS to open
 *  it so the user can paste free provider keys for the bigger pools. Always returns true: the router is live
 *  the moment the profile is persisted, so there is nothing to fail. */
async function runFreeSetup(out: (s?: string) => void): Promise<boolean> {
  // 1. Activate the embedded router now — keyless providers (Kilo, Pollinations, OVH, LLM7) need nothing.
  persistActiveProvider(globalSettingsDir(), "free", "", "", "auto");
  out("\n  ✓ Free models are on — 150+ free models across 20+ providers, routed automatically for you.");
  out("    Works out of the box on keyless providers; adding free API keys unlocks the big pools");
  out("    (Google, Groq, OpenRouter, …).");

  // 2. Create the keys file and offer to open it now.
  const path = ensureKeysFile();
  const choice = await arrowSelect("Add your free API keys now?", [
    "Open the keys file now (recommended)",
    "Skip — I'll add keys later",
  ]);
  if (choice === "abort") abortOnboarding(out);
  if (choice === 0) {
    openKeysFile(path, out);
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      await rl.question("\n  Press Enter once you've saved (or Enter to continue) ");
    } finally {
      rl.close();
    }
  }

  // 3. Kick a best-effort background health check (bounded — health is non-blocking by contract) and print a
  //    compact activation summary from the freshly reloaded status.
  await Promise.race([runFreeHealthCheck(true), sleepFree(4000)]).catch(() => {});
  const st = freeStatus();
  const keyed = st.providers.filter((p) => p.hasKey).length;
  const keyless = st.providers.filter((p) => p.keyless).length;
  out(
    `\n  ✓ ${keyed} provider${keyed === 1 ? "" : "s"} keyed · ${keyless} keyless — ${st.availableModels} of ${st.totalModels} models active`,
  );
  out(`    Add keys anytime: ${path} (or /free in the session).`);
  return true;
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

