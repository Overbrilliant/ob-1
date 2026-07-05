// Deterministic smoke for first-run onboarding decision logic (src/cli/onboarding.ts).
// The interactive flow (readline) isn't unit-tested; the gate + routing + marker are.
// Usage: bun run scripts/onboarding-smoke.ts
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideOnboard, generatedDashboardCredentials, isOnboarded, markOnboarded, subscribeFlow } from "../src/cli/onboarding.ts";
import { detectEnvProvider } from "../src/config.ts";

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
  const creds = generatedDashboardCredentials();
  // Must use a REAL TLD: FreeLLMAPI's dashboard rejects invented TLDs like `.ob1` with a 400,
  // which stalls first-run setup at the reconnect prompt (found live 2026-07-02).
  check("generated FreeLLMAPI dashboard email is local and valid-looking", /^ob1-local-[0-9a-f]{10}@local\.overbrilliant\.com$/.test(creds.email));
  check("generated FreeLLMAPI dashboard password is strong enough for setup", creds.password.length >= 24);
}

// (auth + provider choice are now up/down arrow selectors — interactive, covered by manual e2e)

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
