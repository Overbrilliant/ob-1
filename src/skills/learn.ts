// Automatic skill learning (Phase B) — distil a finished turn into reusable PROCEDURAL memory.
//
// After a substantive turn (and only when cfg.skillLearn is ON), one cheap LLM call reviews the
// transcript and decides whether it taught a GENERAL, reusable method worth saving as a skill —
// preferring to refine an existing related skill over creating a near-duplicate, and refusing to
// capture one-off/transient noise. Modeled on hermes-agent's _SKILL_REVIEW_PROMPT + background
// review, but as a single structured call rather than a forked agent. Writes via the registry, so it
// inherits the same provenance/protection guards (learned skills only, under .ob1/skills).
import type { Message } from "../providers/types.ts";
import { writeSkill, type SkillMeta } from "./registry.ts";

export interface LearnDecision {
  action: "create" | "update" | "none";
  name?: string;
  description?: string;
  body?: string;
  reason?: string;
}

export interface LearnOutcome { action: "create" | "update" | "none"; name?: string; reason?: string }

const MIN_TOOL_CALLS = 2; // only distil from turns that actually did work (hermes uses "5+ calls"; we're per-turn)

/** Count tool_use blocks in a transcript slice — the "did this turn do real work?" signal. */
export function countToolCalls(slice: Message[]): number {
  let n = 0;
  for (const m of slice) if (Array.isArray(m.content)) for (const b of m.content as any[]) if (b?.type === "tool_use") n++;
  return n;
}

/** True if the turn already called manage_skill — don't double-capture / recurse. */
function alreadyManagedSkill(slice: Message[]): boolean {
  return slice.some((m) => Array.isArray(m.content) && (m.content as any[]).some((b) => b?.type === "tool_use" && b?.name === "manage_skill"));
}

/** Compact, bounded rendering of a turn for the distiller. */
export function renderTranscript(slice: Message[], max = 6000): string {
  const parts: string[] = [];
  for (const m of slice) {
    if (typeof m.content === "string") { if (m.content.trim()) parts.push(`${m.role}: ${m.content.trim()}`); continue; }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === "text" && b.text?.trim()) parts.push(`${m.role}: ${b.text.trim()}`);
      else if (b?.type === "tool_use") parts.push(`→ tool ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 200)})`);
      else if (b?.type === "tool_result") { const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content); parts.push(`  result: ${String(t).slice(0, 200)}`); }
    }
  }
  const joined = parts.join("\n");
  return joined.length > max ? joined.slice(0, max / 3) + "\n…[transcript trimmed]…\n" + joined.slice(joined.length - (2 * max) / 3) : joined;
}

export const SKILL_LEARN_PROMPT =
  `You curate a library of reusable SKILLS (procedural memory) for a coding agent. Review the ` +
  `conversation transcript below and decide whether it taught a GENERAL, reusable method worth saving.\n\n` +
  `Prefer, in order:\n` +
  `1. UPDATE an existing related skill (listed below) if the transcript improves/corrects it.\n` +
  `2. CREATE a new skill only for a genuinely new class of task.\n` +
  `3. Otherwise do NOTHING — a pass that saves nothing is fine and common.\n\n` +
  `Do NOT capture: one-off task narratives tied to a specific file/PR/error; transient or ` +
  `environment-specific failures; trivial or widely-known facts; anything an existing skill already covers.\n` +
  `A skill name must be SHORT and GENERIC (a class of task) — never a PR number, an error string, or a ` +
  `"fix-X-today" artifact. The body is markdown: when-to-use, numbered steps, and pitfalls.\n\n` +
  `Respond with ONLY a JSON object, no prose:\n` +
  `{"action":"create"|"update"|"none","name":"<generic-name>","description":"<one line>","body":"<markdown>","reason":"<short>"}`;

/** Build the full distillation prompt (pure — testable). */
export function buildLearnPrompt(slice: Message[], existing: SkillMeta[]): string {
  const skillList = existing.length ? existing.map((s) => `- ${s.name}: ${s.description}`).join("\n") : "(none yet)";
  return `${SKILL_LEARN_PROMPT}\n\nExisting skills:\n${skillList}\n\nTranscript:\n${renderTranscript(slice)}`;
}

/** Extract a LearnDecision from a model reply (tolerates code fences / surrounding prose). null on failure. */
export function parseLearnDecision(raw: string): LearnDecision | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: any;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  const action = obj?.action;
  if (action !== "create" && action !== "update" && action !== "none") return null;
  return { action, name: obj.name, description: obj.description, body: obj.body, reason: obj.reason };
}

/** Distil the just-finished turn into a skill when warranted. Never throws — learning must not break a
 *  turn. Returns what it did so the caller can surface a visible line. */
export async function maybeLearnSkill(opts: {
  cwd: string;
  slice: Message[];
  existing: SkillMeta[];
  ask: (prompt: string) => Promise<string>;
  minToolCalls?: number;
}): Promise<LearnOutcome> {
  if (countToolCalls(opts.slice) < (opts.minToolCalls ?? MIN_TOOL_CALLS)) return { action: "none", reason: "trivial turn" };
  if (alreadyManagedSkill(opts.slice)) return { action: "none", reason: "turn already managed a skill" };

  let raw: string;
  try { raw = await opts.ask(buildLearnPrompt(opts.slice, opts.existing)); } catch { return { action: "none", reason: "brain error" }; }
  const d = parseLearnDecision(raw);
  if (!d || d.action === "none") return { action: "none", reason: d?.reason ?? "no decision" };
  if (!d.name || !d.body) return { action: "none", reason: "incomplete decision" };

  // Both create and update go through writeSkill (full body) → it enforces provenance/collision: it
  // overwrites a matching learned skill (update) and refuses to shadow a shipped/user one.
  const description = d.description ?? (opts.existing.find((s) => s.name === d.name)?.description ?? "");
  const r = writeSkill(opts.cwd, { name: d.name, description, body: d.body });
  if (!r.ok) return { action: "none", reason: r.error };
  return { action: r.created ? "create" : "update", name: d.name, reason: d.reason };
}
