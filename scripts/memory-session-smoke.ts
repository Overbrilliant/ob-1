// Cross-SESSION + robustness test for the memory engine (no API key — deterministic LocalEmbedder).
//
// "Across sessions" means a SEPARATE PROCESS reopening the same .ob1/memory.db — not just a same-process
// reopen. This script self-spawns child `bun` processes that write, then a fresh child reads everything
// back, and the parent asserts ALL state survived: active + archived facts, the revision trail, the
// relationship graph (active + invalidated edges), entities, and semantic search (vectors reloaded).
// Then a second writer appends and a final reader proves cumulative persistence over 3 sessions.
// Finally, in-process robustness probes: unicode/injection/huge content, concurrent connections, schema
// idempotency, large volume, and corrupt-DB recovery (quarantine + fresh start, never bricks startup).
//
// Usage: bun run scripts/memory-session-smoke.ts   (also self-invoked as `… write|append|read <db>`)
import { MemoryStore } from "../src/memory/store.ts";
import { LocalEmbedder } from "../src/memory/embed.ts";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNICODE = "café ☕ — naïve façade — 日本語 — multi\nline — quote ' and \" and ; DROP TABLE facts;--";

// ── child roles (separate processes) ──────────────────────────────────────────
async function writeSession(db: string): Promise<void> {
  const m = new MemoryStore(db, new LocalEmbedder());
  const f1 = await m.remember("OB-1 is written in TypeScript and runs on Bun");       // id 1
  await m.remember("Authentication uses JWT tokens issued by AuthService");           // id 2
  await m.remember("the cat sat quietly on the warm windowsill");                     // id 3
  m.updateFact(f1, "OB-1 is written in TypeScript and runs on the Bun runtime");      // → revision
  const tmp = await m.remember("ephemeral scratch note to archive");                  // id 4
  m.deleteFact(tmp);                                                                  // → archived
  await m.remember(UNICODE);                                                          // id 5 (unicode + injection-looking)
  m.addRelationship("LoginController", "calls", "AuthService");
  m.addRelationship("AuthService", "issues", "JWT");
  const old = m.addRelationship("AuthService", "uses", "SHA1");
  m.invalidateRelationship(old);                                                      // superseded, not deleted
  m.addRelationship("AuthService", "uses", "bcrypt");
  m.close();
}

async function appendSession(db: string): Promise<void> {
  const m = new MemoryStore(db, new LocalEmbedder());
  await m.remember("a second-session fact about GraphQL resolvers and caching");
  m.addRelationship("AuthService", "logs_to", "AuditTrail");
  m.close();
}

async function readState(db: string): Promise<any> {
  const m = new MemoryStore(db, new LocalEmbedder());
  const state = {
    active: m.listFacts().map((f) => ({ id: f.id, fact: f.fact, status: f.status })),
    archivedCount: m.stats().archived,
    fact1Revisions: m.revisions(1).map((r) => r.op),
    fact4Revisions: m.revisions(4).map((r) => r.op),
    relsActive: m.listRelationships().map((e) => `${e.src}-${e.rel}-${e.dst}`),
    relsAll: m.listRelationships(true).length,
    invalidated: m.listRelationships(true).filter((e) => e.invalidated).length,
    stats: m.stats(),
    semanticTop: (await m.searchSemantic("JWT login authentication token", 1))[0]?.fact ?? "",
    neighborhood: m.neighborhood("AuthService", 1).map((e) => `${e.src}-${e.rel}-${e.dst}`).sort(),
    unicodeExact: m.listFacts().some((f) => f.fact === UNICODE),
    backend: m.vectorBackend(),
  };
  m.close();
  return state;
}

// ── dispatch: a child run if invoked with a role, else the orchestrator ────────
const role = process.argv[2];
const dbArg = process.argv[3];
if (role === "write") { await writeSession(dbArg); process.exit(0); }
if (role === "append") { await appendSession(dbArg); process.exit(0); }
if (role === "read") { process.stdout.write(JSON.stringify(await readState(dbArg))); process.exit(0); }

// ── orchestrator ───────────────────────────────────────────────────────────────
let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

async function spawnRole(role: string, db: string): Promise<string> {
  const proc = Bun.spawn(["bun", "run", import.meta.path, role, db], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`worker '${role}' exited ${code}: ${await new Response(proc.stderr).text()}`);
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "ob1-mem-session-"));
const savedVec = process.env.OB1_VEC;
try {
  const db = join(dir, "deep", "memory.db"); // nested path → also exercises mkdir of a missing parent dir

  // ── Session 1 writes, Session 2 (a DIFFERENT process) reads everything back ──
  await spawnRole("write", db);
  check("write session created the db file", existsSync(db));
  const s2 = JSON.parse(await spawnRole("read", db));

  check("active facts survive a separate process (4 active)", s2.active.length === 4, `${s2.active.length}`);
  check("a fact UPDATE persists across sessions", s2.active.find((f: any) => f.id === 1)?.fact === "OB-1 is written in TypeScript and runs on the Bun runtime");
  check("an ARCHIVED fact stays archived across sessions", s2.archivedCount === 1 && !s2.active.some((f: any) => f.id === 4));
  check("revision trail persists (fact 1: created→updated)", JSON.stringify(s2.fact1Revisions) === JSON.stringify(["created", "updated"]));
  check("revision trail persists (fact 4: created→deleted)", JSON.stringify(s2.fact4Revisions) === JSON.stringify(["created", "deleted"]));
  check("active relationships persist (3)", s2.relsActive.length === 3 && s2.relsActive.includes("AuthService-uses-bcrypt"));
  check("invalidated edge persists but is excluded (bi-temporal)", s2.invalidated === 1 && s2.relsAll === 4 && !s2.relsActive.includes("AuthService-uses-SHA1"));
  check("entities persist (LoginController, AuthService, JWT, SHA1, bcrypt = 5)", s2.stats.entities === 5, `${s2.stats.entities}`);
  check("semantic search works in a fresh process (vectors reloaded)", /JWT|Authentication/i.test(s2.semanticTop), s2.semanticTop);
  check("bounded neighborhood reconstructs across sessions", s2.neighborhood.length === 3 && s2.neighborhood.includes("AuthService-issues-JWT"));
  check("unicode + quotes + injection text round-trips byte-exact", s2.unicodeExact === true);

  // ── Session 3 appends; Session 4 proves CUMULATIVE persistence over multiple sessions ──
  await spawnRole("append", db);
  const s4 = JSON.parse(await spawnRole("read", db));
  check("appended fact persists on top of session-1 data (5 active)", s4.active.length === 5 && s4.active.some((f: any) => /GraphQL/.test(f.fact)));
  check("appended relationship persists (4 active)", s4.relsActive.length === 4 && s4.relsActive.includes("AuthService-logs_to-AuditTrail"));
  check("earlier-session data untouched by the append", s4.active.find((f: any) => f.id === 1)?.fact.includes("Bun runtime") && s4.archivedCount === 1);

  // ── In-process robustness probes ──
  // (a) concurrent connections: two stores open on ONE db, a write through A is visible to B (WAL).
  const cdb = join(dir, "concurrent.db");
  const A = new MemoryStore(cdb, new LocalEmbedder());
  const B = new MemoryStore(cdb, new LocalEmbedder());
  const cid = await A.remember("written through connection A while B is open");
  check("a write on one open connection is visible to another (WAL)", B.listFacts().some((f) => f.id === cid));
  check("the second connection can also write without corruption", (await B.remember("written through connection B")) > 0 && A.listFacts(true).length >= 2);
  A.close(); B.close();

  // (b) huge content + empty/whitespace facts round-trip.
  const hdb = join(dir, "huge.db");
  const H = new MemoryStore(hdb, new LocalEmbedder());
  const big = "x".repeat(200_000) + " needle " + "y".repeat(50_000);
  const hid = await H.remember(big);
  await H.remember("   "); // whitespace-only
  H.close();
  const H2 = new MemoryStore(hdb, new LocalEmbedder());
  check("a 250KB fact round-trips intact across a reopen", H2.listFacts().find((f) => f.id === hid)?.fact === big);
  check("whitespace-only fact is stored (no crash)", H2.listFacts().length === 2);
  H2.close();

  // (c) schema idempotency + large volume: open/close 3×, 300 facts, all survive and stay searchable.
  const vdb = join(dir, "volume.db");
  for (let pass = 0; pass < 3; pass++) { const V = new MemoryStore(vdb, new LocalEmbedder()); V.close(); } // reopen is a no-op on data
  const V = new MemoryStore(vdb, new LocalEmbedder());
  for (let i = 0; i < 300; i++) await V.remember(`record ${i}: the quick brown fox jumps over lazy dog number ${i}`);
  V.close();
  const V2 = new MemoryStore(vdb, new LocalEmbedder());
  check("300 facts survive repeated reopen (schema idempotent)", V2.listFacts().length === 300, `${V2.listFacts().length}`);
  check("semantic search still works at volume", (await V2.searchSemantic("record 287 quick brown fox", 3)).length === 3);
  V2.close();

  // (d) corrupt-db recovery: a garbage file must NOT brick startup — it's quarantined and a fresh store opens.
  const xdb = join(dir, "corrupt.db");
  writeFileSync(xdb, "this is definitely not a sqlite database file at all\n".repeat(50));
  const X = new MemoryStore(xdb, new LocalEmbedder());
  check("corrupt db is recovered (quarantined), not fatal", X.recovered !== null);
  check("the corrupt file was moved aside (preserved for recovery)", !!X.recovered && existsSync(X.recovered));
  check("a fresh, usable store opens after recovery", (await X.remember("post-recovery fact")) > 0 && X.listFacts().length === 1);
  X.close();
  const X2 = new MemoryStore(xdb, new LocalEmbedder());
  check("the recovered store itself now persists across a reopen", X2.listFacts().some((f) => /post-recovery/.test(f.fact)) && X2.recovered === null);
  X2.close();

  // (e) a HEALTHY db is never quarantined on reopen (guard against over-eager recovery).
  check("no spurious .corrupt-* files left around healthy DBs", !readdirSync(dir).some((f) => f.includes(".corrupt-") && !f.startsWith("corrupt.db")));
} finally {
  if (savedVec === undefined) delete process.env.OB1_VEC; else process.env.OB1_VEC = savedVec;
  rmSync(dir, { recursive: true, force: true });
}

if (fail) { console.error("\n✗ memory-session smoke FAILED"); process.exit(1); }
console.log("\n✓ memory-session smoke passed (separate-process persistence · full state · concurrency · huge/unicode · volume · corrupt-db recovery)");
process.exit(0);
