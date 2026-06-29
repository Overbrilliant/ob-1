// Context management (Phase 1) — keep the window lean over long turns (R3).
//
// context-editing: when history grows past a trigger, evict the *output* of older tool
// results (the bulkiest, most disposable tokens) and replace it with a tiny placeholder,
// preserving conversation flow — the same idea as Anthropic's clear_tool_uses. Deterministic
// and reversible-in-spirit (the model can re-run a tool if it needs the data again).
//
// LLM-summary compaction (summarize old turns into a note) is a further layer that needs the
// model; see compactIfNeeded() which is a no-op without a summarizer.
import type { Message } from "../providers/types.ts";
import { contextWindowFor, maxOutputFor } from "../providers/models.ts";

export function totalChars(history: Message[]): number {
  let n = 0;
  for (const m of history) n += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  return n;
}

export function approxTokens(history: Message[]): number {
  return Math.round(totalChars(history) / 4); // ~4 chars/token heuristic
}

export interface EditResult { cleared: number; savedChars: number }

const envNum = (key: string, fallback: number): number => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Like envNum but returns null when unset/invalid, so an adaptive default can take over instead of a
 *  hard-coded one. Lets the env vars act as explicit OVERRIDES of the model-scaled thresholds below. */
const envNumOrNull = (key: string): number | null => {
  if (process.env[key] == null) return null;
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const CHARS_PER_TOKEN = 4; // matches approxTokens()

// Fractions of the usable input budget at which each layer engages. Eviction (cheap, deterministic)
// kicks in first; full summary compaction is the last resort, mirroring Claude Code's ~83.5% auto-compact.
const EVICT_FRACTION = 0.60;
const COMPACT_FRACTION = 0.85;

/** Usable input budget in CHARS for a model: (context window − output reserve) × chars/token. This is
 *  what compaction measures `totalChars(history)` against, so the thresholds SCALE with the active model —
 *  a 1M-token model is no longer compacted at a 128k model's limit. Unknown/custom ids fall back to a
 *  conservative window via contextWindowFor(). The output reserve keeps room for the model's reply. */
export function budgetChars(model: string): number {
  const ctxTok = contextWindowFor(model);
  const inputTok = Math.max(ctxTok - maxOutputFor(model), Math.floor(ctxTok / 2)); // never less than half the window
  return inputTok * CHARS_PER_TOKEN;
}

/** Base instruction for history summarization — used by both auto-compaction and manual /compact, so the
 *  two stay in lockstep. Captures the things worth carrying forward across a compaction boundary. */
export const SUMMARY_SYSTEM =
  "Summarize the earlier conversation into a compact note: preserve decisions made, file paths touched, failed tests/errors, and open tasks. Be terse — bullet points, no preamble.";

/** Build the summarizer system prompt, optionally biased toward a user-supplied focus (`/compact <focus>`). */
export function summaryPrompt(focus?: string): string {
  const f = focus?.trim();
  return f ? `${SUMMARY_SYSTEM}\nFocus especially on: ${f}` : SUMMARY_SYSTEM;
}

/** Map each tool_use id → its tool name + (if any) the file path it targeted, by scanning assistant
 *  turns. Lets eviction reason about WHAT a tool_result contains (a read of foo.ts vs a bash dump). */
function toolUseMeta(history: Message[]): Map<string, { name: string; path?: string }> {
  const meta = new Map<string, { name: string; path?: string }>();
  for (const m of history) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b.type === "tool_use") {
        const path = typeof b.input?.path === "string" ? b.input.path : undefined;
        meta.set(b.id, { name: b.name, path });
      }
    }
  }
  return meta;
}

/** Evict stale tool-result output to keep the window lean over long turns — but PROTECT the working set.
 *
 *  What this fixes: the old version evicted EVERY tool result older than the last 6 messages, including
 *  the file contents the model needs to reason across files (a cross-file CSS/SSR change would lose every
 *  file it had read and start hallucinating). Now eviction is path-aware:
 *    • the LATEST read_file of each distinct path is kept (the model always has every file's current view);
 *    • bulky, re-runnable output (bash dumps, web fetches, superseded earlier reads of a re-read file) is
 *      what gets reclaimed first;
 *    • thresholds are far higher (quality over token thrift) and env-tunable.
 */
export function editContext(
  history: Message[],
  opts: { triggerChars?: number; keepRecent?: number; model?: string } = {},
): EditResult {
  // Precedence: explicit env override → caller-supplied absolute → model-adaptive → legacy default.
  const triggerChars =
    envNumOrNull("OB1_CTX_TRIGGER")
    ?? opts.triggerChars
    ?? (opts.model ? Math.round(budgetChars(opts.model) * EVICT_FRACTION) : 200_000);
  const keepRecent = opts.keepRecent ?? envNum("OB1_CTX_KEEP", 12);             // last N messages always kept (was 6)
  if (totalChars(history) < triggerChars) return { cleared: 0, savedChars: 0 };

  const meta = toolUseMeta(history);

  // The latest read_file result for each path — its content is the freshest view of that file and must
  // survive eviction so the model keeps a coherent picture of everything it has opened.
  const latestRead = new Map<string, { mi: number; bi: number }>();
  history.forEach((m, mi) => {
    if (!Array.isArray(m.content)) return;
    (m.content as any[]).forEach((b, bi) => {
      if (b.type !== "tool_result") return;
      const info = meta.get(b.tool_use_id);
      if (info?.name === "read_file" && info.path) latestRead.set(info.path, { mi, bi }); // last assignment wins → freshest
    });
  });
  const isProtectedRead = (mi: number, bi: number, path?: string): boolean => {
    if (!path) return false;
    const l = latestRead.get(path);
    return !!l && l.mi === mi && l.bi === bi;
  };

  let cleared = 0;
  let saved = 0;
  const cutoff = Math.max(0, history.length - keepRecent);
  for (let i = 0; i < cutoff; i++) {
    const m = history[i];
    if (!Array.isArray(m.content)) continue;
    (m.content as any[]).forEach((b, bi) => {
      if (b.type !== "tool_result" || typeof b.content !== "string" || b.content.length <= 80 || b.content.startsWith("[cleared")) return;
      const info = meta.get(b.tool_use_id);
      if (isProtectedRead(i, bi, info?.path)) return; // keep the freshest read of every file
      const placeholder = `[cleared: ${b.content.length} chars of ${info?.name ?? "tool"} output${info?.path ? ` for ${info.path}` : ""} evicted to save context — re-run the tool if you need it again]`;
      saved += b.content.length - placeholder.length;
      b.content = placeholder;
      cleared++;
    });
  }
  return { cleared, savedChars: saved };
}

/** Optional LLM-summary compaction. Fires only once history passes the (model-adaptive) hard cap; without
 *  a summarizer it's a no-op. Threshold precedence: env override → caller absolute → adaptive → legacy. */
export async function compactIfNeeded(
  history: Message[],
  opts: { hardCapChars?: number; summarize?: (older: Message[]) => Promise<string>; model?: string } = {},
): Promise<boolean> {
  const hardCap =
    envNumOrNull("OB1_CTX_HARDCAP")
    ?? opts.hardCapChars
    ?? (opts.model ? Math.round(budgetChars(opts.model) * COMPACT_FRACTION) : 600_000);
  if (!opts.summarize || totalChars(history) < hardCap) return false;
  return doCompact(history, opts.summarize);
}

/** Force summary compaction NOW regardless of size (manual /compact). Returns false when there isn't
 *  enough older history to be worth summarizing (the kept window already covers everything). */
export async function compactNow(
  history: Message[],
  summarize: (older: Message[]) => Promise<string>,
): Promise<boolean> {
  return doCompact(history, summarize);
}

/** Shared core: summarize everything older than the kept window into one note spliced in at the front. */
async function doCompact(
  history: Message[],
  summarize: (older: Message[]) => Promise<string>,
): Promise<boolean> {
  const keep = 12;
  let cut = Math.max(0, history.length - keep);
  // The kept window must NOT begin on a user message whose tool_result blocks reference a tool_use we're
  // about to summarize away (its partner assistant turn sits immediately before it, in the removed slice).
  // That orphaned tool_result 400s the very next model call. Advance the cut past any such message until
  // the first kept message is safe to start on (a plain user turn or an assistant turn). Always keep ≥1.
  const isOrphanResult = (m?: Message): boolean =>
    !!m && m.role === "user" && Array.isArray(m.content) && (m.content as any[]).some((b) => b?.type === "tool_result");
  while (cut < history.length - 1 && isOrphanResult(history[cut])) cut++;
  const older = history.slice(0, cut);
  if (older.length < 2) return false;
  const summary = await summarize(older);
  history.splice(0, older.length, {
    role: "user",
    content: `[Earlier conversation compacted to a summary]\n${summary}`,
  });
  return true;
}
