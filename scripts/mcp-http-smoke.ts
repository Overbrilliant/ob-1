// Smoke test: MCP HTTP transports (no network — local Bun.serve mocks). Covers the transport
// factory dispatch, the Streamable HTTP client (JSON + SSE responses, session-id propagation),
// and the legacy HTTP+SSE client (GET event channel + POST endpoint).
// Usage: bun run scripts/mcp-http-smoke.ts
import { StreamableHttpMcpClient, SseMcpClient } from "../src/mcp/http.ts";
import { StdioMcpClient } from "../src/mcp/client.ts";
import { createMcpClient } from "../src/mcp/manager.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

const ECHO = { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } };

// --- transport factory dispatch ---
check("factory: stdio by default when command set", createMcpClient("a", { command: "x" }) instanceof StdioMcpClient);
check("factory: http when type=http", createMcpClient("b", { type: "http", url: "http://x" }) instanceof StreamableHttpMcpClient);
check("factory: sse when type=sse", createMcpClient("c", { type: "sse", url: "http://x" }) instanceof SseMcpClient);
check("factory: http inferred from url (no command)", createMcpClient("d", { url: "http://x" }) instanceof StreamableHttpMcpClient);

// --- Streamable HTTP mock: JSON for init/list, SSE for call; requires the session id after init ---
let httpSawSession = false;
const httpServer = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    const msg: any = await req.json();
    if (msg.id == null) return new Response(null, { status: 202 }); // notification
    // Echo the id back as a STRING (JSON-RPC 2.0 allows it) — regression guard for dispatch() id
    // normalization. Without it, every request would miss its pending entry and hang to timeout.
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: String(msg.id), result });
    if (msg.method === "initialize")
      return Response.json(reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-http", version: "1" } }), { headers: { "mcp-session-id": "sess-abc" } });
    if (req.headers.get("mcp-session-id") !== "sess-abc") return new Response("missing session", { status: 400 });
    if (msg.method === "tools/list") { httpSawSession = true; return Response.json(reply({ tools: [ECHO] })); }
    if (msg.method === "tools/call") {
      const payload = JSON.stringify(reply({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] }));
      return new Response(`event: message\ndata: ${payload}\n\n`, { headers: { "content-type": "text/event-stream" } }); // SSE response path
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  },
});
const hc = new StreamableHttpMcpClient("mock-http", { type: "http", url: `http://127.0.0.1:${httpServer.port}/mcp` });
await hc.connect();
const ht = await hc.listTools();
const ho = await hc.callTool("echo", { text: "hello HTTP" });
hc.close();
httpServer.stop(true);
check("http: lists the echo tool (string-id responses normalized)", ht.length === 1 && ht[0].name === "echo");
check("http: tool annotated read-only", ht[0]?.annotations?.readOnlyHint === true);
check("http: echo over SSE response works", ho.includes("hello HTTP"));
check("http: session id echoed on later requests", httpSawSession);

// --- legacy HTTP+SSE mock: GET opens the event channel (endpoint event first); POST is the inbound endpoint ---
const enc = new TextEncoder();
let sseCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
const push = (obj: unknown) => sseCtrl?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`));
const sseServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET") {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) { sseCtrl = ctrl; ctrl.enqueue(enc.encode(`event: endpoint\ndata: ${u.origin}/post\n\n`)); },
        cancel() { sseCtrl = null; },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "POST") {
      const msg: any = await req.json();
      if (msg.id == null) return new Response(null, { status: 202 }); // notification
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") push(reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-sse", version: "1" } }));
      else if (msg.method === "tools/list") push(reply({ tools: [ECHO] }));
      else if (msg.method === "tools/call") push(reply({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] }));
      else push({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
      return new Response(null, { status: 202 });
    }
    return new Response("no", { status: 404 });
  },
});
const sc = new SseMcpClient("mock-sse", { type: "sse", url: `http://127.0.0.1:${sseServer.port}/sse` });
await sc.connect();
const st = await sc.listTools();
const so = await sc.callTool("echo", { text: "hello SSE" });
sc.close();
sseServer.stop(true);
check("sse: lists the echo tool", st.length === 1 && st[0].name === "echo");
check("sse: echo over the SSE channel works", so.includes("hello SSE"));

if (fail) { console.error("\n✗ MCP http/sse smoke FAILED"); process.exit(1); }
console.log("\n✓ MCP http/sse smoke passed (factory + Streamable HTTP [JSON+SSE, session id] + legacy HTTP+SSE)");
process.exit(0);
