// LIVE interop test (NOT a deterministic smoke — needs npx + network). Drives OB-1's three MCP
// transports against the OFFICIAL reference server @modelcontextprotocol/server-everything, proving
// the clients interoperate with a real third-party server, not just our local mocks.
// Usage: bun run scripts/mcp-interop.ts
import { StdioMcpClient, type McpClient } from "../src/mcp/client.ts";
import { StreamableHttpMcpClient, SseMcpClient } from "../src/mcp/http.ts";

const SERVER = ["-y", "@modelcontextprotocol/server-everything"];
let fail = false;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

/** Grab a currently-free TCP port by binding to :0 and releasing it. The reference server honors PORT
 *  (process.env.PORT || 3001), so we run it on a port WE picked instead of the hardcoded 3001 — which may
 *  already be taken by an unrelated service, making the test connect to (and "pass"/fail against) the wrong
 *  server. Combined with the echo round-trip in exercise(), this pins the test to OUR server. */
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const p = s.port ?? 0; s.stop(true);
  if (!p) throw new Error("could not reserve a free port");
  return p;
}

/** Poll an http endpoint until it accepts a connection (any HTTP status = listening). Safe here because the
 *  port is one we reserved for THIS server, so anything answering on it is the server we just launched. */
async function waitListening(url: string, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(url, { method: "GET", signal: AbortSignal.timeout(1500) }); return true; }
    catch (e) { if (!/refused|ECONNREFUSED|Unable to connect|fetch failed/i.test(String(e))) return true; }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Run the standard interop assertions against a connected client. */
async function exercise(label: string, client: McpClient): Promise<void> {
  const tools = await client.listTools();
  const names = tools.map((t) => t.name);
  check(`${label}: connect + tools/list`, tools.length > 0, `${tools.length} tools: ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}`);
  check(`${label}: real server exposes 'echo'`, names.includes("echo"));
  const echoed = await client.callTool("echo", { message: `OB-1 ${label} interop` });
  check(`${label}: tools/call echo round-trips`, echoed.includes(`OB-1 ${label} interop`), echoed.slice(0, 60));
  if (names.includes("add")) {
    const sum = await client.callTool("add", { a: 2, b: 3 });
    check(`${label}: tools/call add → 5`, /(\b5\b)/.test(sum), sum.slice(0, 60));
  }
}

// ── 1. stdio (subprocess) ─────────────────────────────────────────────────────
console.log("\n── stdio transport ──");
try {
  const c = new StdioMcpClient("everything-stdio", { command: "npx", args: [...SERVER, "stdio"] });
  await c.connect(30_000);
  await exercise("stdio", c);
  c.close();
} catch (e) { check("stdio: no error", false, (e as Error).message); }

// ── 2. Streamable HTTP ────────────────────────────────────────────────────────
console.log("\n── Streamable HTTP transport ──");
{
  const port = freePort();
  const proc = Bun.spawn({ cmd: ["npx", ...SERVER, "streamableHttp"], env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
  try {
    const up = await waitListening(`http://127.0.0.1:${port}/mcp`);
    check(`http: reference server listening on :${port}/mcp`, up);
    if (up) {
      const c = new StreamableHttpMcpClient("everything-http", { type: "http", url: `http://127.0.0.1:${port}/mcp` });
      await c.connect(30_000);
      await exercise("http", c);
      c.close();
    }
  } catch (e) { check("http: no error", false, (e as Error).message); }
  finally { proc.kill(); Bun.spawnSync(["pkill", "-f", "server-everything"], { stdout: "ignore", stderr: "ignore" }); }
}
await new Promise((r) => setTimeout(r, 1500)); // let the killed streamableHttp server fully exit before the next

// ── 3. legacy HTTP+SSE ────────────────────────────────────────────────────────
console.log("\n── legacy HTTP+SSE transport ──");
{
  const port = freePort();
  const proc = Bun.spawn({ cmd: ["npx", ...SERVER, "sse"], env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
  try {
    const up = await waitListening(`http://127.0.0.1:${port}/sse`);
    check(`sse: reference server listening on :${port}/sse`, up);
    if (up) {
      const c = new SseMcpClient("everything-sse", { type: "sse", url: `http://127.0.0.1:${port}/sse` });
      await c.connect(30_000);
      await exercise("sse", c);
      c.close();
    }
  } catch (e) { check("sse: no error", false, (e as Error).message); }
  finally { proc.kill(); Bun.spawnSync(["pkill", "-f", "server-everything"], { stdout: "ignore", stderr: "ignore" }); }
}

if (fail) { console.error("\n✗ MCP interop FAILED"); process.exit(1); }
console.log("\n✓ MCP interop passed — stdio + Streamable HTTP + legacy SSE all interoperate with the official reference server");
process.exit(0);
