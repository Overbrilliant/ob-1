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
  opts: { triggerChars?: number; keepRecent?: number } = {},
): EditResult {
  const triggerChars = opts.triggerChars ?? envNum("OB1_CTX_TRIGGER", 200_000); // ~50k tokens (was ~12k)
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

/** Optional LLM-summary compaction. Without a summarizer this is a no-op (returns false). */
export async function compactIfNeeded(
  history: Message[],
  opts: { hardCapChars?: number; summarize?: (older: Message[]) => Promise<string> } = {},
): Promise<boolean> {
  const hardCap = opts.hardCapChars ?? envNum("OB1_CTX_HARDCAP", 600_000); // ~150k tokens (was ~40k)
  if (!opts.summarize || totalChars(history) < hardCap) return false;
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
  const summary = await opts.summarize(older);
  history.splice(0, older.length, {
    role: "user",
    content: `[Earlier conversation compacted to a summary]\n${summary}`,
  });
  return true;
}
