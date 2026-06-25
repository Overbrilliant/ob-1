// LLM-managed memory evolution — PLAN-V2 item #4.
//
// Until now `remember()` only APPENDED, so facts accreted forever → the context-rot the whole research
// thesis warns against. This adds the Mem0 / Vertex "Memory Bank" consolidation pattern: on each new
// fact, retrieve the nearest same-scope existing memories and ask a cheap LLM to decide ONE operation:
//   • ADD    — genuinely new info → store as-is.
//   • UPDATE — refines/merges with one existing memory → rewrite that memory in place (same id).
//   • DELETE — CONTRADICTS one existing memory → supersede it (archive old, add the new).
//   • NOOP   — already covered (a duplicate) → drop the new fact.
// It also rates the resulting fact's importance 1–10 (feeds weighted retrieval, item #5).
//
// Two safeguards the published systems LACK, added here for the "never hard-lose info" invariant
// (web research):
//   1. id post-validation — an UPDATE/DELETE/NOOP whose id isn't in the retrieved set is coerced to ADD
//      (kills the "model invented an id" failure);
//   2. ADD on any parse failure — a malformed decision never drops the fact.
// The store keeps immutable revisions, so even an erroneous UPDATE/DELETE is recoverable.
// Sources: Mem0 (arxiv 2504.19413, prompts.py) · Vertex AI Memory Bank generate-memories.
import { DEFAULT_IMPORTANCE } from "./rank.ts";

export type Ask = (prompt: string) => Promise<string>;
export interface Neighbor { id: number; fact: string }
export type EvolveEvent = "ADD" | "UPDATE" | "DELETE" | "NOOP";

// Auto-linking (item #7, A-Mem): a small CLOSED vocabulary keeps edges queryable — a bare "related"
// firehose degrades to noise. `related_to` = same topic; `refines` = this sharpens the neighbor;
// `contradicts` = conflicts (high-value).
export type LinkRel = "related_to" | "refines" | "contradicts";
export const LINK_RELS: LinkRel[] = ["related_to", "refines", "contradicts"];
export interface LinkProposal { targetId: number; rel: LinkRel }
/** Cap stored links well below the retrieval window so the model must prioritize — the gap between
 *  candidate count (10) and this cap is what prevents a fully-connected graph (A-Mem finding). */
export const MAX_LINKS = 3;

export interface EvolveDecision {
  event: EvolveEvent;
  id?: number;       // the existing memory id for UPDATE/DELETE/NOOP
  text?: string;     // merged text for UPDATE (else the new fact)
  importance: number;// 1–10
  links: LinkProposal[];   // validated + deduped + capped related-memory links (item #7)
  linksRequested: number;  // how many the model proposed (so the store can log the clamp)
}

/** Mem0's s=10: enough to catch dups/contradictions, small enough to keep the decision prompt cheap
 *  and to avoid over-merging (over-retrieval is what causes spurious merges). */
export const EVOLVE_NEIGHBORS = 10;

export function clampImportance(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(10, v)) : DEFAULT_IMPORTANCE;
}

export function buildEvolvePrompt(newFact: string, neighbors: Neighbor[]): string {
  const list = neighbors.map((n) => `${n.id}: ${JSON.stringify(n.fact)}`).join("\n");
  return [
    "You maintain an AI agent's long-term memory. A NEW fact was just observed. Decide how it relates to the EXISTING memories and choose exactly ONE action.",
    "",
    `NEW fact:\n${JSON.stringify(newFact)}`,
    "",
    `EXISTING memories (id: text):\n${list}`,
    "",
    "Actions:",
    "- ADD: the new fact is genuinely new information → store it as-is.",
    "- UPDATE: the new fact refines/merges with ONE existing memory → give that id and the merged text.",
    "- DELETE: the new fact CONTRADICTS one existing memory → give that id (the new fact supersedes it).",
    "- NOOP: the new fact is already fully covered by one existing memory (a duplicate) → give that id.",
    "",
    "Rules:",
    "- For UPDATE/DELETE/NOOP the id MUST be one of the existing ids listed above — do NOT invent an id.",
    "- Map the new fact to AT MOST ONE existing memory.",
    "- Rate the resulting fact's importance 1-10 (1 = mundane, 10 = critical/architectural).",
    `- Optionally list up to ${MAX_LINKS} RELATED existing memories to link the new fact to (most-related first),`,
    '  each with a relation: "related_to" (same topic), "refines" (the new fact sharpens it), "contradicts" (conflicts).',
    "  Link ids must also come from the existing ids above. Omit links if nothing is genuinely related.",
    "",
    'Respond with ONLY this JSON (no prose, no code fence):',
    '{"event":"ADD|UPDATE|DELETE|NOOP","id":<existing id or null>,"text":"<merged text for UPDATE, else the new fact>","importance":<1-10>,"links":[{"id":<existing id>,"rel":"related_to|refines|contradicts"}]}',
  ].join("\n");
}

/** Validate + dedup + cap the model's proposed links to known ids and the closed relation vocabulary. */
function parseLinks(rawLinks: any, validIds: Set<number>): { links: LinkProposal[]; requested: number } {
  const arr = Array.isArray(rawLinks) ? rawLinks : [];
  const links: LinkProposal[] = [];
  const seen = new Set<number>();
  for (const l of arr) {
    const tid = Number(l?.id);
    const rel = String(l?.rel ?? "related_to").toLowerCase();
    if (!Number.isInteger(tid) || !validIds.has(tid) || seen.has(tid)) continue;
    if (!LINK_RELS.includes(rel as LinkRel)) continue;
    seen.add(tid);
    links.push({ targetId: tid, rel: rel as LinkRel });
    if (links.length >= MAX_LINKS) break; // cap; remaining proposals counted as dropped via `requested`
  }
  return { links, requested: arr.length };
}

/** Extract the first JSON object from a model reply (tolerates code fences / surrounding prose). */
function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

/** Parse + VALIDATE a decision. Unknown/contradictory output fails safe to ADD; an UPDATE/DELETE/NOOP
 *  that references an id outside the retrieved set is coerced to ADD (no hallucinated ids). */
export function parseEvolveDecision(raw: string, validIds: Set<number>, newFact: string): EvolveDecision {
  let o: any;
  try { o = extractJson(raw); } catch { return { event: "ADD", importance: DEFAULT_IMPORTANCE, links: [], linksRequested: 0 }; }
  const { links, requested } = parseLinks(o?.links, validIds);
  const base = { importance: clampImportance(o?.importance), links, linksRequested: requested };
  const ev = String(o?.event ?? "").toUpperCase();
  const event: EvolveEvent = ev === "UPDATE" ? "UPDATE" : ev === "DELETE" ? "DELETE" : (ev === "NOOP" || ev === "NONE") ? "NOOP" : "ADD";
  if (event === "ADD") return { event: "ADD", ...base };
  const id = Number(o?.id);
  if (!Number.isInteger(id) || !validIds.has(id)) return { event: "ADD", ...base }; // hallucinated / missing id → ADD
  if (event === "UPDATE") {
    const text = typeof o?.text === "string" && o.text.trim() ? o.text.trim() : newFact;
    return { event: "UPDATE", id, text, ...base };
  }
  return { event, id, ...base }; // DELETE | NOOP
}

/** Ask the model how a new fact should evolve memory. No neighbors ⇒ trivially ADD (nothing to merge). */
export async function decideEvolution(newFact: string, neighbors: Neighbor[], ask: Ask): Promise<EvolveDecision> {
  if (neighbors.length === 0) return { event: "ADD", importance: DEFAULT_IMPORTANCE, links: [], linksRequested: 0 };
  const raw = await ask(buildEvolvePrompt(newFact, neighbors));
  return parseEvolveDecision(raw, new Set(neighbors.map((n) => n.id)), newFact);
}
