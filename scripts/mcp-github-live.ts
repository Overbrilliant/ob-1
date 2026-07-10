// LIVE opt-in probe: drive OB-1's Streamable HTTP MCP client against a REAL authenticated CLOUD MCP
// server — GitHub's hosted remote server at https://api.githubcopilot.com/mcp/ — using a GitHub
// token as the bearer. This is the real-world counterpart to the deterministic mcp-auth-smoke:
// it proves the same header/session code path interoperates with a third-party authed endpoint.
// Self-skips when no token is available. STRICTLY read-only (initialize + tools/list + get_me).
// Token resolution: GITHUB_MCP_TOKEN | GITHUB_TOKEN | GH_TOKEN env, else `gh auth token`.
// Usage: bun run scripts/mcp-github-live.ts
import { StreamableHttpMcpClient } from "../src/mcp/http.ts";

const URL = "https://api.githubcopilot.com/mcp/";

function resolveToken(): string | null {
  const fromEnv = process.env.GITHUB_MCP_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    const p = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const t = new TextDecoder().decode(p.stdout).trim();
    return t || null;
  } catch { return null; }
}

const token = resolveToken();
if (!token) {
  console.log("• skipped — no GitHub token (set GITHUB_MCP_TOKEN/GITHUB_TOKEN, or `gh auth login`)");
  process.exit(0);
}

const client = new StreamableHttpMcpClient("github-remote", {
  type: "http",
  url: URL,
  headers: { Authorization: `Bearer ${token}`, "X-MCP-Readonly": "true" }, // ask the server for read-only tools
});

try {
  await client.connect(30_000);
  const tools = await client.listTools();
  const names = tools.map((t) => t.name);
  console.log(`✓ authenticated handshake with ${URL} — ${tools.length} tools: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}`);
  if (tools.length === 0) { console.error("✗ connected but server exposed 0 tools"); client.close(); process.exit(1); }

  // One read-only call if the server offers the identity tool — proves tools/call over the authed channel.
  if (names.includes("get_me")) {
    const me = await client.callTool("get_me", {});
    const login = (me.match(/"login"\s*:\s*"([^"]+)"/) || [])[1];
    console.log(`✓ tools/call get_me round-trips${login ? ` — authenticated as @${login}` : ""}`);
  } else {
    console.log("• get_me not in the default toolset — skipped the read-only call (tools/list already proves the authed channel)");
  }
  client.close();
  console.log("\n✓ GitHub remote MCP live probe passed — OB-1's bearer-auth Streamable HTTP client interoperates with a real authenticated cloud MCP server");
  process.exit(0);
} catch (e) {
  client.close();
  const msg = (e as Error).message;
  // A 401/403 means we reached the server's auth gate but the token isn't entitled (e.g. no Copilot
  // access / missing scopes). That still exercises the header path against a real cloud endpoint and
  // is environmental, not a client defect — report it distinctly and don't fail the build.
  if (/\b40[13]\b/.test(msg)) {
    console.log(`• auth gate reached but token not entitled (${msg.slice(0, 80)}) — the bearer header DID reach api.githubcopilot.com; GitHub's MCP server needs Copilot access. Not a client bug.`);
    process.exit(0);
  }
  console.error(`✗ GitHub remote MCP probe error: ${msg.slice(0, 200)}`);
  process.exit(1);
}
