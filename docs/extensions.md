# Extensions

MCP is OB-1's extension story today. Configure stdio, Streamable HTTP, or SSE MCP servers and OB-1 will
load their tools on demand.

Native plugin API is intentionally later. A credible native API needs stable lifecycle hooks, permissions,
config validation, test fixtures, and a compatibility policy. Until then:

- Use MCP for external tools and services.
- Use markdown skills for reusable procedural knowledge.
- Use hooks in `.ob1/hooks.json` for local workflow automation.

When a native API lands, it should wrap these existing primitives rather than bypassing the permission,
secret-redaction, sandbox, and verification layers.
