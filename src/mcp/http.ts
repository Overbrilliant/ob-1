// MCP HTTP transports (R6/R7). Two protocol variants share the JSON-RPC engine in client.ts:
//   • StreamableHttpMcpClient — current spec (2025-03-26+): each JSON-RPC message is POSTed to a
//     single endpoint; the response is either application/json (one/array of messages) or a
//     text/event-stream the server closes after replying. A server-issued Mcp-Session-Id header is
//     captured at initialize and echoed on every later request; close() best-effort DELETEs it.
//   • SseMcpClient — legacy HTTP+SSE: a long-lived GET SSE channel carries server→client messages;
//     its first `event: endpoint` names the POST URL used for client→server messages.
// Every fetch is bounded by a timeout (no un-timed fetch — the silent-hang failure mode).
import { JsonRpcMcpClient, HTTP_PROTOCOL_VERSION, STDIO_PROTOCOL_VERSION, type McpServerConfig } from "./client.ts";

const CONNECT_TIMEOUT = 30_000; // per-fetch ceiling for request/response
const STREAM_IDLE = 600_000;    // max silence on a long-lived SSE channel before we give up

/** Parse a Server-Sent Events byte stream into {event, data} records. Handles multi-line `data:`,
 *  the `event:` field, `:`-comment keepalives, and chunk boundaries that split a line. Aborts if no
 *  bytes arrive for `idleMs` (kills the silent-hang failure mode). */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "message";
  let data = "";
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`mcp sse idle > ${idleMs}ms`)), idleMs); });
      const chunk = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") { // blank line = event boundary
          if (data) yield { event, data };
          event = "message"; data = "";
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keepalive
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data += (data ? "\n" : "") + value;
        // id / retry fields are ignored
      }
    }
    // Stream ended. Process a final line the server left without a trailing newline, then flush any event
    // not terminated by a blank line — otherwise a lone JSON-RPC response sent right before close is lost,
    // hanging the request to its idle timeout.
    const tail = buf.replace(/\r$/, "");
    if (tail && !tail.startsWith(":")) {
      const colon = tail.indexOf(":");
      const field = colon === -1 ? tail : tail.slice(0, colon);
      const value = colon === -1 ? "" : tail.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data += (data ? "\n" : "") + value;
    }
    if (data) yield { event, data };
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

/** Streamable HTTP transport (current MCP spec). */
export class StreamableHttpMcpClient extends JsonRpcMcpClient {
  readonly name: string;
  private cfg: McpServerConfig;
  private url: string;
  private sessionId?: string;

  constructor(name: string, cfg: McpServerConfig) {
    super();
    if (!cfg.url) throw new Error(`http mcp server "${name}" requires a "url"`);
    this.name = name;
    this.cfg = cfg;
    this.url = cfg.url;
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    await this.handshake(HTTP_PROTOCOL_VERSION, timeoutMs);
  }

  protected async sendMessage(msg: any): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.cfg.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202) return;                 // accepted notification — no body
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      const data = await res.json();
      for (const m of Array.isArray(data) ? data : [data]) this.dispatch(m);
    } else if (ctype.includes("text/event-stream") && res.body) {
      for await (const e of sseEvents(res.body, CONNECT_TIMEOUT)) {
        if (e.event && e.event !== "message") continue;
        try { this.dispatch(JSON.parse(e.data)); } catch { /* skip malformed */ }
      }
    } else {
      // Unknown / missing content-type on a 2xx with a body — a server that mislabels (or omits) the type
      // would otherwise have its valid JSON-RPC response ignored, hanging the request to its timeout.
      const text = await res.text().catch(() => "");
      if (text.trim()) {
        try { const data = JSON.parse(text); for (const m of Array.isArray(data) ? data : [data]) this.dispatch(m); }
        catch { /* genuinely not JSON (e.g. an empty notification ack) → nothing to dispatch */ }
      }
    }
  }

  close(): void {
    if (!this.sessionId) return;
    // Best-effort session teardown; never throw from close().
    fetch(this.url, {
      method: "DELETE",
      headers: { ...this.cfg.headers, "mcp-session-id": this.sessionId },
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {/* ignore */});
  }
}

/** Legacy HTTP+SSE transport (pre-2025 MCP). */
export class SseMcpClient extends JsonRpcMcpClient {
  readonly name: string;
  private cfg: McpServerConfig;
  private url: string;
  private endpoint?: string;
  private ctrl?: AbortController;

  constructor(name: string, cfg: McpServerConfig) {
    super();
    if (!cfg.url) throw new Error(`sse mcp server "${name}" requires a "url"`);
    this.name = name;
    this.cfg = cfg;
    this.url = cfg.url;
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    this.ctrl = new AbortController();
    // Bound the time-to-response-headers only (NOT the long-lived body): abort the connection if the
    // server never sends headers within timeoutMs, but clear the timer once headers arrive so the
    // SSE body can stream indefinitely. (Plain `signal` alone is un-timed — the silent-hang failure.)
    const connectTimer = setTimeout(() => this.ctrl?.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "GET",
        headers: { accept: "text/event-stream", ...this.cfg.headers },
        signal: this.ctrl.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }
    if (!res.ok || !res.body) { this.close(); throw new Error(`MCP SSE connect ${res.status}`); }

    try {
      // Resolve once the server names its POST endpoint (its first `event: endpoint`).
      let onEndpoint!: () => void;
      const endpointReady = new Promise<void>((resolve) => { onEndpoint = resolve; });

      // Background reader: dispatches server→client messages for the connection's lifetime.
      (async () => {
        try {
          for await (const e of sseEvents(res.body!, STREAM_IDLE)) {
            if (e.event === "endpoint") {
              this.endpoint = new URL(e.data, this.url).toString();
              onEndpoint();
            } else {
              try { this.dispatch(JSON.parse(e.data)); } catch { /* skip malformed */ }
            }
          }
          this.failAll(new Error("mcp sse stream closed"));
        } catch (err) {
          this.failAll(err as Error);
        }
      })();

      let endpointTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        endpointReady,
        new Promise<never>((_, rej) => { endpointTimer = setTimeout(() => rej(new Error("mcp sse: no endpoint event")), timeoutMs); }),
      ]).finally(() => clearTimeout(endpointTimer)); // don't leave a dangling timer after a fast connect
      await this.handshake(STDIO_PROTOCOL_VERSION, timeoutMs); // legacy servers speak the older version
    } catch (e) {
      this.close(); // abort the open stream + background reader on any connect failure (no leak)
      throw e;
    }
  }

  protected async sendMessage(msg: any): Promise<void> {
    if (!this.endpoint) throw new Error("mcp sse: endpoint not ready");
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.cfg.headers },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT),
    });
    // The reply arrives asynchronously on the GET SSE channel; only surface POST-level failures.
    if (!res.ok && res.status !== 202) throw new Error(`MCP SSE POST ${res.status}`);
  }

  close(): void {
    try { this.ctrl?.abort(); } catch { /* ignore */ }
  }
}
