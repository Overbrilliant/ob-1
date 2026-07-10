// Deterministic test for the gateway's upstream-error retry policy (no network, no key).
// Verifies isRetryable's classification and callModel's retry loop via an injected dispatch:
// retry transient errors with onRetry notices, stop on success, never retry client errors / ESC /
// already-streamed output, and surface the last error after exhausting attempts.
// Usage: bun run scripts/retry-smoke.ts
import { callModel, isRetryable } from "../src/providers/gateway.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };
const baseOpts = () => ({ provider: "openai", apiKey: "k", baseUrl: "http://x", model: "m", system: "", messages: [] }) as any;
const savedEnv = process.env.OB1_MAX_RETRIES;

// ── isRetryable classification ──
check("isRetryable: 429 rate-limit", isRetryable(new Error("API 429: too many")) === true);
check("isRetryable: 500/502/503", ["API 500", "API 502: bad gw", "API 503"].every((m) => isRetryable(new Error(m))));
check("isRetryable: 400/401/403/404 are NOT retried", ["API 400: bad", "API 401", "API 403", "API 404"].every((m) => isRetryable(new Error(m)) === false));
check("isRetryable: idle timeout", isRetryable(new Error("stream idle > 90000ms")) === true);
check("isRetryable: network 'request failed'", isRetryable(new Error("request failed after 3 attempts: ECONNRESET")) === true);
check("isRetryable: generic/unknown → retry", isRetryable(new Error("boom")) === true);
const ab = new Error("aborted"); ab.name = "AbortError";
check("isRetryable: ESC/abort is NOT retried", isRetryable(ab) === false);

try {
  // ── retry a transient 5xx then succeed ──
  process.env.OB1_MAX_RETRIES = "5";
  {
    let calls = 0; const notices: any[] = [];
    const r = await callModel({ ...baseOpts(), onRetry: (i: any) => notices.push(i) }, async () => {
      calls++; if (calls < 3) throw new Error("API 503: upstream busy"); return { ok: true } as any;
    });
    check("retries a 5xx, then returns the success", (r as any).ok === true && calls === 3);
    check("onRetry fired once per retry with attempt/max", notices.length === 2 && notices[0].attempt === 1 && notices[0].max === 5 && notices[1].attempt === 2);
  }

  // ── idempotency key: ONE per logical call, STABLE across that call's retries, FRESH per new call ──
  // (the money-path guard so a retried request that already billed can be deduped by the server).
  {
    const seen: (string | undefined)[] = [];
    await callModel(baseOpts(), async (o: any) => { seen.push(o.idempotencyKey); if (seen.length < 3) throw new Error("API 503"); return { ok: true } as any; });
    const key = seen[0];
    check("idempotency key present + stable across a call's retries", seen.length === 3 && !!key && /^[0-9a-f-]{36}$/i.test(key) && seen.every((k) => k === key));
    const seen2: (string | undefined)[] = [];
    await callModel(baseOpts(), async (o: any) => { seen2.push(o.idempotencyKey); return { ok: true } as any; });
    check("a NEW logical call gets a fresh idempotency key", !!seen2[0] && seen2[0] !== key);
  }

  // ── client error (400) → throw immediately, no retry ──
  {
    let calls = 0, retries = 0, threw = false;
    try { await callModel({ ...baseOpts(), onRetry: () => retries++ }, async () => { calls++; throw new Error("API 400: bad request"); }); }
    catch { threw = true; }
    check("a 400 client error is not retried", threw && calls === 1 && retries === 0);
  }

  // ── ESC/abort → no retry even on a retryable error ──
  {
    const ac = new AbortController(); ac.abort();
    let calls = 0, threw = false;
    try { await callModel({ ...baseOpts(), signal: ac.signal }, async () => { calls++; throw new Error("API 503"); }); }
    catch { threw = true; }
    check("aborted (ESC) → no retry", threw && calls === 1);
  }

  // ── partial stream already emitted → don't retry (would duplicate output) ──
  {
    let calls = 0, retries = 0, threw = false;
    try {
      await callModel({ ...baseOpts(), onText: () => {}, onRetry: () => retries++ }, async (o: any) => {
        calls++; o.onText?.("partial answer…"); throw new Error("stream idle > 90000ms");
      });
    } catch { threw = true; }
    check("no retry after partial streamed output", threw && calls === 1 && retries === 0);
  }

  // ── exhaust attempts → surface the last error ──
  process.env.OB1_MAX_RETRIES = "2";
  {
    let calls = 0, retries = 0, msg = "";
    try { await callModel({ ...baseOpts(), onRetry: () => retries++ }, async () => { calls++; throw new Error("request failed after 3 attempts: ECONNRESET"); }); }
    catch (e) { msg = (e as Error).message; }
    check("exhausts MAX_RETRIES then throws the last error", calls === 2 && retries === 1 && /request failed/.test(msg));
  }
} finally {
  if (savedEnv === undefined) delete process.env.OB1_MAX_RETRIES; else process.env.OB1_MAX_RETRIES = savedEnv;
}

if (fail) { console.error("\n✗ retry smoke FAILED"); process.exit(1); }
console.log("\n✓ retry smoke passed (classification + retry/backoff + success/abort/client-error/partial-stream/exhaustion)");
process.exit(0);
