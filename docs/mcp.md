# MCP

MCP is OB-1's extension interface today. OB-1 supports stdio, Streamable HTTP, and SSE servers, then
loads MCP tools into the agent loop alongside local file, shell, browser, and memory tools.

## Configuration Shape

Configure servers in the same spirit as:

```json
{
  "mcp": {
    "servers": {
      "docs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      },
      "remote": {
        "url": "https://example.com/mcp"
      }
    }
  }
}
```

Use stdio for local tools and HTTP/SSE for hosted tools. Keep credentials in environment variables or
the server's own secret store; do not commit them into project config.

## Safety

MCP tools still pass through OB-1's tool approval, sandbox, and secret-redaction layers. Treat new MCP
servers like dependencies: pin versions when possible, read the permissions they need, and add a focused
smoke if a workflow depends on them.
