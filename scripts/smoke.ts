// Smoke test for the memory engine — runs offline (local embedder, no API key).
// Usage: bun run scripts/smoke.ts
import { MemoryStore } from "../src/memory/store.ts";
import { LocalEmbedder } from "../src/memory/embed.ts";
import { systemPrompt } from "../src/agent/loop.ts";
import { repoMapSummary, invalidateRepoMap } from "../src/context/repomap.ts";
import { loadConfig } from "../src/config.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dbPath = join(tmpdir(), `ob1-smoke-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
const m = new MemoryStore(dbPath, new LocalEmbedder());

// Facts + revisions (audit trail) — remember() also indexes for semantic search
const id = await m.remember("OB-1 uses TypeScript + Bun and a single SQLite file for memory.");
m.updateFact(id, "OB-1 uses TypeScript + Bun; memory is a single SQLite file (facts + graph).");
await m.remember("Default model is claude-sonnet-4-6; escalate to Opus deliberately.");
await m.remember("Authentication is handled by AuthService which issues JWT tokens.");
await m.remember("The tree-sitter repo map ranks symbols by a PageRank-style algorithm.");
const did = await m.remember("Temporary note to be archived.");
m.deleteFact(did);

// Relationship graph (bi-temporal edges)
m.addRelationship("LoginController", "calls", "AuthService");
m.addRelationship("AuthService", "issues", "JWT");
m.addRelationship("User", "authenticated_by", "AuthService");
const oldEdge = m.addRelationship("AuthService", "uses", "SHA1");
m.invalidateRelationship(oldEdge); // superseded — invalidated, not deleted
m.addRelationship("AuthService", "uses", "bcrypt");

console.log("\n=== FACTS (active) ===");
for (const f of m.listFacts()) console.log(`  #${f.id} ${f.fact}`);

console.log("\n=== REVISION TRAIL for fact #" + id + " ===");
for (const r of m.revisions(id)) console.log(`  ${r.at}  ${r.op.toUpperCase().padEnd(7)}  ${r.fact}`);

console.log("\n=== RELATIONSHIPS (active) ===");
for (const e of m.listRelationships()) console.log(`  ${e.src} --${e.rel}--> ${e.dst}`);

console.log("\n=== BOUNDED NEIGHBOURHOOD of AuthService (1 hop) ===");
for (const e of m.neighborhood("AuthService", 1)) console.log(`  ${e.src} --${e.rel}--> ${e.dst}`);

console.log("\n=== SEMANTIC SEARCH 'login security token' (vector top-k) ===");
for (const f of await m.searchSemantic("login security token", 3)) console.log(`  #${f.id} ${f.fact}`);

console.log("\n=== SEMANTIC SEARCH 'which programming language' ===");
for (const f of await m.searchSemantic("which programming language", 2)) console.log(`  #${f.id} ${f.fact}`);

console.log("\n=== STATS ===");
console.log("  ", m.stats());

// System prompt must orient the model: today's date + an HONEST model identity, at the end.
const cfg = loadConfig();
const today = new Date().toISOString().slice(0, 10);
let spFail = false;
const spCheck = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) spFail = true; };
// systemPrompt now returns SystemBlock[] (stable cached block + volatile uncached tail) for prompt
// caching; flatten to a single string for these content assertions.
const sp = (...args: Parameters<typeof systemPrompt>): string => systemPrompt(...args).map((b) => b.text).join("\n\n");

// (a) concrete model → its label + raw id + provider.
const spConcrete = sp({ ...cfg, model: "x-ai/grok-4.3", provider: "openai", resolvedModel: undefined }, m);
console.log("\n=== SYSTEM PROMPT tail (concrete) ===\n  …" + spConcrete.slice(-90));
spCheck("concrete model → date + label + raw id", spConcrete.includes("Today's date") && spConcrete.includes(today) && spConcrete.includes("Grok 4.3") && spConcrete.includes("x-ai/grok-4.3"));

// (b) router alias, no resolution yet → honest "provider-routed, varies"; no fabricated identity.
const spRouter = sp({ ...cfg, model: "auto", provider: "openai", resolvedModel: undefined }, m);
console.log("\n=== SYSTEM PROMPT tail (router) ===\n  …" + spRouter.slice(-90));
spCheck("router alias → describes provider-routing (not a bare 'auto')", /router|routed|varies/i.test(spRouter) && spRouter.includes("Today's date"));

// (c) router alias WITH a resolved backend → names the model the last request routed to (the bug fix:
// so 'which model are you?' is answered with DeepSeek, not 'auto/openai').
const spResolved = sp({ ...cfg, model: "auto", provider: "openai", resolvedModel: "deepseek/deepseek-v4-pro" }, m);
console.log("\n=== SYSTEM PROMPT tail (router+resolved) ===\n  …" + spResolved.slice(-110));
spCheck("router + resolved → names the routed model (label + id)", spResolved.includes("DeepSeek V4 Pro") && spResolved.includes("deepseek/deepseek-v4-pro"));

// (d) auto repo map: the codebase structure is injected so the model always knows what it's working
// with (this runs in the OB-1 repo, so the map is non-empty). Disable-able via OB1_REPO_MAP=off.
spCheck("repoMap ON (default) → system prompt auto-injects the map", spConcrete.includes("Repository map") && /\.ts\b/.test(spConcrete));
spCheck("repoMap OFF → system prompt omits the map (the /settings toggle)", !sp({ ...cfg, repoMap: false }, m).includes("Repository map"));
const rm1 = repoMapSummary(cfg.cwd);
spCheck("repoMapSummary returns a non-empty, budgeted map", rm1.length > 0 && rm1.length < 6000);
invalidateRepoMap(); // simulates a file change → next call rebuilds (still returns the structure)
spCheck("repo map rebuilds after invalidation (stays available)", repoMapSummary(cfg.cwd).includes("Repository map"));

if (spFail) { console.error("\n✗ system-prompt model-identity checks failed"); process.exit(1); }

m.close();
for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
console.log("\n✓ memory + semantic-search smoke test passed\n");
