// Smoke: semantic memory with the sqlite-vec KNN index (and its pure-TS cosine fallback).
// Verifies retrieval correctness, that sqlite-vec ranking MATCHES the cosine baseline (parity),
// archived-fact filtering through the over-fetch path, and persistence across a reopen. Passes on
// either backend (sqlite-vec when a capable libsqlite3 exists, else cosine). Usage: bun run scripts/memory-vec-smoke.ts
import { MemoryStore } from "../src/memory/store.ts";
import { LocalEmbedder } from "../src/memory/embed.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

const FACTS = [
  "alpha uses TypeScript and Bun for the runtime",
  "beta deployment runs GitHub Actions continuous integration",
  "gamma the cat sat on the warm windowsill",
];
const tmp = mkdtempSync(join(tmpdir(), "ob1-vec-"));
const savedVec = process.env.OB1_VEC;

try {
  // Store A — sqlite-vec when available (this is the first Database in the process, so the custom
  // libsqlite3 gets set; on a host without one it transparently uses the cosine index).
  const dbA = join(tmp, "a.db");
  const A = new MemoryStore(dbA, new LocalEmbedder());
  const backend = A.vectorBackend();
  check(`vector backend active: ${backend}`, backend === "sqlite-vec" || backend === "cosine");
  for (const f of FACTS) await A.remember(f);

  const top = (await A.searchSemantic("TypeScript Bun runtime", 1))[0];
  check("retrieves the closest fact", /alpha/.test(top?.fact ?? ""), top?.fact);

  // Store B — cosine forced (OB1_VEC=0), same data. Used as the parity oracle.
  process.env.OB1_VEC = "0";
  const B = new MemoryStore(join(tmp, "b.db"), new LocalEmbedder());
  check("OB1_VEC=0 forces cosine backend", B.vectorBackend() === "cosine");
  for (const f of FACTS) await B.remember(f);
  delete process.env.OB1_VEC;

  for (const q of ["GitHub Actions CI", "cat windowsill", "TypeScript runtime"]) {
    const a = (await A.searchSemantic(q, 3)).map((f) => f.fact);
    const b = (await B.searchSemantic(q, 3)).map((f) => f.fact);
    check(`ranking parity (${backend} vs cosine) for "${q}"`, JSON.stringify(a) === JSON.stringify(b), `${a[0]} | ${b[0]}`);
  }

  // Archived facts must be excluded from semantic results (exercises the over-fetch+filter path).
  const gid = await A.remember("delta a unique ephemeral note about kittens");
  check("new fact retrievable", /delta/.test((await A.searchSemantic("delta ephemeral kittens note", 1))[0]?.fact ?? ""));
  A.deleteFact(gid);
  const afterDelete = (await A.searchSemantic("delta ephemeral kittens note", 5)).map((f) => f.fact).join("|");
  check("archived fact excluded from results", !/delta/.test(afterDelete), afterDelete || "(none)");
  A.close();

  // Persistence: reopen the same db → vectors reload (and reseed the vec index), search still works.
  const A2 = new MemoryStore(dbA, new LocalEmbedder());
  check("backend stable after reopen", A2.vectorBackend() === backend);
  const re = (await A2.searchSemantic("TypeScript Bun runtime", 1))[0];
  check("search works after reopen (vectors reloaded)", /alpha/.test(re?.fact ?? ""), re?.fact);
  A2.close();
  B.close();

  // Review #5: archived facts ranking ABOVE the active ones must not crowd them out of the KNN result.
  // (The index is kept active-only via vec.remove on deleteFact, so a plain top-k can't hide behind them.)
  const C = new MemoryStore(join(tmp, "c.db"), new LocalEmbedder());
  const ids: number[] = [];
  for (let i = 0; i < 12; i++) ids.push(await C.remember(`record number ${i} about widgets and gadgets`));
  for (let i = 0; i < 8; i++) C.deleteFact(ids[i]); // archive the 8 highest-ranking → must vanish entirely
  const arch = await C.searchSemantic("record about widgets and gadgets", 3);
  check("archive-pressure: KNN still returns k ACTIVE results (no lost facts)", arch.length === 3, `got ${arch.length}`);
  check("archive-pressure: no archived fact leaks into results", arch.every((f) => f.status === "active"));
  C.close();

  // Review #6: identical-embedding facts (a tie) → deterministic top-1, identical across backends.
  const tieFacts = Array.from({ length: 5 }, () => "identical embedding text for tie testing");
  const D = new MemoryStore(join(tmp, "d.db"), new LocalEmbedder());
  for (const f of tieFacts) await D.remember(f);
  const dTop = (await D.searchSemantic("identical embedding text for tie testing", 1))[0];
  D.close();
  process.env.OB1_VEC = "0";
  const E = new MemoryStore(join(tmp, "e.db"), new LocalEmbedder());
  for (const f of tieFacts) await E.remember(f);
  const eTop = (await E.searchSemantic("identical embedding text for tie testing", 1))[0];
  delete process.env.OB1_VEC;
  E.close();
  check("tie-break: deterministic top-1 across sqlite-vec ↔ cosine", dTop?.id === eTop?.id, `${dTop?.id} vs ${eTop?.id}`);
} finally {
  if (savedVec === undefined) delete process.env.OB1_VEC; else process.env.OB1_VEC = savedVec;
  rmSync(tmp, { recursive: true, force: true });
}

if (fail) { console.error("\n✗ memory-vec smoke FAILED"); process.exit(1); }
console.log("\n✓ memory-vec smoke passed (retrieval · sqlite-vec↔cosine parity · archived-filter · persistence)");
process.exit(0);
