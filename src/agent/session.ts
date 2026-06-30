// Session persistence — every conversation is written to <dataDir>/sessions/<id>.json after each turn so
// it survives exit and can be reopened with /resume. Per-workspace (dataDir is the project's .ob1), so the
// resume picker is naturally scoped to the project you're in — the same model Claude Code uses.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../providers/types.ts";

const MAX_SESSIONS = 50; // keep the newest N per workspace; override with OB1_MAX_SESSIONS

export interface SessionMeta {
  id: string;
  title: string;
  created: number;
  updated: number;
  cwd: string;
  model: string;
  turns: number;
}
export interface SessionFile extends SessionMeta { history: Message[] }

const dir = (dataDir: string) => join(dataDir, "sessions");

/** A sortable, collision-resistant id: YYYYMMDD-HHMMSS-<rand>. */
export function newSessionId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** First user message, trimmed to a one-line title. */
export function deriveTitle(history: Message[]): string {
  const first = history.find((m) => m.role === "user");
  if (!first) return "(empty)";
  const raw = typeof first.content === "string"
    ? first.content
    : (first.content as any[]).map((b) => (b?.type === "text" ? b.text : "")).join(" ");
  // Title = the first paragraph only, so machine-appended suffixes don't leak in: the @mention attachment
  // block and the /goal "[Goal mode] …" instructions are both separated from the user's text by a blank line.
  const head = raw.split(/\n\s*\n/)[0];
  return head.replace(/\s+/g, " ").trim().slice(0, 72) || "(untitled)";
}

/** Persist a session (no-op for empty history — nothing worth resuming). Prunes oldest beyond the cap. */
export function saveSession(dataDir: string, sess: SessionFile): void {
  if (!sess.history.length) return;
  const d = dir(dataDir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sess.id}.json`), JSON.stringify(sess));
  pruneSessions(d);
}

/** Keep only the newest N session files (by mtime) so the directory can't grow without bound. The current
 *  session is rewritten each turn, so its mtime is always fresh — it's never the one pruned. */
function pruneSessions(d: string): void {
  const cap = Number(process.env.OB1_MAX_SESSIONS) > 0 ? Number(process.env.OB1_MAX_SESSIONS) : MAX_SESSIONS;
  try {
    const files = readdirSync(d).filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: statSync(join(d, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(cap)) { try { unlinkSync(join(d, f)); } catch { /* already gone */ } }
  } catch { /* prune is best-effort */ }
}

/** Metadata for saved sessions, newest first. Filtered to `cwd` when given (skips corrupt files). */
export function listSessions(dataDir: string, cwd?: string): SessionMeta[] {
  const d = dir(dataDir);
  if (!existsSync(d)) return [];
  const out: SessionMeta[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(d, f), "utf8")) as SessionFile;
      if (cwd && s.cwd !== cwd) continue;
      const { history, ...meta } = s;
      out.push(meta);
    } catch { /* skip a corrupt/partial file */ }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export function loadSession(dataDir: string, id: string): SessionFile | null {
  const p = join(dir(dataDir), `${id}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as SessionFile; } catch { return null; }
}

/** Human-friendly age, e.g. "3m ago", "2h ago", "5d ago". */
export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
