// MCP server manager — reads server configs, connects, and exposes their tools to OB-1's
// tool registry (namespaced mcp__<server>__<tool>, mirroring Claude Code). Read-only tools
// (per the readOnlyHint annotation) auto-run; the rest pass the approval gate.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StdioMcpClient, type McpClient, type McpServerConfig } from "./client.ts";
import { StreamableHttpMcpClient, SseMcpClient } from "./http.ts";
import type { Tool } from "../agent/tools.ts";

export interface McpLoadResult {
  clients: McpClient[];
  tools: Tool[];
  summary: string[];
}

/** Pick the transport by config: explicit `type`, else "stdio" when a command is set, else "http". */
export function createMcpClient(name: string, sc: McpServerConfig): McpClient {
  const type = sc.type ?? (sc.command ? "stdio" : "http");
  if (type === "http") return new StreamableHttpMcpClient(name, sc);
  if (type === "sse") return new SseMcpClient(name, sc);
  return new StdioMcpClient(name, sc);
}

/** Accepted config paths, in PRECEDENCE order (first one that exists wins). The dot-forms come
 *  first so a Claude Code project config (`.mcp.json`) is what OB-1 picks up: the file shape is
 *  identical, so one file serves both tools. The undotted forms stay supported for back-compat. */
export const MCP_CONFIG_PATHS = [
  join(".ob1", ".mcp.json"),
  ".mcp.json",
  join(".ob1", "mcp.json"),
  "mcp.json",
] as const;

export interface McpConfigResult {
  /** The file we read, or null when none of MCP_CONFIG_PATHS exists. */
  cfgPath: string | null;
  servers: Record<string, McpServerConfig>;
  summary: string[];
}

/** Resolve + parse the MCP config. Pure: touches the filesystem but connects to nothing and NEVER
 *  throws — a malformed or wrong-shaped file yields zero servers plus a `summary` line saying why.
 *  Each server is one of:
 *    stdio: { "command": "...", "args": [...], "env": {...} }   (default when command present)
 *    http:  { "type": "http", "url": "https://...", "headers": {...} }
 *    sse:   { "type": "sse",  "url": "https://...", "headers": {...} } */
export function readMcpConfig(cwd: string): McpConfigResult {
  const cfgPath = MCP_CONFIG_PATHS.map((p) => join(cwd, p)).find((p) => existsSync(p));
  if (!cfgPath) return { cfgPath: null, servers: {}, summary: [] };

  let conf: unknown;
  try { conf = JSON.parse(readFileSync(cfgPath, "utf8")); }
  catch (e) { return { cfgPath, servers: {}, summary: [`mcp: bad config ${cfgPath}: ${(e as Error).message}`] }; }

  const obj = (conf && typeof conf === "object" ? conf : {}) as Record<string, unknown>;
  const servers = obj.mcpServers;
  // `{"mcpServers": {}}` is a deliberate empty config — stay silent. Anything else that parsed but
  // has no usable map used to load zero servers with no diagnostic at all; now it says why.
  if (servers && typeof servers === "object") {
    return { cfgPath, servers: servers as Record<string, McpServerConfig>, summary: [] };
  }
  return {
    cfgPath,
    servers: {},
    summary: ["mcp" in obj
      ? `mcp: ${cfgPath} has a "mcp" key but no "mcpServers" — OB-1 (like Claude Code) reads a top-level "mcpServers" map. No servers loaded.`
      : `mcp: ${cfgPath} has no "mcpServers" key — no servers loaded.`],
  };
}

/** Read the config (see readMcpConfig) and connect to every server it declares. */
export async function loadMcpServers(cwd: string): Promise<McpLoadResult> {
  const { servers, summary } = readMcpConfig(cwd);
  const clients: McpClient[] = [];
  const tools: Tool[] = [];

  for (const [name, sc] of Object.entries(servers)) {
    const client = createMcpClient(name, sc);
    try {
      await client.connect();
      // Track for cleanup the moment it's connected — BEFORE listTools(), which can throw and would
      // otherwise leave a live subprocess / SSE socket / HTTP session that's never closed.
      clients.push(client);
      const mcpTools = await client.listTools();
      for (const t of mcpTools) {
        tools.push({
          def: {
            name: `mcp__${name}__${t.name}`,
            description: t.description ?? `${name}: ${t.name}`,
            input_schema: t.inputSchema ?? { type: "object", properties: {} },
          },
          mutating: !t.annotations?.readOnlyHint, // gate unless explicitly read-only
          run: (input) => client.callTool(t.name, input),
        });
      }
      summary.push(`mcp: connected ${name} (${mcpTools.length} tools)`);
    } catch (e) {
      // connect() failed partway (never tracked) → tear it down here; a post-connect failure is already
      // in clients[] and gets closed by the caller's cleanup.
      if (!clients.includes(client)) { try { client.close(); } catch { /* nothing to close */ } }
      summary.push(`mcp: failed ${name}: ${(e as Error).message}`);
    }
  }
  return { clients, tools, summary };
}

/** Deferred MCP tool defs (R1/this-harness pattern): MCP tools are NOT sent to the model until
 *  loaded, keeping the base tool list lean. This single gating tool lists the deferred catalog and,
 *  when called, ACTIVATES matching tools into the live registry so later steps can call them. */
export function makeMcpLoaderTool(live: Map<string, Tool>, deferred: Map<string, Tool>): Tool {
  const names = () => [...deferred.keys()].join(", ") || "(none)";
  return {
    def: {
      name: "load_mcp_tool",
      description:
        "MCP tools are deferred (not active until loaded) to keep context lean. Pass a `name` (or substring) " +
        "to ACTIVATE matching MCP tools — then call them on a later step. Omit `name` to list all. Available: " + names(),
      input_schema: { type: "object", properties: { name: { type: "string" } } },
    },
    mutating: false,
    run: ({ name }) => {
      const q = name ? String(name).toLowerCase() : "";
      const matches = [...deferred.values()].filter((t) => !q || t.def.name.toLowerCase().includes(q));
      if (!matches.length) return `no matching MCP tools. Available: ${names()}`;
      for (const t of matches) live.set(t.def.name, t); // activate for subsequent steps
      return `Activated ${matches.length} MCP tool(s) — now callable:\n` +
        matches.map((t) => `- ${t.def.name}: ${t.def.description}\n  input_schema: ${JSON.stringify(t.def.input_schema)}`).join("\n");
    },
  };
}
