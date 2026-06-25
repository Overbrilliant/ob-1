// MCP (Model Context Protocol) client — JSON-RPC 2.0 over three transports (R6/R7):
//   • stdio  — spawn the server as a subprocess, newline-delimited JSON (this file)
//   • http   — Streamable HTTP (POST per message, JSON or SSE response)   ┐ see ./http.ts
//   • sse    — legacy HTTP+SSE (GET event channel + POST endpoint)        ┘
// The JSON-RPC engine (id counter, pending map, initialize handshake, listTools/callTool) is
// transport-agnostic and lives in JsonRpcMcpClient; each transport only implements how a message
// is sent and how incoming messages reach dispatch().
import type { Subprocess } from "bun";

export interface McpServerConfig {
  /** Transport. Defaults to "stdio" when `command` is set, otherwise inferred from `url`. */
  type?: "stdio" | "http" | "sse";
  // stdio:
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http / sse:
  url?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

/** The surface every transport exposes (callers in manager.ts / index.ts depend only on this). */
export interface McpClient {
  readonly name: string;
  connect(timeoutMs?: number): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<string>;
  close(): void;
}

export const STDIO_PROTOCOL_VERSION = "2024-11-05";
export const HTTP_PROTOCOL_VERSION = "2025-03-26"; // Streamable HTTP requires 2025-03-26+

/** Transport-agnostic JSON-RPC 2.0 engine. Subclasses implement sendMessage() (how to put a
 *  serialized message on the wire) and call dispatch() when a message arrives. */
export abstract class JsonRpcMcpClient implements McpClient {
  abstract readonly name: string;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  /** Put one JSON-RPC message on the wire. May be sync (stdio) or async (http/sse). */
  protected abstract sendMessage(msg: object): void | Promise<void>;
  abstract connect(timeoutMs?: number): Promise<void>;
  abstract close(): void;

  /** Route an incoming parsed message to its waiting request, if any. JSON-RPC 2.0 allows the id
   *  to be a string; we always send numeric ids, so normalize a numeric-string echo back to a
   *  number before lookup (otherwise the response is dropped and the request waits for its timeout). */
  protected dispatch(msg: any): void {
    if (!msg || msg.id == null) return;
    const id = typeof msg.id === "string" && msg.id !== "" && !Number.isNaN(Number(msg.id)) ? Number(msg.id) : msg.id;
    if (!this.pending.has(id)) return;
    const p = this.pending.get(id)!;
    this.pending.delete(id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "mcp error"));
    else p.resolve(msg.result);
  }

  /** Fail every in-flight request (transport closed / errored). */
  protected failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  protected request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`mcp timeout: ${method}`)); }
      }, timeoutMs);
      // Wrap settlers to always clear the timeout (so a resolved request doesn't hold the event loop).
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      Promise.resolve(this.sendMessage({ jsonrpc: "2.0", id, method, params })).catch((e) => {
        if (this.pending.has(id)) { this.pending.delete(id); clearTimeout(timer); reject(e); }
      });
    });
  }

  protected notify(method: string, params: unknown): void {
    Promise.resolve(this.sendMessage({ jsonrpc: "2.0", method, params })).catch(() => {/* notifications are best-effort */});
  }

  /** initialize + notifications/initialized handshake, shared by every transport. */
  protected async handshake(protocolVersion: string, timeoutMs: number): Promise<void> {
    await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "ob1", version: "0.0.1" },
    }, timeoutMs);
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.request("tools/list", {});
    return (r?.tools ?? []) as McpTool[];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args ?? {} });
    const content = (r?.content ?? []) as { type: string; text?: string }[];
    const text = content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
    return r?.isError ? `[tool error] ${text}` : text;
  }
}

/** stdio transport: spawn the server and exchange newline-delimited JSON-RPC over stdin/stdout. */
export class StdioMcpClient extends JsonRpcMcpClient {
  readonly name: string;
  private cfg: McpServerConfig;
  private proc?: Subprocess<"pipe", "pipe", "pipe">;
  private buf = "";

  constructor(name: string, cfg: McpServerConfig) {
    super();
    this.name = name;
    this.cfg = cfg;
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    if (!this.cfg.command) throw new Error(`stdio mcp server "${this.name}" requires a "command"`);
    this.proc = Bun.spawn({
      cmd: [this.cfg.command, ...(this.cfg.args ?? [])],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.cfg.env },
    }) as Subprocess<"pipe", "pipe", "pipe">;
    this.readLoop().catch(() => this.failAll(new Error("mcp stdio stream closed")));
    await this.handshake(STDIO_PROTOCOL_VERSION, timeoutMs);
  }

  private async readLoop(): Promise<void> {
    if (!this.proc) return;
    const dec = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buf += dec.decode(chunk as Uint8Array);
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try { this.dispatch(JSON.parse(line)); } catch { /* skip malformed line */ }
      }
    }
  }

  protected sendMessage(msg: object): void {
    this.proc!.stdin.write(JSON.stringify(msg) + "\n");
    this.proc!.stdin.flush();
  }

  close(): void {
    try { this.proc?.kill(); } catch { /* already gone */ }
  }
}
