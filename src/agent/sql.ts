// execute_sql — database tooling (gap 8.5). A real, zero-dependency SQLite engine via bun:sqlite (the
// same primitive the memory store uses), plus a statement classifier that powers the DB-safety contract:
// reads run freely, writes are approval-gated (mutating), and DESTRUCTIVE statements (DROP / TRUNCATE /
// DELETE-or-UPDATE without a WHERE) are blocked unless the call explicitly opts in — mirroring Replit's
// "never DELETE/UPDATE destructively unless requested" rule. The classifier is pure and exported so a
// smoke can exhaustively assert it without touching a database.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

export type SqlKind = "read" | "ddl" | "write" | "destructive" | "empty" | "unknown";

/** Strip line/block comments + leading whitespace so the leading keyword is reliable. */
function stripLeading(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")          // /* block comments */
    .replace(/^\s*(--[^\n]*\n)+/g, "")            // leading -- line comments
    .replace(/--[^\n]*/g, " ")                     // trailing line comments
    .trim();
}

/** The first SQL statement's leading keyword, upper-cased. */
function leadingKeyword(sql: string): string {
  const s = stripLeading(sql);
  const m = s.match(/^([a-zA-Z]+)/);
  return m ? m[1].toUpperCase() : "";
}

/** A DELETE/UPDATE is "destructive" only when it has NO WHERE clause (whole-table mutation). With a
 *  WHERE it's an ordinary, gated write. Looks at the first statement only (the common single-stmt case). */
function unscopedMutation(sql: string): boolean {
  const s = stripLeading(sql);
  const first = s.split(/;\s*/)[0];
  if (!/^\s*(delete|update)\b/i.test(first)) return false;
  return !/\bwhere\b/i.test(first);
}

/** Classify a statement for the safety gate. Pure + exported for tests. */
export function classifySql(sql: string): SqlKind {
  const s = stripLeading(sql);
  if (!s) return "empty";
  const kw = leadingKeyword(s);
  if (kw === "SELECT" || kw === "PRAGMA" || kw === "EXPLAIN" || kw === "VALUES") return "read";
  // WITH (CTE) is a read unless the CTE wraps an INSERT/UPDATE/DELETE.
  if (kw === "WITH") return /\b(insert|update|delete)\b/i.test(s) ? "write" : "read";
  if (kw === "DROP" || kw === "TRUNCATE") return "destructive";
  if (kw === "DELETE" || kw === "UPDATE") return unscopedMutation(s) ? "destructive" : "write";
  if (kw === "CREATE" || kw === "ALTER" || kw === "REINDEX" || kw === "VACUUM" || kw === "ANALYZE") return "ddl";
  if (kw === "INSERT" || kw === "REPLACE" || kw === "MERGE" || kw === "UPSERT") return "write";
  return "unknown";
}

/** Does this statement need a write (i.e. is NOT a pure read)? Drives the `mutating` approval gate. */
export function sqlMutates(sql: string): boolean {
  const k = classifySql(sql);
  return k === "write" || k === "destructive" || k === "ddl";
}

export interface SqlRunResult { kind: SqlKind; columns: string[]; rows: unknown[][]; changes: number; lastInsertRowid?: number | bigint }

/** Run SQL against a SQLite file. A single read statement returns rows; anything else is executed and we
 *  report the affected-row count. `dbPath` is resolved against `cwd`. Throws on SQL/IO errors (surfaced
 *  as a tool error upstream). */
export function runSqlite(cwd: string, dbFile: string, sql: string): SqlRunResult {
  const path = resolve(cwd, dbFile);
  const kind = classifySql(sql);
  const db = new Database(path, kind === "read" ? { readonly: true } : undefined); // writes create if absent; reads never do
  try {
    if (kind === "read") {
      const q = db.query(sql);
      const rows = q.all() as Record<string, unknown>[];
      const columns = rows.length ? Object.keys(rows[0]) : (q.columnNames ?? []);
      return { kind, columns, rows: rows.map((r) => columns.map((c) => r[c])), changes: rows.length };
    }
    // Non-read (incl. multi-statement scripts): exec and report the connection's change count.
    db.exec(sql);
    const changes = (db.query("SELECT changes() AS c").get() as { c: number } | null)?.c ?? 0;
    const last = (db.query("SELECT last_insert_rowid() AS r").get() as { r: number } | null)?.r;
    return { kind, columns: [], rows: [], changes, lastInsertRowid: last };
  } finally {
    db.close();
  }
}

/** Render a result set as a compact text table (capped), or a one-line status for a write. */
export function formatSqlResult(r: SqlRunResult, maxRows = 50): string {
  if (r.kind !== "read") {
    const idNote = r.kind === "write" && r.lastInsertRowid ? ` (last_insert_rowid=${r.lastInsertRowid})` : "";
    return `OK — ${r.kind} statement; ${r.changes} row(s) affected${idNote}.`;
  }
  if (!r.rows.length) return "OK — 0 rows.";
  const shown = r.rows.slice(0, maxRows);
  const cell = (v: unknown) => (v === null || v === undefined ? "NULL" : String(v));
  const widths = r.columns.map((c, i) => Math.max(c.length, ...shown.map((row) => cell(row[i]).length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join("  ");
  const out = [
    line(r.columns),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...shown.map((row) => line(row.map(cell))),
  ];
  if (r.rows.length > maxRows) out.push(`… ${r.rows.length - maxRows} more row(s) (showing first ${maxRows})`);
  else out.push(`(${r.rows.length} row${r.rows.length === 1 ? "" : "s"})`);
  return out.join("\n");
}
