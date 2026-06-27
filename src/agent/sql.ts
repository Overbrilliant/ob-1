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

/** A single statement's leading keyword, upper-cased. */
function leadingKeyword(sql: string): string {
  const s = stripLeading(sql);
  const m = s.match(/^([a-zA-Z]+)/);
  return m ? m[1].toUpperCase() : "";
}

/** Split a script into its individual statements on `;`, IGNORING semicolons inside string literals
 *  ('…' / "…", incl. doubled-quote escapes) and -- / block comments. The safety gate must see EVERY
 *  statement — `db.exec()` runs the whole script, so a classifier that only looked at the first statement
 *  let "UPDATE … WHERE …; DROP TABLE users" pass as an ordinary write while the DROP still executed. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {                 // -- line comment → to EOL
      const nl = sql.indexOf("\n", i); const end = nl === -1 ? sql.length : nl;
      cur += sql.slice(i, end); i = end - 1; continue;
    }
    if (c === "/" && sql[i + 1] === "*") {                 // /* block comment */
      const close = sql.indexOf("*/", i + 2); const end = close === -1 ? sql.length : close + 2;
      cur += sql.slice(i, end); i = end - 1; continue;
    }
    if (c === "'" || c === '"') {                          // string literal (handles '' / "" escapes)
      const q = c; cur += c; i++;
      for (; i < sql.length; i++) {
        cur += sql[i];
        if (sql[i] === q) { if (sql[i + 1] === q) { cur += sql[++i]; continue; } break; }
      }
      continue;
    }
    if (c === ";") { if (cur.trim()) out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** A DELETE/UPDATE is "destructive" only when it has NO WHERE clause (whole-table mutation). With a
 *  WHERE it's an ordinary, gated write. Operates on ONE statement. */
function unscopedMutation(stmt: string): boolean {
  const s = stripLeading(stmt);
  if (!/^\s*(delete|update)\b/i.test(s)) return false;
  return !/\bwhere\b/i.test(s);
}

/** Classify a SINGLE statement for the safety gate. */
function classifyOne(stmt: string): SqlKind {
  const s = stripLeading(stmt);
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

/** Severity used to fold a multi-statement script down to ONE kind: a script is as dangerous as its most
 *  dangerous statement, so the destructive gate fires when ANY statement is destructive. */
const SQL_RANK: Record<SqlKind, number> = { empty: 0, read: 1, unknown: 2, write: 3, ddl: 4, destructive: 5 };

/** Classify SQL (one statement OR a multi-statement script) for the safety gate. Returns the most
 *  dangerous statement's kind. Pure + exported for tests. */
export function classifySql(sql: string): SqlKind {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return "empty";
  let worst: SqlKind = "empty";
  for (const st of stmts) { const k = classifyOne(st); if (SQL_RANK[k] > SQL_RANK[worst]) worst = k; }
  return worst;
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
