// Deterministic smoke for first-run onboarding decision logic (src/cli/onboarding.ts).
// The interactive flow (readline) isn't unit-tested; the gate + routing + marker are.
// Usage: bun run scripts/onboarding-smoke.ts
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { arrowSelect, decideOnboard, isOnboarded, markOnboarded, subscribeFlow } from "../src/cli/onboarding.ts";
import { detectEnvProvider, loadConfig, persistActiveProvider } from "../src/config.ts";
import { ensureKeysFile } from "../src/providers/free/index.ts";

// Named env keys would otherwise shadow the persisted free profile in loadConfig — clear the ones that matter.
for (const k of ["OB1_MODEL", "OB1_BASE_URL", "OB1_API_KEY", "OB1_TOKEN"]) delete process.env[k];

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// A mock OB-1 server for subscribeFlow. The CLI trades its bearer token at /v1/web-login for a one-time
// already-signed-in pricing URL (so the browser shares the account), then polls /v1/billing/status until
// a paid plan lands. The server's pricing page owns cadence/tier selection + Stripe checkout.
// statusSeq is the plan returned per status poll; webLogin:false simulates an older server (no handoff).
function mockServer(opts: { statusSeq: string[]; webLogin?: boolean }) {
  const webLogin = opts.webLogin !== false;
  let statusCalls = 0;
  const calls: string[] = [];
  const fetchFn = (async (u: string, init?: any) => {
    const path = String(u).replace(/^https?:\/\/[^/]+/, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/v1/web-login") return webLogin
      ? new Response(JSON.stringify({ url: "http://x/cli/auth?ticket=tkt&next=%2Fpricing" }), { status: 200 })
      : new Response("not found", { status: 404 });
    if (path === "/v1/billing/status") { const plan = opts.statusSeq[Math.min(statusCalls++, opts.statusSeq.length - 1)]; return new Response(JSON.stringify({ plan, credits_remaining: plan === "free" ? 0 : 49, credits_per_month: plan === "free" ? 0 : 49 }), { status: 200 }); }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

// ── gate: onboard interactively, once, only when no model route exists ──
check("onboard when tty + fresh + no provider", decideOnboard({ tty: true, onboarded: false, hasProvider: false, hasEnvProvider: false }) === true);
check("no onboard on non-tty (pipe/CI)", decideOnboard({ tty: false, onboarded: false, hasProvider: false, hasEnvProvider: false }) === false);
check("no onboard once already onboarded", decideOnboard({ tty: true, onboarded: true, hasProvider: false, hasEnvProvider: false }) === false);
check("no onboard when a provider is already saved", decideOnboard({ tty: true, onboarded: false, hasProvider: true, hasEnvProvider: false }) === false);
check("no onboard when an explicit OB1_BASE_URL route is available", decideOnboard({ tty: true, onboarded: false, hasProvider: false, hasEnvProvider: true }) === false);
check("named env keys are offered during onboarding, not treated as already configured", decideOnboard({ tty: true, onboarded: false, hasProvider: false, hasEnvProvider: false }) === true);

{
  const env = { OPENROUTER_API_KEY: "or-test" } as any;
  check("detectEnvProvider finds OPENROUTER_API_KEY", detectEnvProvider(env)?.baseUrl === "https://openrouter.ai/api/v1");
  check("detectEnvProvider lets OB1_BASE_URL win over named keys", detectEnvProvider({ ...env, OB1_BASE_URL: "localhost:9999" } as any)?.baseUrl === "http://localhost:9999/v1");
}
{
  // The free onboarding path activates the EMBEDDED router with zero setup: it persists the "free" profile
  // + model "auto" and creates the keys template. Assert those effects hermetically (the interactive
  // open-editor prompt itself is covered by manual e2e). Pinned to a temp settings dir — never touches ~/.ob1.
  const prevDir = process.env.OB1_SETTINGS_DIR;
  const fdir = mkdtempSync(join(tmpdir(), "ob1-free-"));
  process.env.OB1_SETTINGS_DIR = fdir;
  try {
    persistActiveProvider(fdir, "free", "", "", "auto");
    const keysPath = ensureKeysFile();
    const cfg = loadConfig();
    check("free onboarding persists the 'free' profile + model 'auto'", cfg.providerProfile === "free" && cfg.provider === "free" && cfg.model === "auto");
    check("free onboarding creates the keys.env template", existsSync(keysPath) && keysPath.endsWith("keys.env"));
  } finally {
    if (prevDir === undefined) delete process.env.OB1_SETTINGS_DIR; else process.env.OB1_SETTINGS_DIR = prevDir;
    rmSync(fdir, { recursive: true, force: true });
  }
}

// ── arrowSelect key handling (injected mock stdin — deterministic, no real pty) ──
// Regression: a LONE ESC byte must resolve to "skip" (it once hung >40s over a pty because the handler
// only matched multi-byte sequences), while a SPLIT escape sequence (ESC then "[B") must still register
// as an arrow rather than a premature skip.
{
  class MockStdin extends EventEmitter {
    isRaw = false;
    setRawMode(v: boolean) { this.isRaw = v; return this; }
    resume() { return this; }
    pause() { return this; }
    feed(s: string) { this.emit("data", Buffer.from(s)); }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: () => boolean }).write = () => true; // silence the picker's redraw ANSI
  try {
    const race = async (p: Promise<unknown>) => Promise.race([p, sleep(600).then(() => "HANG")]);
    const m1 = new MockStdin();
    const p1 = arrowSelect("pick", ["a", "b"], {}, m1 as unknown as NodeJS.ReadStream);
    await sleep(5); m1.feed("\x1b");
    check("arrowSelect: a lone ESC resolves to skip (no hang)", (await race(p1)) === "skip");

    const m2 = new MockStdin();
    const p2 = arrowSelect("pick", ["a", "b"], {}, m2 as unknown as NodeJS.ReadStream);
    await sleep(5); m2.feed("\x1b[B"); m2.feed("\r");
    check("arrowSelect: down-arrow + Enter selects the next option", (await race(p2)) === 1);

    const m3 = new MockStdin();
    const p3 = arrowSelect("pick", ["a", "b"], {}, m3 as unknown as NodeJS.ReadStream);
    await sleep(5); m3.feed("\x1b"); await sleep(10); m3.feed("[B"); m3.feed("\r");
    check("arrowSelect: a split ESC+[B is an arrow, not a skip", (await race(p3)) === 1);

    const m4 = new MockStdin();
    const p4 = arrowSelect("pick", ["a", "b"], {}, m4 as unknown as NodeJS.ReadStream);
    await sleep(5); m4.feed("\x03");
    check("arrowSelect: Ctrl-C resolves to abort", (await race(p4)) === "abort");
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  }
}

// ── subscription flow (injected deps; no TTY/network) ──
// The flow now just forwards to the server's /pricing page (which owns cadence/tier + Stripe checkout)
// and polls /v1/billing/status until a paid plan lands.
{
  const m = mockServer({ statusSeq: ["free", "free", "pro"] });
  let persisted = 0; const opened: string[] = [];
  const res = await subscribeFlow({
    server: "http://x", token: "tok", fetchFn: m.fetchFn,
    openUrl: (u) => opened.push(u), persist: () => persisted++, out: () => {}, pollMs: 1, maxPolls: 10,
  });
  check("subscribe → activated once status flips to a paid plan", res === "activated");
  check("subscribe → traded the bearer token for a web-login URL", m.calls.includes("POST /v1/web-login"));
  check("subscribe → browser opened to the already-signed-in handoff URL", opened.length === 1 && opened[0].startsWith("http://x/cli/auth?"));
  check("subscribe → CLI persisted to the managed server", persisted === 1);
  check("subscribe → no in-CLI checkout call (the pricing page owns checkout)", !m.calls.some((c) => c.includes("checkout")));
}
{
  // Older server without the handoff: gracefully fall back to the plain pricing page.
  const m = mockServer({ statusSeq: ["free", "pro"], webLogin: false });
  const opened: string[] = [];
  const res = await subscribeFlow({
    server: "http://x", token: "tok", fetchFn: m.fetchFn,
    openUrl: (u) => opened.push(u), persist: () => {}, out: () => {}, pollMs: 1, maxPolls: 10,
  });
  check("subscribe → still activates without the web-login handoff", res === "activated");
  check("subscribe → falls back to /pricing (with CLI attribution) when handoff is unavailable", opened.length === 1 && opened[0].startsWith("http://x/pricing") && opened[0].includes("source=cli_upgrade"));
}
{
  const m = mockServer({ statusSeq: ["free", "free", "free"] });
  let persisted = 0;
  const res = await subscribeFlow({
    server: "http://x", token: "tok", fetchFn: m.fetchFn,
    openUrl: () => {}, persist: () => persisted++, out: () => {}, pollMs: 1, maxPolls: 3,
  });
  check("subscribe → pending when payment doesn't clear in time", res === "pending");
  check("subscribe → persists immediately, regardless of payment timing", persisted === 1);
}

// ── 'seen' marker round-trip (hermetic temp dir) ──
const dir = mkdtempSync(join(tmpdir(), "ob1-onb-"));
check("not onboarded before the marker is written", isOnboarded(dir) === false);
markOnboarded(dir);
check("onboarded after markOnboarded", isOnboarded(dir) === true && existsSync(join(dir, "onboarded")));

console.log("");
if (fail) { console.error("✗ onboarding smoke FAILED"); process.exit(1); }
console.log("✓ onboarding smoke passed");
