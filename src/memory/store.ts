// OB-1 memory engine (Phase 1 core).
//
// Realizes the decided design (research R3 + R8):
//   • Fact store  — each memory is a plain-text `fact` with an immutable revision
//     history (Google Memory Bank model): readable + auditable.
//   • Relationship graph — entities + typed, bi-temporal edges (Graphiti-style):
//     edges are *invalidated, not deleted*, so we can ask "what was true when".
//   • Semantic retrieval — sqlite-vec KNN when a capable libsqlite3 is available (see vec.ts),
//     else a pure-TS brute-force cosine index over the same vectors (identical ranking).
//
// Everything lives in a single SQLite file (R7) via Bun's built-in driver.
import { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { cosine, type Embedder } from "./embed.ts";
import { prepareCustomSqlite, tryVecIndex, type VecIndex } from "./vec.ts";
import { rankCandidates, parseWeights, DEFAULT_IMPORTANCE, type RankCandidate } from "./rank.ts";
import { decideEvolution, clampImportance, EVOLVE_NEIGHBORS, type Ask, type Neighbor, type LinkProposal } from "./evolve.ts";
import { buildReflectPrompt, parseReflections, shouldReflect, REFLECTION_WINDOW, MAX_REFLECTION_DEPTH, type SourceFact } from "./reflect.ts";

/** Optional LLM "brain" wired into the store so writes can consolidate (item #4), reflect (#6), and
 *  auto-link (#7). All opt-in: when `evolve` is false the store appends exactly as before. The host
 *  passes one mutable object and flips the flags from `/memory evolve on|off`. */
export interface MemoryBrain {
  ask: Ask;                       // a cheap one-shot LLM call (prompt → text)
  evolve?: boolean;               // consolidate/dedup/contradiction on write (#4)
  reflect?: boolean;              // reflection trees (#6)
  autolink?: boolean;             // zettelkasten links (#7)
  onNote?: (note: string) => void;// visible surfacing ("merged into #N") — never silent
}

export interface Fact {
  id: number;
  scope: string;
  fact: string;
  status: "active" | "archived";
  /** 1–10 salience (Generative-Agents importance) — drives weighted retrieval (rank.ts). Defaults to
   *  DEFAULT_IMPORTANCE; the evolution pass (item #4) sets a real score at write time. */
  importance: number;
  /** '' for a normal fact, 'reflection' for a higher-level insight synthesized by the reflection pass (#6). */
  kind: string;
  /** 0 for raw facts; a reflection = max(source levels)+1. Bounds reflection-of-reflection depth. */
  reflection_level: number;
  created_at: string;
  updated_at: string;
}
export interface Revision {
  id: number;
  fact_id: number;
  fact: string;
  op: "created" | "updated" | "deleted";
  at: string;
}
export interface Entity {
  id: number;
  name: string;
  kind: string | null;
  summary: string | null;
  created_at: string;
}
export interface Relationship {
  id: number;
  src: string;
  rel: string;
  dst: string;
  valid_from: string;
  valid_to: string | null;
  invalidated: number;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'project',
  fact TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  importance INTEGER NOT NULL DEFAULT 5,
  kind TEXT NOT NULL DEFAULT '',
  reflection_level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reflection_sources (
  reflection_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  PRIMARY KEY (reflection_id, source_id)
);
CREATE TABLE IF NOT EXISTS fact_links (
  src_fact_id INTEGER NOT NULL,
  dst_fact_id INTEGER NOT NULL,
  rel TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (src_fact_id, dst_fact_id, rel)
);
CREATE TABLE IF NOT EXISTS fact_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id INTEGER NOT NULL,
  fact TEXT NOT NULL,
  op TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT,
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL,
  rel TEXT NOT NULL,
  dst TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  invalidated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fact_vectors (
  fact_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
`;

const now = () => new Date().toISOString();

export class MemoryStore {
  private db: Database;
  private embedder?: Embedder;
  private vecCache = new Map<number, Float32Array>();
  private vec: VecIndex | null = null;
  /** Set to the quarantine path when a corrupt DB was recovered from (else null). The host surfaces a
   *  startup note so the user knows memory was reset (and where the old, unreadable file was moved). */
  recovered: string | null = null;

  private brain?: MemoryBrain;

  constructor(dbPath: string, embedder?: Embedder, brain?: MemoryBrain) {
    mkdirSync(dirname(dbPath), { recursive: true });
    prepareCustomSqlite();              // before the first `new Database` — enables sqlite-vec if a capable libsqlite3 exists
    this.db = this.openOrRecover(dbPath);
    this.brain = brain;
    if (embedder) {
      this.embedder = embedder;
      this.vec = tryVecIndex(this.db);  // sqlite-vec KNN when available; null → pure-TS cosine below
      this.loadVectors();
    }
  }

  /** Open the DB and ensure the schema. WAL + `CREATE TABLE IF NOT EXISTS` are idempotent, so reopening
   *  an existing DB preserves all data (the across-sessions guarantee). */
  private static openSchema(dbPath: string): Database {
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    MemoryStore.migrate(db);
    db.query("SELECT COUNT(*) FROM facts").get(); // force a real read so corruption surfaces HERE, not mid-turn
    return db;
  }

  /** Idempotent column migrations for DBs created before a schema field existed. `CREATE TABLE IF NOT
   *  EXISTS` won't add a column to an existing table, so we ALTER in any missing one (weighted-retrieval
   *  importance, item #5). Safe to run on every open. */
  private static migrate(db: Database): void {
    const cols = db.query("PRAGMA table_info(facts)").all() as { name: string }[];
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has("importance")) db.exec(`ALTER TABLE facts ADD COLUMN importance INTEGER NOT NULL DEFAULT ${DEFAULT_IMPORTANCE}`);
    if (!has("kind")) db.exec("ALTER TABLE facts ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
    if (!has("reflection_level")) db.exec("ALTER TABLE facts ADD COLUMN reflection_level INTEGER NOT NULL DEFAULT 0");
  }

  /** Open the DB; if the file is corrupt/unreadable, QUARANTINE it (rename aside) and start fresh so a
   *  damaged memory.db can never brick startup. Only triggers on genuine corruption signals — a transient
   *  error (permissions, disk full) re-throws so we never destroy recoverable data. */
  private openOrRecover(dbPath: string): Database {
    try {
      return MemoryStore.openSchema(dbPath);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "").toLowerCase();
      const corrupt = msg.includes("not a database") || msg.includes("malformed") || msg.includes("file is encrypted") || msg.includes("disk image") || msg.includes("unsupported file format");
      if (dbPath === ":memory:" || !corrupt) throw e;
      const bak = `${dbPath}.corrupt-${Date.now()}`;
      let moved = false;
      for (const ext of ["", "-wal", "-shm"]) { try { renameSync(dbPath + ext, bak + ext); moved = true; } catch { /* part may not exist */ } }
      if (!moved) throw e; // couldn't move the bad file aside → surface the original error rather than loop
      const db = MemoryStore.openSchema(dbPath); // the path is clear now → a fresh, empty DB
      this.recovered = bak;
      return db;
    }
  }

  /** Which semantic-search backend is active (for the startup note). */
  vectorBackend(): "sqlite-vec" | "cosine" { return this.vec ? "sqlite-vec" : "cosine"; }

  // ---- Semantic vector index (sqlite-vec KNN when available; pure-TS cosine otherwise) ----
  // fact_vectors (BLOBs) is the persistent source of truth; the vecCache mirrors it for the cosine
  // path, and the sqlite-vec index (if any) is seeded from it here at load.
  private loadVectors(): void {
    const dim = this.embedder?.dim;
    const activeIds = new Set((this.db.query("SELECT id FROM facts WHERE status='active'").all() as { id: number }[]).map((r) => r.id));
    const rows = this.db.query("SELECT fact_id, vec FROM fact_vectors").all() as { fact_id: number; vec: Uint8Array }[];
    for (const r of rows) {
      const u8 = r.vec;
      const view = new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
      const vec = new Float32Array(view);
      // Skip vectors written by a DIFFERENT embedder (dimension mismatch — the user switched embedders
      // between sessions). cosine() truncates to the shorter length and would produce a meaningless
      // similarity, silently corrupting ranking. A skipped fact is re-embedded when it's next written.
      if (dim != null && vec.length !== dim) continue;
      this.vecCache.set(r.fact_id, vec);
      if (activeIds.has(r.fact_id)) this.vec?.upsert(r.fact_id, vec); // KNN index holds ACTIVE facts only
    }
  }

  private async indexVector(factId: number, text: string): Promise<void> {
    if (!this.embedder) return;
    const [vec] = await this.embedder.embed([text]);
    const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .query("INSERT INTO fact_vectors (fact_id, dim, vec) VALUES (?, ?, ?) ON CONFLICT(fact_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec")
      .run(factId, vec.length, bytes);
    this.vecCache.set(factId, vec);
    this.vec?.upsert(factId, vec);
  }

  /** Add a fact AND index it for semantic search (the public write path). `importance` (1–10) defaults
   *  to the mid value. When the brain's `evolve` flag is on (and an embedder + ask exist), the write is
   *  routed through LLM-managed consolidation (item #4) instead of a blind append. */
  async remember(fact: string, scope = "project", importance = DEFAULT_IMPORTANCE): Promise<number> {
    let id: number, imp: number;
    if (this.brain?.evolve && this.embedder) {
      const r = await this.rememberEvolving(fact, scope);
      id = r.id; imp = r.importance;
    } else {
      id = this.addFact(fact, scope, importance);
      await this.indexVector(id, fact);
      imp = importance;
    }
    await this.maybeReflect(imp); // accumulate salience; distill into reflections when the threshold trips (#6)
    return id;
  }

  /** Pure-relevance nearest same-scope facts (cosine top-k) — the candidate set for evolution/linking
   *  (we want semantic neighbors, not the recency/importance-weighted retrieval order). */
  private async nearestByRelevance(text: string, k: number, scope: string): Promise<Neighbor[]> {
    if (!this.embedder || this.vecCache.size === 0) return [];
    const [q] = await this.embedder.embed([text]);
    const active = new Map(this.listFacts().filter((f) => f.scope === scope).map((f) => [f.id, f] as const));
    const scored: { id: number; s: number }[] = [];
    for (const [id, vec] of this.vecCache) if (active.has(id)) scored.push({ id, s: cosine(q, vec) });
    scored.sort((a, b) => b.s - a.s || a.id - b.id);
    return scored.slice(0, k).map((x) => ({ id: x.id, fact: active.get(x.id)!.fact }));
  }

  /** Consolidating write (item #4): ask the brain whether the new fact should ADD / UPDATE / DELETE /
   *  NOOP against its nearest neighbors, then apply — preserving immutable revisions throughout. A
   *  decision failure falls back to ADD (handled in decideEvolution) so a fact is never lost. */
  private async rememberEvolving(fact: string, scope: string): Promise<{ id: number; importance: number }> {
    const neighbors = await this.nearestByRelevance(fact, EVOLVE_NEIGHBORS, scope);
    let decision;
    try { decision = await decideEvolution(fact, neighbors, this.brain!.ask); }
    catch { decision = { event: "ADD" as const, importance: DEFAULT_IMPORTANCE, links: [], linksRequested: 0 }; } // ask threw → never lose the fact
    const imp = clampImportance(decision.importance);
    const note = (s: string) => this.brain?.onNote?.(s);
    let id: number;
    switch (decision.event) {
      case "UPDATE":
        id = decision.id!;
        this.updateFact(id, decision.text || fact); // records a revision
        this.setImportance(id, imp);
        await this.indexVector(id, decision.text || fact); // text changed → re-embed
        note(`merged into #${id}`);
        break;
      case "DELETE":
        this.deleteFact(decision.id!); // archive the contradicted fact (revision kept; recoverable)
        id = this.addFact(fact, scope, imp);
        await this.indexVector(id, fact);
        note(`superseded #${decision.id} → #${id}`);
        break;
      case "NOOP":
        id = decision.id!;
        note(`duplicate of #${decision.id} — kept existing`);
        break;
      default: // ADD
        id = this.addFact(fact, scope, imp);
        await this.indexVector(id, fact);
        note(`remembered #${id}`);
    }
    // Auto-linking (item #7): the same evolve call also proposed related-memory links — apply them
    // (bounded, deduped, idempotent), riding one LLM round-trip. Gated on the autolink flag.
    if (this.brain?.autolink) this.applyLinks(id, decision.links, decision.linksRequested);
    return { id, importance: imp };
  }

  /** Apply the validated link proposals from the evolution call as idempotent fact↔fact edges; log the
   *  clamp (requested vs kept) — never silently drop ([[visible-progress-no-silent-work]]). */
  private applyLinks(srcId: number, links: LinkProposal[], requested: number): void {
    let kept = 0;
    for (const l of links) if (this.linkFacts(srcId, l.targetId, l.rel)) kept++;
    const dropped = Math.max(0, requested - kept);
    if (kept) this.brain?.onNote?.(`🔗 linked #${srcId} → ${kept} fact${kept === 1 ? "" : "s"}${dropped > 0 ? ` (${dropped} dropped)` : ""}`);
  }

  // ---- Auto-linked fact graph (item #7) — fact↔fact typed edges (distinct from the named-entity
  // relationship graph; facts are id'd, not named). Idempotent so re-surfacing a pair is a no-op. ----
  linkFacts(srcId: number, dstId: number, rel: string): boolean {
    if (srcId === dstId) return false; // no self-links
    return !!this.db
      .query("INSERT OR IGNORE INTO fact_links (src_fact_id, dst_fact_id, rel, created_at) VALUES (?, ?, ?, ?)")
      .run(srcId, dstId, rel, now()).changes;
  }
  factLinks(id: number): { dst: number; rel: string }[] {
    return this.db.query("SELECT dst_fact_id as dst, rel FROM fact_links WHERE src_fact_id = ? ORDER BY dst_fact_id").all(id) as { dst: number; rel: string }[];
  }

  // ---- Reflection (item #6): distil recent salient facts into higher-level insights ----
  private reflectAccum = 0; // Σ importance of facts remembered since the last reflection

  /** Accumulate salience; when it crosses the threshold, fire one reflection pass and reset. The reset
   *  happens BEFORE distillation so the reflections we create (added via addFact, not remember) can't
   *  re-trigger us — combined with the depth cap this keeps the reflection tree bounded. */
  private async maybeReflect(addedImportance: number): Promise<void> {
    if (!this.brain?.reflect || !this.embedder) return;
    this.reflectAccum += addedImportance;
    if (!shouldReflect(this.reflectAccum)) return;
    this.reflectAccum = 0;
    await this.reflect();
  }

  /** Most-recent active facts eligible as reflection sources (level below the cap, so a new reflection's
   *  level = max(source)+1 never exceeds MAX_REFLECTION_DEPTH). */
  private reflectionWindow(limit: number): SourceFact[] {
    return this.db
      .query(`SELECT id, fact, reflection_level FROM facts WHERE status='active' AND reflection_level < ? ORDER BY id DESC LIMIT ?`)
      .all(MAX_REFLECTION_DEPTH, limit) as SourceFact[];
  }

  /** Distil the recent window into reflection facts, each linked to its cited sources. Best-effort:
   *  any failure (LLM error, nothing worth generalizing) leaves memory untouched. */
  async reflect(): Promise<number> {
    if (!this.brain?.ask || !this.embedder) return 0;
    const recent = this.reflectionWindow(REFLECTION_WINDOW);
    if (recent.length < 2) return 0;
    let raw: string;
    try { raw = await this.brain.ask(buildReflectPrompt(recent)); } catch { return 0; }
    const levelOf = new Map(recent.map((f) => [f.id, f.reflection_level] as const));
    const insights = parseReflections(raw, new Set(recent.map((f) => f.id)));
    let made = 0;
    for (const ins of insights) {
      const level = Math.min(MAX_REFLECTION_DEPTH, Math.max(...ins.sourceIds.map((id) => levelOf.get(id) ?? 0)) + 1);
      const rid = this.addFact(ins.text, "project", ins.importance, { kind: "reflection", level });
      await this.indexVector(rid, ins.text);
      for (const sid of ins.sourceIds) {
        this.db.query("INSERT OR IGNORE INTO reflection_sources (reflection_id, source_id) VALUES (?, ?)").run(rid, sid);
      }
      made++;
    }
    if (made) this.brain.onNote?.(`💡 reflected: ${made} insight${made === 1 ? "" : "s"} from ${recent.length} recent facts`);
    return made;
  }

  /** Source fact ids a reflection was derived from (the `derived_from` links). */
  reflectionSources(reflectionId: number): number[] {
    return (this.db.query("SELECT source_id FROM reflection_sources WHERE reflection_id = ? ORDER BY source_id").all(reflectionId) as { source_id: number }[]).map((r) => r.source_id);
  }

  /** Flip the brain's evolution/reflection/auto-link flags at runtime (from `/memory evolve on|off`). */
  setMemoryFlags(flags: Partial<Pick<MemoryBrain, "evolve" | "reflect" | "autolink">>): void {
    if (this.brain) Object.assign(this.brain, flags);
  }
  get hasBrain(): boolean { return !!this.brain?.ask; }
  get evolveOn(): boolean { return !!this.brain?.evolve; }
  get reflectOn(): boolean { return !!this.brain?.reflect; }
  get autolinkOn(): boolean { return !!this.brain?.autolink; }

  /** Semantic top-k over active facts; falls back to keyword if no embedder/index.
   *  Two-stage retrieval (item #5): (1) prefilter the top-N by cosine RELEVANCE, then (2) re-rank that
   *  pool by the weighted Generative-Agents score (relevance + recency + importance), min-max normalized
   *  across the pool. With OB1_MEM_WEIGHTS="1,0,0" stage 2 reduces to pure cosine order (back-compat). */
  async searchSemantic(query: string, k = 8): Promise<Fact[]> {
    if (!this.embedder || this.vecCache.size === 0) return this.searchFacts(query, k);
    const [q] = await this.embedder.embed([query]);
    const active = new Map(this.listFacts().map((f) => [f.id, f] as const));
    // Stage 1: cosine for every active fact (vecCache mirrors fact_vectors), keep the top-N candidates.
    const scored: { id: number; relevance: number }[] = [];
    for (const [id, vec] of this.vecCache) if (active.has(id)) scored.push({ id, relevance: cosine(q, vec) });
    scored.sort((a, b) => b.relevance - a.relevance || a.id - b.id);
    const pool = scored.slice(0, Math.max(k * 6, 40));
    // Stage 2: weighted re-rank over the pool.
    const cands: RankCandidate[] = pool.map((s) => {
      const f = active.get(s.id)!;
      return { id: s.id, relevance: s.relevance, importance: f.importance, createdAtMs: Date.parse(f.created_at) || 0 };
    });
    const ids = rankCandidates(cands, Date.now(), parseWeights(process.env.OB1_MEM_WEIGHTS), k);
    return ids.map((id) => active.get(id)!);
  }

  // ---- Facts (with immutable revision trail) ----
  addFact(fact: string, scope = "project", importance = DEFAULT_IMPORTANCE, meta?: { kind?: string; level?: number }): number {
    const t = now();
    const info = this.db
      .query("INSERT INTO facts (scope, fact, status, importance, kind, reflection_level, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?)")
      .run(scope, fact, importance, meta?.kind ?? "", meta?.level ?? 0, t, t);
    const id = Number(info.lastInsertRowid);
    this.db
      .query("INSERT INTO fact_revisions (fact_id, fact, op, at) VALUES (?, ?, 'created', ?)")
      .run(id, fact, t);
    return id;
  }

  updateFact(id: number, newFact: string): boolean {
    const t = now();
    const r = this.db.query("UPDATE facts SET fact = ?, updated_at = ? WHERE id = ?").run(newFact, t, id);
    if (!r.changes) return false;
    this.db
      .query("INSERT INTO fact_revisions (fact_id, fact, op, at) VALUES (?, ?, 'updated', ?)")
      .run(id, newFact, t);
    return true;
  }

  /** Set a fact's importance (1–10 salience for weighted retrieval). Clamped to range. Used by the
   *  evolution pass (item #4); not a revision (importance is metadata, not the fact text). */
  setImportance(id: number, importance: number): boolean {
    const v = Math.max(1, Math.min(10, Math.round(importance)));
    return !!this.db.query("UPDATE facts SET importance = ? WHERE id = ?").run(v, id).changes;
  }

  /** Soft-delete: archive + record a revision. We never hard-delete memory. */
  deleteFact(id: number): boolean {
    const t = now();
    const row = this.db.query("SELECT fact FROM facts WHERE id = ?").get(id) as { fact: string } | null;
    if (!row) return false;
    this.db.query("UPDATE facts SET status = 'archived', updated_at = ? WHERE id = ?").run(t, id);
    this.vec?.remove(id); // keep the KNN index over ACTIVE facts only (so top-k never hides behind archived rows)
    this.db
      .query("INSERT INTO fact_revisions (fact_id, fact, op, at) VALUES (?, ?, 'deleted', ?)")
      .run(id, row.fact, t);
    return true;
  }

  listFacts(includeArchived = false): Fact[] {
    const sql = includeArchived
      ? "SELECT * FROM facts ORDER BY id"
      : "SELECT * FROM facts WHERE status = 'active' ORDER BY id";
    return this.db.query(sql).all() as Fact[];
  }

  /** Keyword top-k (sqlite-vec semantic retrieval is the next step, R3). */
  searchFacts(query: string, k = 8): Fact[] {
    return this.db
      .query("SELECT * FROM facts WHERE status = 'active' AND fact LIKE ? ORDER BY updated_at DESC LIMIT ?")
      .all(`%${query}%`, k) as Fact[];
  }

  revisions(factId: number): Revision[] {
    return this.db.query("SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY id").all(factId) as Revision[];
  }

  // ---- Relationship graph (entities + bi-temporal edges) ----
  addEntity(name: string, kind = "", summary = ""): void {
    // Non-destructive upsert: only overwrite kind/summary when a NON-EMPTY value is supplied. Otherwise an
    // addRelationship() → addEntity(name) call (which passes empty defaults) would wipe the described
    // kind/summary an earlier addEntity set — silently corrupting the entity graph.
    this.db
      .query(
        "INSERT INTO entities (name, kind, summary, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET " +
          "kind = CASE WHEN excluded.kind <> '' THEN excluded.kind ELSE entities.kind END, " +
          "summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE entities.summary END",
      )
      .run(name, kind, summary, now());
  }

  listEntities(): Entity[] {
    return this.db.query("SELECT * FROM entities ORDER BY name").all() as Entity[];
  }

  /** Add a typed edge src --rel--> dst. Ensures both entities exist. */
  addRelationship(src: string, rel: string, dst: string): number {
    this.addEntity(src);
    this.addEntity(dst);
    const t = now();
    const info = this.db
      .query("INSERT INTO relationships (src, rel, dst, valid_from, valid_to, invalidated, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?)")
      .run(src, rel, dst, t, t);
    return Number(info.lastInsertRowid);
  }

  /** Bi-temporal: invalidate (not delete) an edge, closing its validity window. */
  invalidateRelationship(id: number): boolean {
    const t = now();
    return !!this.db
      .query("UPDATE relationships SET invalidated = 1, valid_to = ? WHERE id = ? AND invalidated = 0")
      .run(t, id).changes;
  }

  listRelationships(includeInvalidated = false): Relationship[] {
    const sql = includeInvalidated
      ? "SELECT * FROM relationships ORDER BY id"
      : "SELECT * FROM relationships WHERE invalidated = 0 ORDER BY id";
    return this.db.query(sql).all() as Relationship[];
  }

  /** Bounded k-hop neighbourhood around a seed entity (the only graph we ever
   *  inject into context — never the whole graph; cost-control rule, R8). */
  neighborhood(entity: string, hops = 1): Relationship[] {
    const seen = new Set<string>([entity]);
    let frontier = [entity];
    const edges: Relationship[] = [];
    const seenEdge = new Set<number>();
    for (let h = 0; h < hops; h++) {
      const next: string[] = [];
      for (const node of frontier) {
        const rows = this.db
          .query("SELECT * FROM relationships WHERE invalidated = 0 AND (src = ? OR dst = ?)")
          .all(node, node) as Relationship[];
        for (const e of rows) {
          if (!seenEdge.has(e.id)) { seenEdge.add(e.id); edges.push(e); }
          for (const n of [e.src, e.dst]) if (!seen.has(n)) { seen.add(n); next.push(n); }
        }
      }
      frontier = next;
    }
    return edges;
  }

  stats(): { facts: number; archived: number; entities: number; edges: number } {
    const one = (sql: string) => (this.db.query(sql).get() as { n: number }).n;
    return {
      facts: one("SELECT COUNT(*) n FROM facts WHERE status='active'"),
      archived: one("SELECT COUNT(*) n FROM facts WHERE status='archived'"),
      entities: one("SELECT COUNT(*) n FROM entities"),
      edges: one("SELECT COUNT(*) n FROM relationships WHERE invalidated=0"),
    };
  }

  close(): void { this.db.close(); }
}
