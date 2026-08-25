// Deterministic test for MCP config RESOLUTION + PARSING (temp cwd, no network, no server connect).
// Covers: the four accepted paths, their precedence order, and every "parsed but unusable" shape —
// which used to load zero servers with no diagnostic at all.
// Usage: bun run scripts/mcp-config-smoke.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_CONFIG_PATHS, readMcpConfig } from "../src/mcp/manager.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const roots: string[] = [];
/** Fresh temp cwd seeded with { relativePath: fileContents }. */
function cwdWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ob1-mcp-cfg-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}
const SERVER = JSON.stringify({ mcpServers: { docs: { command: "true" } } });

// ── the four accepted paths each resolve on their own ─────────────────────────
check("MCP_CONFIG_PATHS is the four paths, dot-forms first",
  MCP_CONFIG_PATHS.join("|") === [join(".ob1", ".mcp.json"), ".mcp.json", join(".ob1", "mcp.json"), "mcp.json"].join("|"));

for (const rel of MCP_CONFIG_PATHS) {
  const r = readMcpConfig(cwdWith({ [rel]: SERVER }));
  check(`${rel} alone → resolves + 1 server, no summary`,
    r.cfgPath?.endsWith(rel) === true && Object.keys(r.servers).length === 1 && "docs" in r.servers && r.summary.length === 0);
}

// ── precedence: the earlier path wins whenever two files are present ──────────
const named = (i: number) => JSON.stringify({ mcpServers: { [`s${i}`]: { command: "true" } } });
for (let i = 0; i < MCP_CONFIG_PATHS.length; i++) {
  for (let j = i + 1; j < MCP_CONFIG_PATHS.length; j++) {
    const hi = MCP_CONFIG_PATHS[i], lo = MCP_CONFIG_PATHS[j];
    const r = readMcpConfig(cwdWith({ [hi]: named(i), [lo]: named(j) }));
    check(`${hi} beats ${lo}`, r.cfgPath?.endsWith(hi) === true && `s${i}` in r.servers && !(`s${j}` in r.servers));
  }
}
// the headline case: a Claude Code .mcp.json wins over a legacy mcp.json
const both = readMcpConfig(cwdWith({ ".mcp.json": named(1), "mcp.json": named(3) }));
check(".mcp.json (Claude Code) takes precedence over mcp.json", both.cfgPath?.endsWith(".mcp.json") === true && "s1" in both.servers);
// files are NOT merged — only the winner is read
check("configs are not merged (only the winning file is read)", Object.keys(both.servers).length === 1);

// ── wrong shape: the old silent-zero cases now explain themselves ─────────────
const nested = readMcpConfig(cwdWith({ "mcp.json": JSON.stringify({ mcp: { servers: { docs: { command: "true" } } } }) }));
check('{"mcp":{"servers":…}} → zero servers', Object.keys(nested.servers).length === 0);
check('{"mcp":{"servers":…}} → summary names mcpServers',
  nested.summary.length === 1 && nested.summary[0].includes("mcpServers") && nested.summary[0].includes('has a "mcp" key'));

const neither = readMcpConfig(cwdWith({ "mcp.json": JSON.stringify({ servers: { docs: { command: "true" } } }) }));
check("no mcp/mcpServers key → zero servers + warning",
  Object.keys(neither.servers).length === 0 && neither.summary.length === 1 && neither.summary[0].includes('has no "mcpServers" key'));

// ── deliberately empty config stays SILENT (not a misconfiguration) ───────────
const empty = readMcpConfig(cwdWith({ "mcp.json": '{"mcpServers": {}}' }));
check('{"mcpServers":{}} → zero servers, NO warning', Object.keys(empty.servers).length === 0 && empty.summary.length === 0);

// ── malformed JSON keeps the existing `bad config` line and never throws ──────
let threw = false;
let malformed: ReturnType<typeof readMcpConfig> | null = null;
try { malformed = readMcpConfig(cwdWith({ ".mcp.json": "{ this is not json" })); } catch { threw = true; }
check("malformed JSON does not throw", !threw);
check("malformed JSON → `bad config` summary, zero servers",
  malformed !== null && malformed.summary.length === 1 && malformed.summary[0].startsWith("mcp: bad config ") && Object.keys(malformed.servers).length === 0);

// ── non-object roots are handled like any other unusable shape ────────────────
for (const [label, body] of [["array", "[1,2]"], ["string", '"nope"'], ["null", "null"]] as const) {
  const r = readMcpConfig(cwdWith({ "mcp.json": body }));
  check(`${label} root → zero servers + warning, no throw`, Object.keys(r.servers).length === 0 && r.summary.length === 1);
}
// a non-object mcpServers value is not a server map
const wrongType = readMcpConfig(cwdWith({ "mcp.json": '{"mcpServers": "docs"}' }));
check('"mcpServers" of the wrong type → zero servers + warning', Object.keys(wrongType.servers).length === 0 && wrongType.summary.length === 1);

// ── no config file at all: silent, empty ─────────────────────────────────────
const none = readMcpConfig(cwdWith({ "README.md": "# not a config" }));
check("no config file → null path, zero servers, NO summary",
  none.cfgPath === null && Object.keys(none.servers).length === 0 && none.summary.length === 0);
// a nearby-but-wrong filename must not be picked up
const decoy = readMcpConfig(cwdWith({ "mcp.jsonc": SERVER, ".ob1/servers.json": SERVER }));
check("look-alike filenames are ignored", decoy.cfgPath === null && decoy.summary.length === 0);

for (const r of roots) rmSync(r, { recursive: true, force: true });

if (fail) { console.error("\n✗ mcp-config smoke FAILED"); process.exit(1); }
console.log("\n✓ mcp-config smoke passed");
