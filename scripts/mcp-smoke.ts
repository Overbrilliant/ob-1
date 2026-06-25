// Smoke test: connect to the mock MCP server, list + call a tool, and verify deferred-tool loading.
// Usage: bun run scripts/mcp-smoke.ts
import { StdioMcpClient } from "../src/mcp/client.ts";
import { makeMcpLoaderTool } from "../src/mcp/manager.ts";
import type { Tool } from "../src/agent/tools.ts";

const client = new StdioMcpClient("mock", { command: "bun", args: ["run", "scripts/mock-mcp-server.ts"] });
await client.connect();

const tools = await client.listTools();
console.log("tools:", tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""}`).join(", "));

const out = await client.callTool("echo", { text: "hello MCP" });
console.log("call echo:", out);

client.close();

let ok = tools.length === 1 && tools[0].name === "echo" && out.includes("hello MCP");

// --- deferred MCP tool loading: tools are inactive until load_mcp_tool activates them ---
const live = new Map<string, Tool>();
const fake: Tool = { def: { name: "mcp__demo__ping", description: "ping a host", input_schema: { type: "object", properties: {} } }, mutating: false, run: () => "pong" };
const deferred = new Map<string, Tool>([[fake.def.name, fake]]);
const loader = makeMcpLoaderTool(live, deferred);
const catalogued = loader.def.description.includes("mcp__demo__ping"); // names visible up front
const notYetActive = !live.has("mcp__demo__ping");
const res = await loader.run({ name: "demo" });
const activated = live.has("mcp__demo__ping") && String(res).includes("Activated");
console.log("loader:", { catalogued, notYetActive, activated });
ok = ok && catalogued && notYetActive && activated;

if (!ok) { console.error("\n✗ MCP smoke FAILED"); process.exit(1); }
console.log("\n✓ MCP smoke passed (stdio client + deferred tool loading)");
process.exit(0);
