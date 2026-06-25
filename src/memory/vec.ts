// sqlite-vec KNN index for semantic memory (the R7 design, done properly).
//
// The original build used a pure-TS brute-force cosine index because "neither bun:sqlite (no
// extension loading) nor better-sqlite3 dlopen under Bun." The first half is true — Bun's bundled
// SQLite is compiled WITHOUT dynamic extension loading — but Bun exposes `Database.setCustomSQLite()`
// to point at a libsqlite3 that DOES allow extensions (Homebrew's, or a Linux system lib). With that,
// sqlite-vec loads and runs KNN natively under Bun (probed: vec_version 0.1.9). When no capable
// libsqlite3 is found (or OB1_VEC=0), this returns null and store.ts keeps the pure-TS cosine index —
// identical results, just O(n) instead of an index. So it's a transparent upgrade, never a hard dep.
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync } from "node:fs";

let prepared = false;

function candidateLibs(): string[] {
  const out: string[] = [];
  if (process.env.OB1_SQLITE_LIB) out.push(process.env.OB1_SQLITE_LIB);
  try {
    const p = Bun.spawnSync(["brew", "--prefix", "sqlite"]);
    const pref = p.success ? new TextDecoder().decode(p.stdout).trim() : "";
    if (pref) out.push(`${pref}/lib/libsqlite3.dylib`, `${pref}/lib/libsqlite3.so`);
  } catch { /* brew not present */ }
  out.push(
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/lib/x86_64-linux-gnu/libsqlite3.so",
    "/usr/lib/aarch64-linux-gnu/libsqlite3.so",
    "/lib/x86_64-linux-gnu/libsqlite3.so",
    "/usr/lib/libsqlite3.so",
  );
  return out;
}

/** Point bun:sqlite at a libsqlite3 that allows extension loading. MUST run before the FIRST
 *  `new Database()` in the process (Bun requirement). Idempotent; no-op under OB1_VEC=0 or when no
 *  capable lib is found — the store then uses its pure-TS cosine index. */
export function prepareCustomSqlite(): void {
  if (prepared) return;
  prepared = true;
  if (process.env.OB1_VEC === "0") return;
  for (const lib of candidateLibs()) {
    try {
      if (!existsSync(lib)) continue;
      Database.setCustomSQLite(lib);
      return;
    } catch { /* a custom lib can't be set once a Database is open — fall through to no-vec */ }
  }
}

export interface VecIndex {
  upsert(factId: number, vec: Float32Array): void;
  remove(factId: number): void;
  /** fact_ids nearest to `query`, closest first (ties broken by fact_id asc for determinism).
   *  Empty when the index is empty or the dimension mismatches. */
  search(query: Float32Array, k: number): number[];
}

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** Build a sqlite-vec KNN index on `db`, or return null when the extension can't load (→ the store
 *  falls back to its pure-TS cosine index). Cosine metric matches the store's L2-normalized vectors. */
export function tryVecIndex(db: Database): VecIndex | null {
  if (process.env.OB1_VEC === "0") return null;
  try {
    db.loadExtension(sqliteVec.getLoadablePath());
  } catch {
    return null; // extension loading disabled (no custom libsqlite3) — pure-TS fallback
  }
  let dim = 0;
  // vec0 fixes the dimension at table-creation; (re)create on first use / dim change (e.g. the user
  // switched embedders between sessions). The persistent source of truth stays fact_vectors in store.ts.
  const ensure = (d: number) => {
    if (dim === d) return;
    db.exec("DROP TABLE IF EXISTS vec_facts");
    db.exec(`CREATE VIRTUAL TABLE vec_facts USING vec0(fact_id INTEGER PRIMARY KEY, embedding FLOAT[${d}] distance_metric=cosine)`);
    dim = d;
  };
  return {
    upsert(factId, vec) {
      ensure(vec.length);
      db.query("DELETE FROM vec_facts WHERE fact_id = ?").run(factId); // vec0 has no UPSERT
      db.query("INSERT INTO vec_facts(fact_id, embedding) VALUES (?, ?)").run(factId, toBlob(vec));
    },
    remove(factId) { if (dim) db.query("DELETE FROM vec_facts WHERE fact_id = ?").run(factId); },
    search(query, k) {
      if (!dim || query.length !== dim || k <= 0) return [];
      // Over-fetch a window so the deterministic (distance, fact_id) tiebreak below covers equal-distance
      // ties that straddle the top-k boundary — sqlite-vec's order among equal distances is otherwise
      // arbitrary, so a bare LIMIT k could pick a different tied row than the cosine path. (vec0 forbids
      // a secondary ORDER BY column, so the tiebreak is applied here.)
      const window = Math.max(k * 4, k + 32);
      const rows = db
        .query("SELECT fact_id, distance FROM vec_facts WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
        .all(toBlob(query), window) as { fact_id: number; distance: number }[];
      rows.sort((a, b) => a.distance - b.distance || a.fact_id - b.fact_id);
      return rows.slice(0, k).map((r) => r.fact_id);
    },
  };
}
