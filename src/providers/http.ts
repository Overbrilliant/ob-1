// Shared HTTP for the providers: streaming SSE with an IDLE timeout + connect-level retries.
//
// Why idle-timeout (not total-timeout): a long generation legitimately takes minutes, so a total
// cap would abort real work. Instead we abort only when NO bytes arrive for `idleMs` — which also
// kills the silent-hang failure mode (a dropped connection stops producing chunks → idle abort →
// the caller can retry) that a plain un-timed `fetch` would hang on forever.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, capped. */
function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

export interface StreamOpts {
  url: string;
  headers: Record<string, string>;
  body: string;
  idleMs?: number;     // abort if no chunk for this long (default 90s)
  retries?: number;    // connect-level retries on network error / 429 / 5xx (default 2)
  signal?: AbortSignal; // external cancellation (e.g. ESC) — aborts the request + stops the stream
}

/** Raised when the caller (ESC) cancels — distinguishable from a real failure so it's reported as
 *  "stopped" rather than an error. */
export class AbortedError extends Error { constructor() { super("aborted"); this.name = "AbortError"; } }

/** POST a request and yield parsed `data:` JSON objects from the SSE response. Skips `[DONE]`.
 *  Retries the CONNECTION (not a partial stream) on transient failures; aborts on idle OR the
 *  external signal (which propagates as AbortedError). */
export async function* streamSSE(opts: StreamOpts): AsyncGenerator<any> {
  const idleMs = opts.idleMs ?? 90_000;
  const retries = opts.retries ?? 2;
  const ext = opts.signal;
  const stopped = () => ext?.aborted ?? false;
  if (stopped()) throw new AbortedError();

  let res: Response | undefined;
  let lastErr: unknown;
  let active: AbortController | null = null;
  const onExtAbort = () => active?.abort();
  ext?.addEventListener("abort", onExtAbort);
  try {
  for (let attempt = 0; attempt <= retries; attempt++) {
    active = new AbortController();
    const ctrl = active;
    const connectTimer = setTimeout(() => ctrl.abort(), idleMs); // time-to-first-byte bound
    try {
      res = await fetch(opts.url, { method: "POST", headers: opts.headers, body: opts.body, signal: ctrl.signal });
      clearTimeout(connectTimer);
      if ((res.status === 429 || res.status >= 500) && attempt < retries && !stopped()) {
        // Release the unread error body before retrying — an undrained response body pins the underlying
        // socket (it isn't returned to the pool until consumed/cancelled), leaking a connection per retry.
        try { await res.body?.cancel(); } catch { /* already closed */ }
        await sleep(backoff(attempt)); continue;
      }
      break;
    } catch (e) {
      clearTimeout(connectTimer);
      lastErr = e;
      if (stopped()) throw new AbortedError();            // ESC: don't retry, report as stopped
      if (attempt < retries) { await sleep(backoff(attempt)); continue; }
      throw new Error(`request failed after ${retries + 1} attempts: ${(e as Error).message}`);
    }
  }
  if (!res) throw new Error(`request failed: ${(lastErr as Error)?.message ?? "unknown"}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 800)}`);
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("event-stream")) {
    // Non-streaming server: surface loudly rather than silently yielding nothing.
    throw new Error(`expected text/event-stream, got "${ctype}": ${(await res.text()).slice(0, 400)}`);
  }
  if (!res.body) throw new Error("streaming response had no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (stopped()) throw new AbortedError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`stream idle > ${idleMs}ms`)), idleMs); });
      const chunk = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // ignore `event:` lines / comments / blanks
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { yield JSON.parse(payload); } catch { /* skip malformed keep-alive fragments */ }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  } finally {
    ext?.removeEventListener("abort", onExtAbort);
  }
}
