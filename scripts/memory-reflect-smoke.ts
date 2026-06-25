// Deterministic test for reflection trees (PLAN-V2 #6). No API key — the LLM is injected.
// Covers the pure layer (prompt, threshold, parse + grounding filter) and the store integration:
// the importance accumulator trips at the threshold, distils recent facts into reflection facts linked
// to their sources (derived_from), the depth cap bounds reflection-of-reflection, and reflections don't
// re-trigger themselves. Usage: bun run scripts/memory-reflect-smoke.ts
import { buildReflectPrompt, parseReflections, shouldReflect, REFLECTION_THRESHOLD, MAX_REFLECTION_DEPTH, type SourceFact } from "../src/memory/reflect.ts";
import { MemoryStore, type MemoryBrain } from "../src/memory/store.ts";
import { makeEmbedder } from "../src/memory/embed.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

// ── pure layer ──
check("shouldReflect trips at the threshold", !shouldReflect(REFLECTION_THRESHOLD - 1) && shouldReflect(REFLECTION_THRESHOLD));
const facts: SourceFact[] = [{ id: 1, fact: "uses JWT", reflection_level: 0 }, { id: 2, fact: "tokens expire in 1h", reflection_level: 0 }];
check("buildReflectPrompt lists ids + asks for cited JSON", (() => { const p = buildReflectPrompt(facts); return p.includes("1:") && p.includes("sources") && p.includes("importance"); })());
const valid = new Set([1, 2, 3]);
check("parses grounded insights", parseReflections('[{"insight":"auth is short-lived JWT","sources":[1,2],"importance":7}]', valid).length === 1);
check("DROPS an insight citing no valid source (ungrounded)", parseReflections('[{"insight":"hallucinated","sources":[99],"importance":9}]', valid).length === 0);
check("DROPS an insight with no sources", parseReflections('[{"insight":"x","sources":[],"importance":5}]', valid).length === 0);
check("dedups + clamps", (() => { const r = parseReflections('[{"insight":"y","sources":[1,1,2],"importance":50}]', valid)[0]; return r.sourceIds.length === 2 && r.importance === 10; })());
check("tolerates fences + empty array", parseReflections("```json\n[]\n```", valid).length === 0 && parseReflections("no json here", valid).length === 0);

// ── store integration ──
const REFLECT_JSON = '[{"insight":"the auth system is short-lived JWT-based","sources":[1,2],"importance":6}]';
const mk = (reflectReply: string) => {
  const notes: string[] = [];
  let askCalls = 0;
  const brain: MemoryBrain = {
    ask: async (p) => { askCalls++; return p.includes("HIGHER-LEVEL") ? reflectReply : '{"event":"ADD","importance":10}'; },
    reflect: true, onNote: (s) => notes.push(s),
  };
  return { store: new MemoryStore(":memory:", makeEmbedder(), brain), notes, calls: () => askCalls };
};

{
  const { store, notes } = mk(REFLECT_JSON);
  // Remember facts with importance 10 each (no evolve, so importance arg is honored) until the threshold trips.
  const need = Math.ceil(REFLECTION_THRESHOLD / 10); // 15 facts × 10 = 150
  for (let i = 0; i < need - 1; i++) await store.remember(`fact number ${i} about the system`, "project", 10);
  check("no reflection before the threshold", store.listFacts().every((f) => f.kind !== "reflection"));
  await store.remember("the final fact crossing the threshold", "project", 10); // trips it
  const reflections = store.listFacts().filter((f) => f.kind === "reflection");
  check("a reflection fact is created when the threshold trips", reflections.length === 1, `${reflections.length}`);
  check("reflection links to its source facts (derived_from)", store.reflectionSources(reflections[0].id).join(",") === "1,2");
  check("reflection sits one level above its sources", reflections[0].reflection_level === 1);
  check("reflection surfaced a visible note", notes.some((n) => n.includes("reflected")));
  await store.remember("one more small fact afterwards", "project", 10); // accumulator reset → no immediate re-reflect
  check("the accumulator reset (one more fact doesn't immediately re-reflect)", store.listFacts().filter((f) => f.kind === "reflection").length === 1);
  store.close();
}

// depth cap: a reflection over level-(MAX-1) sources caps at MAX, never exceeds it
{
  const { store } = mk('[{"insight":"top-level synthesis","sources":[1],"importance":5}]');
  // seed one fact, then manually add near-cap reflections to confirm the level math + window filter.
  const a = store.addFact("base fact", "project", 5);
  const r1 = store.addFact("mid reflection", "project", 5, { kind: "reflection", level: MAX_REFLECTION_DEPTH - 1 });
  const atCap = store.addFact("capped reflection", "project", 5, { kind: "reflection", level: MAX_REFLECTION_DEPTH });
  // Only facts with level < MAX are eligible sources; force a reflect and check it doesn't exceed the cap.
  const made = await store.reflect();
  const top = store.listFacts().filter((f) => f.kind === "reflection" && f.reflection_level === MAX_REFLECTION_DEPTH);
  check("manual reflect produced a capped-level reflection", made >= 1 && top.length >= 1);
  check("no reflection ever exceeds MAX_REFLECTION_DEPTH", store.listFacts().every((f) => f.reflection_level <= MAX_REFLECTION_DEPTH));
  store.close();
}

// reflect OFF → never fires even past the threshold
{
  const brain: MemoryBrain = { ask: async () => { throw new Error("should not reflect when off"); }, reflect: false };
  const store = new MemoryStore(":memory:", makeEmbedder(), brain);
  for (let i = 0; i < 20; i++) await store.remember(`fact ${i}`, "project", 10);
  check("reflect OFF never distils", store.listFacts().every((f) => f.kind !== "reflection") && !store.reflectOn);
  store.close();
}

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
