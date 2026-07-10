// Reflection / consolidation trees — PLAN-V2 item #6.
//
// The Stanford "Generative Agents" reflection mechanism: when the agent accumulates enough salient
// memories, it pauses to distill them into higher-level INSIGHTS (reflections) that are themselves
// stored as retrievable memories, each linked to the source facts it generalizes from. Reflections can
// cite other reflections → a tree (leaves = raw facts, higher nodes = more abstract), bounded by depth.
//
// Verified against Park et al. 2023 §4.2:
//   • Trigger: a running sum of importance over facts since the last reflection crosses a threshold
//     (the paper used 150 on a 1–10 scale ≈ 15–30 facts); fire, then reset the accumulator.
//   • Distill: feed the recent window, ask for a few high-level insights, each citing source ids
//     `(because of <id>, <id>)`; drop any insight that cites no valid source (anti-hallucination).
//   • Bound: cap reflection depth so reflections-of-reflections can't recurse forever.
// Source: arxiv 2304.03442 §4.2 "Reflection".
import { clampImportance } from "./evolve.ts";

export const REFLECTION_THRESHOLD = 150; // Σ importance (1–10) since last reflection — the paper's value
export const REFLECTION_WINDOW = 100;    // most-recent facts fed to the distiller
export const MAX_REFLECTION_DEPTH = 3;   // don't generalize over reflections deeper than this (loop guard)
export const MAX_REFLECTIONS = 5;        // emit at most N insights per fire

export interface SourceFact { id: number; fact: string; reflection_level: number }
export interface ReflectionInsight { text: string; sourceIds: number[]; importance: number }

export function buildReflectPrompt(facts: SourceFact[]): string {
  const list = facts.map((f) => `${f.id}: ${JSON.stringify(f.fact)}`).join("\n");
  return [
    "You consolidate an AI agent's recent memories into a few HIGHER-LEVEL insights (reflections) —",
    "generalizations, patterns, or conclusions that synthesize MULTIPLE memories below.",
    "",
    `Recent memories (id: text):\n${list}`,
    "",
    `Produce up to ${MAX_REFLECTIONS} reflections. Each MUST synthesize at least two memories and cite the ids it draws from.`,
    "Rate each reflection's importance 1-10. If nothing is worth generalizing, return an empty array.",
    "",
    "Respond with ONLY this JSON array (no prose, no code fence):",
    '[{"insight":"<a higher-level statement>","sources":[<id>,<id>],"importance":<1-10>}]',
  ].join("\n");
}

function extractJsonArray(raw: string): any[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array");
  const arr = JSON.parse(body.slice(start, end + 1));
  return Array.isArray(arr) ? arr : [];
}

/** Parse insights; keep only those that cite ≥1 VALID source id (drop ungrounded reflections). */
export function parseReflections(raw: string, validIds: Set<number>): ReflectionInsight[] {
  let arr: any[];
  try { arr = extractJsonArray(raw); } catch { return []; }
  const out: ReflectionInsight[] = [];
  for (const o of arr) {
    const text = typeof o?.insight === "string" ? o.insight.trim() : "";
    const sourceIds: number[] = Array.isArray(o?.sources)
      ? o.sources.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && validIds.has(n))
      : [];
    if (!text || sourceIds.length === 0) continue; // ungrounded → drop
    out.push({ text, sourceIds: [...new Set(sourceIds)], importance: clampImportance(o?.importance) });
    if (out.length >= MAX_REFLECTIONS) break;
  }
  return out;
}

/** True when accumulated importance has crossed the reflection threshold. */
export function shouldReflect(accumulatedImportance: number): boolean {
  return accumulatedImportance >= REFLECTION_THRESHOLD;
}
