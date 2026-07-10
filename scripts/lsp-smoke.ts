// Test the LSP diagnostics client: message framing (pure), and the full client flow against a MOCK
// language server over real stdio pipes. Usage: bun run scripts/lsp-smoke.ts
import { encodeMessage, MessageBuffer, LspClient, transportFromProc, serverFor, fileUri, formatDiagnostics, getDiagnostics, type LspDiagnostic } from "../src/context/lsp.ts";
import { join, dirname } from "node:path";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };
const here = dirname(Bun.fileURLToPath(import.meta.url));

// ── framing: encode/decode round-trip + partial chunks + multiple-per-chunk ───
const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { x: 1 } };
const bytes = encodeMessage(msg);
check("encodeMessage emits a Content-Length header", new TextDecoder().decode(bytes).startsWith("Content-Length: "));
{
  const buf = new MessageBuffer();
  const got = buf.append(bytes);
  check("MessageBuffer decodes a whole message", got.length === 1 && got[0].method === "initialize");
}
{
  // split mid-body across two chunks → no message until complete
  const buf = new MessageBuffer();
  const half = Math.floor(bytes.length / 2);
  check("partial chunk yields nothing yet", buf.append(bytes.subarray(0, half)).length === 0);
  check("completing the chunk yields the message", buf.append(bytes.subarray(half)).length === 1);
}
{
  // two messages in one chunk
  const buf = new MessageBuffer();
  const two = new Uint8Array([...encodeMessage({ id: 1 }), ...encodeMessage({ id: 2 })]);
  const got = buf.append(two);
  check("two messages in one chunk both decode", got.length === 2 && got[0].id === 1 && got[1].id === 2);
}

// ── registry + uri ─────────────────────────────────────────────────────────────
check("serverFor maps .ts → typescript-language-server", serverFor("/a/b.ts")?.command === "typescript-language-server");
check("serverFor maps .rs → rust-analyzer", serverFor("/a/b.rs")?.command === "rust-analyzer");
check("serverFor unknown ext → undefined", serverFor("/a/b.zzz") === undefined);
check("fileUri builds a file:// uri", fileUri("/a/b c.ts").startsWith("file:///a/b"));

// ── formatting ──────────────────────────────────────────────────────────────
const ds: LspDiagnostic[] = [
  { path: "f.ts", line: 5, character: 10, severity: "error", message: "Cannot find name 'foo'", source: "ts", code: "2304" },
  { path: "f.ts", line: 1, character: 1, severity: "warning", message: "unused", source: "ts" },
];
check("formatDiagnostics sorts errors first, renders location", (() => { const s = formatDiagnostics(ds, "f.ts"); return s.startsWith("ERROR f.ts:5:10") && s.includes("[2304]") && s.includes("WARNING f.ts:1:1"); })());
check("formatDiagnostics on empty → clean", formatDiagnostics([], "f.ts").startsWith("✓ no diagnostics"));

// ── full client flow against the MOCK server (real stdio pipes) ───────────────
{
  const proc = Bun.spawn(["bun", "run", join(here, "mock-lsp-server.ts")], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const client = new LspClient(transportFromProc(proc as any));
  await client.initialize(fileUri("/workspace"));
  const uri = fileUri("/workspace/sample.ts");
  client.didOpen(uri, "typescript", "const x = 1;\nfoo();\n");
  const diags = await client.waitForDiagnostics(uri, 5000);
  check("client receives published diagnostics from the server", diags.length === 2);
  check("severity 1 → error, 0-based range mapped to 1-based line/char", diags.some((d) => d.severity === "error" && d.line === 5 && d.character === 10 && /Cannot find name/.test(d.message)));
  check("severity 2 → warning, code+source carried", diags.some((d) => d.severity === "warning" && d.code === "6133" && d.source === "ts"));
  check("uri → filesystem path decoded", diags[0].path === "/workspace/sample.ts");
  client.shutdown();
}

// ── getDiagnostics graceful fallbacks ─────────────────────────────────────────
{
  const noServer = await getDiagnostics("/tmp/x.zzz", "stuff", { cwd: "/tmp" });
  check("getDiagnostics: no server for unknown ext → available:false (graceful)", !noServer.available && /no language server configured/.test(noServer.reason ?? ""));
  // a known ext whose server typically isn't installed → must return gracefully (no throw), either
  // unavailable (the common case) or available with a diagnostics array (if the server happens to exist).
  const r = await getDiagnostics("/tmp/x.go", "package main", { cwd: "/tmp", timeoutMs: 1500 });
  check("getDiagnostics: missing/absent server handled gracefully (no throw)", typeof r.available === "boolean" && Array.isArray(r.diagnostics));
}

if (fail) { console.error("\n✗ lsp smoke FAILED"); process.exit(1); }
console.log("\n✓ lsp smoke passed");
