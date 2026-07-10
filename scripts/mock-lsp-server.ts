// A minimal mock Language Server (LSP over stdio) for testing the LspClient — speaks Content-Length
// framing, answers `initialize`, and publishes canned diagnostics on `textDocument/didOpen`.
// Not a test itself; spawned BY lsp-smoke.ts. Usage: bun run scripts/mock-lsp-server.ts
import { MessageBuffer, encodeMessage } from "../src/context/lsp.ts";

const out = (msg: object) => Bun.write(Bun.stdout, encodeMessage(msg));
const buffer = new MessageBuffer();
const reader = Bun.stdin.stream().getReader();

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const m of buffer.append(value)) {
    if (m.method === "initialize") {
      await out({ jsonrpc: "2.0", id: m.id, result: { capabilities: { textDocumentSync: 1 } } });
    } else if (m.method === "textDocument/didOpen") {
      const uri = m.params?.textDocument?.uri;
      // Canned diagnostics: one error + one warning, so the client mapping is exercised.
      await out({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            { range: { start: { line: 4, character: 9 }, end: { line: 4, character: 12 } }, severity: 1, message: "Cannot find name 'foo'", source: "ts", code: 2304 },
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "'x' is declared but never used", source: "ts", code: 6133 },
          ],
        },
      });
    } else if (m.method === "exit") {
      break;
    }
    // notifications without a response (initialized, etc.) are ignored
  }
}
