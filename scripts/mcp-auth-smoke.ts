// E2E test: authenticated remote MCP servers. The mcp-http-smoke covers the transports with no
// auth; this proves the LAST untested rung of the http/sse feature — that a user-supplied
// Authorization (bearer) header + arbitrary custom headers actually reach an auth-GATED server on
// EVERY request (initialize, tools/list, tools/call), that a missing token is correctly rejected
// (401 → connect throws), and that the Mcp-Session-Id issued at initialize is replayed on later
// requests. Uses a local Bun.serve server that enforces real auth — deterministic, no network, no
// secrets, so it runs in CI. (For a real authenticated CLOUD server, see scripts/mcp-github-live.ts.)
// Usage: bun run scripts/mcp-auth-smoke.ts
import { StreamableHttpMcpClient, SseMcpClient } from "../src/mcp/http.ts";

const TOKEN = "s3cr3t-mcp-token";
const SESSION = "sess-authed-xyz";
const ECHO = { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } };

let fail = false;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

// What the server observed per JSON-RPC method — lets us assert headers landed on EVERY request,
// not just the initial handshake (the merge happens in sendMessage, called for every message).
type Seen = { auth: boolean; custom: boolean; session: string | null };
const httpSeen: Record<string, Seen> = {};

// ── Streamable HTTP server that REQUIRES `Authorization: Bearer <TOKEN>` ─────────────────────────
const httpServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const auth = req.headers.get("authorization");
    const authed = auth === `Bearer ${TOKEN}`;
    if (req.method === "DELETE") return new Response(null, { status: authed ? 204 : 401 }); // session teardown
    // AUTH GATE — the behaviour under test. A wrong/absent token is rejected before anything else.
    if (!authed) return new Response("unauthorized", { status: 401 });

    const session = req.headers.get("mcp-session-id");
    let msg: any = {};
    try { msg = await req.json(); } catch { /* empty body */ }
    if (msg?.method) httpSeen[msg.method] = { auth: authed, custom: req.headers.get("x-ob1-test") === "yes", session };
    if (msg.id == null) return new Response(null, { status: 202 }); // notifications/initialized

    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize")
      return Response.json(reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "authed-http", version: "1" } }), { headers: { "mcp-session-id": SESSION } });
    // Post-initialize requests must replay the session id the server issued.
    if (session !== SESSION) return new Response("missing/invalid session", { status: 400 });
    if (msg.method === "tools/list") return Response.json(reply({ tools: [ECHO] }));
    if (msg.method === "tools/call") return Response.json(reply({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] }));
    return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  },
});
const httpUrl = `http://127.0.0.1:${httpServer.port}/mcp`;

// 1) NO token → the auth gate must reject, and the client must surface it (not hang/timeout).
{
  let threw = "";
  const noAuth = new StreamableHttpMcpClient("http-noauth", { type: "http", url: httpUrl });
  try { await noAuth.connect(8_000); } catch (e) { threw = (e as Error).message; }
  noAuth.close();
  check("http: connect WITHOUT token is rejected (401)", /\b401\b/.test(threw), threw.slice(0, 60) || "did not throw");
}

// 2) WITH bearer + custom header → full handshake/list/call succeeds, and the server saw the headers.
{
  const authed = new StreamableHttpMcpClient("http-authed", { type: "http", url: httpUrl, headers: { Authorization: `Bearer ${TOKEN}`, "X-OB1-Test": "yes" } });
  await authed.connect(8_000);
  const tools = await authed.listTools();
  const echoed = await authed.callTool("echo", { text: "authed hello" });
  authed.close();
  check("http: connect WITH bearer token succeeds", tools.length === 1 && tools[0].name === "echo");
  check("http: tools/call echo round-trips over authed channel", echoed.includes("authed hello"));
  const methods = ["initialize", "tools/list", "tools/call"];
  check("http: Authorization sent on EVERY request (not just connect)", methods.every((m) => httpSeen[m]?.auth), methods.filter((m) => !httpSeen[m]?.auth).join(",") || "all");
  check("http: custom header (X-OB1-Test) sent on every request", methods.every((m) => httpSeen[m]?.custom));
  check("http: Mcp-Session-Id captured + replayed on later requests", httpSeen["tools/list"]?.session === SESSION && httpSeen["tools/call"]?.session === SESSION, `list=${httpSeen["tools/list"]?.session} call=${httpSeen["tools/call"]?.session}`);
}
httpServer.stop(true);

// ── Legacy HTTP+SSE server that REQUIRES the bearer on the GET event channel AND the POST endpoint ─
const enc = new TextEncoder();
let sseCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
const push = (obj: unknown) => sseCtrl?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`));
const sseSeen = { get: false, post: false };
const sseServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const authed = req.headers.get("authorization") === `Bearer ${TOKEN}`;
    const u = new URL(req.url);
    if (req.method === "GET") {
      if (!authed) return new Response("unauthorized", { status: 401 }); // gate the SSE channel itself
      sseSeen.get = true;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) { sseCtrl = ctrl; ctrl.enqueue(enc.encode(`event: endpoint\ndata: ${u.origin}/post\n\n`)); },
        cancel() { sseCtrl = null; },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "POST") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      sseSeen.post = true;
      const msg: any = await req.json();
      if (msg.id == null) return new Response(null, { status: 202 });
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") push(reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "authed-sse", version: "1" } }));
      else if (msg.method === "tools/list") push(reply({ tools: [ECHO] }));
      else if (msg.method === "tools/call") push(reply({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] }));
      else push({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
      return new Response(null, { status: 202 });
    }
    return new Response("no", { status: 404 });
  },
});
const sseUrl = `http://127.0.0.1:${sseServer.port}/sse`;

// 3) legacy SSE: no token → the GET channel is rejected (401 surfaces, no silent hang).
{
  let threw = "";
  const noAuth = new SseMcpClient("sse-noauth", { type: "sse", url: sseUrl });
  try { await noAuth.connect(8_000); } catch (e) { threw = (e as Error).message; }
  noAuth.close();
  check("sse: connect WITHOUT token is rejected (401)", /\b401\b/.test(threw), threw.slice(0, 60) || "did not throw");
}

// 4) legacy SSE: with bearer → connects, lists, calls; header reached both the GET channel and POSTs.
{
  const authed = new SseMcpClient("sse-authed", { type: "sse", url: sseUrl, headers: { Authorization: `Bearer ${TOKEN}` } });
  await authed.connect(8_000);
  const tools = await authed.listTools();
  const echoed = await authed.callTool("echo", { text: "authed SSE" });
  authed.close();
  check("sse: connect WITH bearer token succeeds", tools.length === 1 && tools[0].name === "echo");
  check("sse: tools/call echo round-trips over authed channel", echoed.includes("authed SSE"));
  check("sse: Authorization reached BOTH the GET event channel and the POST endpoint", sseSeen.get && sseSeen.post);
}
sseServer.stop(true);

if (fail) { console.error("\n✗ MCP auth smoke FAILED"); process.exit(1); }
console.log("\n✓ MCP auth smoke passed — bearer + custom headers sent on every request, missing-token 401 rejected, session id replayed (Streamable HTTP + legacy SSE)");
process.exit(0);
