# MCP

MCP is OB-1's extension interface today. OB-1 supports stdio, Streamable HTTP, and SSE servers, then
loads MCP tools into the agent loop alongside local file, shell, browser, and memory tools.

## Configuration Shape

Configure servers in the same spirit as:

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "url": "https://example.com/mcp"
    }
  }
}
```

Use stdio for local tools and HTTP/SSE for hosted tools. Keep credentials in environment variables or
the server's own secret store; do not commit them into project config.

## Where the config lives

OB-1 reads the first of these that exists, in precedence order:

1. `.ob1/.mcp.json`
2. `.mcp.json`
3. `.ob1/mcp.json`
4. `mcp.json`

The shape is identical to Claude Code's `.mcp.json` — a top-level `mcpServers` map — so a project
that already has `.mcp.json` works in OB-1 with no second file to maintain. The dot-forms take
precedence; the undotted paths remain supported, so existing `mcp.json` setups keep working.

Only the first matching file is read (they are not merged). A file that parses but has no top-level
`mcpServers` key loads no servers and says so at startup, rather than failing silently.

## Safety

MCP tools still pass through OB-1's tool approval, sandbox, and secret-redaction layers. Treat new MCP
servers like dependencies: pin versions when possible, read the permissions they need, and add a focused
smoke if a workflow depends on them.
