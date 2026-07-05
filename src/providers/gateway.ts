// Provider gateway — single entry point the agent loop calls. Runtime model traffic is restricted to
// OpenAI-compatible routes: managed OB-1 server, FreeLLMAPI, or Custom API. This module also owns the
// upstream-error retry policy.
import type { CallOpts, ModelResponse } from "./types.ts";
import { callOpenAI } from "./openai.ts";

export * from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Exponential backoff with jitter, capped at 8s. */
function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/** Max model-call attempts on retryable upstream errors. Default 10; override with OB1_MAX_RETRIES
 *  (read per-call so it can be changed without a restart). */
function maxAttempts(): number { return Math.max(1, Number(process.env.OB1_MAX_RETRIES) || 10); }

/** Should this error be retried? Retry transient upstream failures (network drop, idle timeout,
 *  429 rate-limit, 5xx, bad gateway, a non-stream/empty body from a flaky proxy). Do NOT retry a
 *  user cancel (ESC) or a real client error (400/401/403/404) — those won't fix themselves. */
export function isRetryable(e: Error): boolean {
  if (e.name === "AbortError") return false;                 // ESC / external cancel
  const m = e.message || "";
  const api = m.match(/API (\d{3})/);                        // http.ts throws `API <status>: …`
  if (api) { const s = Number(api[1]); return s === 429 || s >= 500; }
  return true; // network failure, "stream idle > …", "request failed after …", content-type/empty body, unknown
}

/** Dispatch to the provider, retrying transient upstream errors up to MAX_ATTEMPTS with backoff.
 *  Streaming-safe: once any text/reasoning has been emitted we do NOT retry (re-running would
 *  duplicate the streamed output) — that failure surfaces to the caller instead. */
export async function callModel(
  opts: CallOpts,
  _dispatch?: (o: CallOpts) => Promise<ModelResponse>, // injectable for tests; defaults to the real providers
): Promise<ModelResponse> {
  const dispatch = _dispatch ?? ((o: CallOpts) => {
    if (String(o.provider) !== "openai") throw new Error(`unsupported model provider route: ${String(o.provider)}`);
    return callOpenAI(o);
  });
  const max = maxAttempts();
  // One idempotency key per LOGICAL call, generated ONCE here so it stays stable across this call's
  // internal retries below (each new callModel invocation gets a fresh one). Threaded into the request
  // headers as `Idempotency-Key` so the server's replay cache can dedupe a retried request that already
  // billed — the money-path guard against a double-charge when we resend after a transient failure.
  const idempotencyKey = crypto.randomUUID();
  let produced = false;
  const tap = (fn?: (d: string) => void) => (fn ? (d: string) => { produced = true; fn(d); } : undefined);
  const inner: CallOpts = { ...opts, idempotencyKey, onText: tap(opts.onText), onReasoning: tap(opts.onReasoning) };

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await dispatch(inner);
    } catch (e) {
      const err = e as Error;
      lastErr = err;
      // Don't retry: user cancelled, nothing more will change (client error), we already streamed
      // partial output, or we're out of attempts.
      if (opts.signal?.aborted || !isRetryable(err) || produced || attempt === max) throw err;
      const delayMs = backoff(attempt - 1);
      opts.onRetry?.({ attempt, max, delayMs, error: err.message });
      await sleep(delayMs);
    }
  }
  throw lastErr ?? new Error("callModel: exhausted retries"); // unreachable
}
