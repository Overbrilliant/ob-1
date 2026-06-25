// Minimal MCP server over stdio for testing OB-1's client. Implements initialize,
// tools/list (one "echo" tool), and tools/call. Usage: bun run scripts/mock-mcp-server.ts
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

rl.on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } });
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Echo back the provided text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
      ] } });
      break;
    case "tools/call":
      if (msg.params?.name === "echo") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
      }
      break;
    default:
      if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
