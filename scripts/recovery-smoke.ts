// Deterministic test for recovery recipes + the attempt-budget ledger (no network).
// Usage: bun run scripts/recovery-smoke.ts
import { classifyFailure, recipeFor, recoveryHint, RecoveryLedger } from "../src/agent/recovery.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── classifyFailure: map error strings → scenarios ────────────────────────────
const cases: [string, string | null][] = [
  ["API 429: rate limit exceeded", "rate_limited"],
  ["too many requests, please slow down", "rate_limited"],
  ["API 503: upstream unavailable", "provider_failure"],
  ["stream idle > 60s", "provider_failure"],
  ["API 401: invalid api key", "auth_failure"],
  ["token expired", "auth_failure"],
  ["MCP server failed to initialize (handshake timeout)", "mcp_handshake"],
  ["bash: pytest: command not found", "missing_tool"],
  ["spawn rg ENOENT", "missing_tool"],
  ["! [rejected] main -> main (non-fast-forward)", "stale_branch"],
  ["Your branch is behind 'origin/main' by 3 commits", "stale_branch"],
  ["error TS2304: cannot find name 'foo'", "compile_red"],
  ["2 failing tests", "compile_red"],
  ["something totally unrecognized happened", null],
];
for (const [msg, want] of cases) check(`classify: ${msg.slice(0, 38)} → ${want}`, classifyFailure(msg) === want);

// ── recipeFor: structured recovery ────────────────────────────────────────────
check("recipeFor returns summary + steps", recipeFor("rate_limited").steps.length > 0 && recipeFor("rate_limited").summary.length > 0);
check("rate_limited is auto-attemptable", recipeFor("rate_limited").autoAttemptable);
check("auth_failure is NOT auto-attemptable (needs the user)", !recipeFor("auth_failure").autoAttemptable);
check("stale_branch is NOT auto-attemptable", !recipeFor("stale_branch").autoAttemptable);

// ── recoveryHint: a one-line user-facing fix ───────────────────────────────────
check("recoveryHint surfaces a known fix", /Recovery \(rate_limited\)/.test(recoveryHint("API 429: slow down")));
check("recoveryHint auth covers managed, FreeLLMAPI, and Custom API", /ob1 login/.test(recoveryHint("API 401: invalid api key")) && /\/freellm/.test(recoveryHint("API 401: invalid api key")) && /\/models/.test(recoveryHint("API 401: invalid api key")));
check("recoveryHint is empty for an unknown error", recoveryHint("???") === "");

// ── RecoveryLedger: one auto-attempt before escalation + structured events ─────
const led = new RecoveryLedger(1);
check("auto-attemptable scenario may recover initially", led.shouldAutoRecover("provider_failure", "turn"));
check("non-auto-attemptable scenario never auto-recovers (straight to user)", !led.shouldAutoRecover("auth_failure", "turn"));
check("non-auto-attemptable scenario is escalated immediately", led.escalated("auth_failure", "turn"));

const ev = led.record("provider_failure", "turn", "gateway retry", false, "2026-06-24T00:00:00Z");
check("record returns a structured event (attempt 1)", ev.attempt === 1 && ev.scenario === "provider_failure" && ev.ts === "2026-06-24T00:00:00Z");
check("budget spent after one attempt → no more auto-recovery", !led.shouldAutoRecover("provider_failure", "turn"));
check("escalated after the auto budget is spent", led.escalated("provider_failure", "turn"));
check("a DIFFERENT key has its own independent budget", led.shouldAutoRecover("provider_failure", "other-turn"));
check("events() returns the recorded log", led.events().length === 1 && led.events()[0].action === "gateway retry");

// budget of 2
const led2 = new RecoveryLedger(2);
led2.record("mcp_handshake", "srvA", "reconnect");
check("budget 2: still recoverable after 1 attempt", led2.shouldAutoRecover("mcp_handshake", "srvA"));
led2.record("mcp_handshake", "srvA", "reconnect");
check("budget 2: escalated after 2 attempts", led2.escalated("mcp_handshake", "srvA"));

if (fail) { console.error("\n✗ recovery smoke FAILED"); process.exit(1); }
console.log("\n✓ recovery smoke passed");
