// LSP (Language Server Protocol) diagnostics client (parity with claw-code's lsp_client).
//
// Per-edit, line-precise diagnostics from a real language server — faster and more granular than a full
// project typecheck. Speaks JSON-RPC over stdio with Content-Length framing: initialize → didOpen → the
// server pushes textDocument/publishDiagnostics. A small server registry maps a file extension to its
// language server. The framing + client logic are transport-agnostic (testable against a mock server);
// getDiagnostics() spawns the real server. Dependency-free (Bun.spawn + node:* only).

export interface LspDiagnostic {
  path: string;
  line: number;      // 1-based
  character: number; // 1-based
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;   // e.g. "ts", "rust-analyzer"
  code?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

/** Encode a JSON-RPC message with the LSP `Content-Length` header framing. */
export function encodeMessage(msg: object): Uint8Array {
  const body = enc.encode(JSON.stringify(msg));
  return concat(enc.encode(`Content-Length: ${body.length}\r\n\r\n`), body);
}

/** Incremental reader: append raw bytes, get back any COMPLETE JSON-RPC messages. Handles partial
 *  chunks and multiple messages per chunk (the core that makes stdio framing robust). */
export class MessageBuffer {
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  append(chunk: Uint8Array): any[] {
    this.buf = concat(this.buf, chunk);
    const out: any[] = [];
    for (;;) {
      const sep = indexOfDoubleCRLF(this.buf);
      if (sep < 0) break;
      const header = dec.decode(this.buf.subarray(0, sep));
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue; } // malformed header → skip it
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) break; // body not fully arrived yet
      const body = dec.decode(this.buf.subarray(start, start + len));
      this.buf = this.buf.subarray(start + len);
      try { out.push(JSON.parse(body)); } catch { /* skip an unparseable body */ }
    }
    return out;
  }
}

function indexOfDoubleCRLF(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
}

const LSP_SEVERITY: Record<number, LspDiagnostic["severity"]> = { 1: "error", 2: "warning", 3: "information", 4: "hint" };

/** A duplex byte transport (the server's stdin/stdout). */
export interface Transport {
  write(bytes: Uint8Array): void;
  onMessage(cb: (msg: any) => void): void;
  close(): void;
}

/** Minimal JSON-RPC LSP client over a transport. Collects publishDiagnostics by document URI. */
export class LspClient {
  private id = 0;
  private pending = new Map<number, (res: any) => void>();
  private diags = new Map<string, LspDiagnostic[]>();
  constructor(private t: Transport) { t.onMessage((m) => this.onMessage(m)); }

  private onMessage(m: any): void {
    if (m && m.id != null && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); return; }
    if (m && m.method === "textDocument/publishDiagnostics" && m.params) {
      const uri: string = m.params.uri;
      const path = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
      this.diags.set(uri, (m.params.diagnostics ?? []).map((d: any): LspDiagnostic => ({
        path,
        line: (d.range?.start?.line ?? 0) + 1,
        character: (d.range?.start?.character ?? 0) + 1,
        severity: LSP_SEVERITY[d.severity] ?? "error",
        message: String(d.message ?? "").trim(),
        source: d.source, code: d.code != null ? String(d.code) : undefined,
      })));
    }
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    this.t.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  notify(method: string, params: unknown): void { this.t.write(encodeMessage({ jsonrpc: "2.0", method, params })); }

  async initialize(rootUri: string): Promise<void> {
    await this.request("initialize", { processId: null, rootUri, capabilities: { textDocument: { publishDiagnostics: {} } } });
    this.notify("initialized", {});
  }
  didOpen(uri: string, languageId: string, text: string): void {
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
  }
  diagnosticsFor(uri: string): LspDiagnostic[] | undefined { return this.diags.get(uri); }

  /** Wait until diagnostics for `uri` arrive (servers publish them async after didOpen), or timeout. */
  async waitForDiagnostics(uri: string, timeoutMs = 8000): Promise<LspDiagnostic[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const d = this.diags.get(uri);
      if (d !== undefined) return d;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.diags.get(uri) ?? [];
  }
  shutdown(): void { try { this.notify("exit", {}); } catch { /* closing */ } this.t.close(); }
}

// ── server registry: file extension → language server command ───────────────────────────────────
export interface ServerSpec { command: string; args: string[]; languageId: string }
const SERVERS: Record<string, ServerSpec> = {
  ts: { command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
  tsx: { command: "typescript-language-server", args: ["--stdio"], languageId: "typescriptreact" },
  js: { command: "typescript-language-server", args: ["--stdio"], languageId: "javascript" },
  jsx: { command: "typescript-language-server", args: ["--stdio"], languageId: "javascriptreact" },
  py: { command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  rs: { command: "rust-analyzer", args: [], languageId: "rust" },
  go: { command: "gopls", args: [], languageId: "go" },
};
export function serverFor(filePath: string): ServerSpec | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  return SERVERS[ext];
}
export function fileUri(absPath: string): string { return "file://" + absPath.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/"); }

/** Build a Transport from a spawned subprocess (its stdin FileSink + stdout stream). Drives a reader
 *  loop that feeds the MessageBuffer; the client's onMessage callback gets each parsed message. */
export function transportFromProc(proc: { stdin: any; stdout: ReadableStream<Uint8Array>; kill: () => void }): Transport {
  let cb: ((m: any) => void) | undefined;
  const buffer = new MessageBuffer();
  (async () => {
    const reader = proc.stdout.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) for (const m of buffer.append(value)) cb?.(m); } }
    catch { /* stream torn down on close */ }
  })();
  return {
    write: (b) => { try { proc.stdin.write(b); proc.stdin.flush?.(); } catch { /* server gone */ } },
    onMessage: (c) => { cb = c; },
    close: () => { try { proc.stdin.end?.(); } catch { /* ignore */ } try { proc.kill(); } catch { /* gone */ } },
  };
}

export interface DiagnosticsResult { available: boolean; reason?: string; diagnostics: LspDiagnostic[] }

/** Spawn the file's language server, open the file, and collect its diagnostics. available:false (with a
 *  reason) when no server is configured / the server isn't installed — never throws into the caller. */
export async function getDiagnostics(absPath: string, content: string, opts: { cwd: string; timeoutMs?: number }): Promise<DiagnosticsResult> {
  const spec = serverFor(absPath);
  if (!spec) return { available: false, reason: `no language server configured for ${absPath.slice(absPath.lastIndexOf("."))} files`, diagnostics: [] };
  const timeoutMs = opts.timeoutMs ?? 8000;
  let proc: any;
  try { proc = Bun.spawn([spec.command, ...spec.args], { cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" }); }
  catch { return { available: false, reason: `language server not installed: ${spec.command} (install it to enable diagnostics)`, diagnostics: [] }; }

  const client = new LspClient(transportFromProc(proc));
  const uri = fileUri(absPath);
  try {
    const init = await Promise.race([
      client.initialize(fileUri(opts.cwd)).then(() => "ok" as const),
      proc.exited.then(() => "died" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
    ]);
    if (init !== "ok") { client.shutdown(); return { available: false, reason: `language server ${spec.command} unavailable (not installed or failed to start)`, diagnostics: [] }; }
    client.didOpen(uri, spec.languageId, content);
    const diagnostics = await client.waitForDiagnostics(uri, timeoutMs);
    client.shutdown();
    return { available: true, diagnostics };
  } catch (e) { try { client.shutdown(); } catch { /* ignore */ } return { available: false, reason: (e as Error).message, diagnostics: [] }; }
}

/** Format diagnostics as compact lines for a tool result. */
export function formatDiagnostics(diags: LspDiagnostic[], relPath: string): string {
  if (!diags.length) return `✓ no diagnostics for ${relPath}`;
  const order = { error: 0, warning: 1, information: 2, hint: 3 } as const;
  return diags.slice().sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line)
    .map((d) => `${d.severity.toUpperCase()} ${relPath}:${d.line}:${d.character} ${d.message}${d.code ? ` [${d.code}]` : ""}${d.source ? ` (${d.source})` : ""}`)
    .join("\n");
}
