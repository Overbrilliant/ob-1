// Deterministic test for LLM-managed memory evolution (PLAN-V2 #4). No API key — the LLM is injected.
// Covers the pure decision layer (parse + validate + fail-safe) and the store integration (ADD / UPDATE
// = merge-in-place / DELETE = supersede-contradicted / NOOP = drop-duplicate), importance scoring,
// immutable-revision preservation, and the two safeguards (hallucinated id → ADD, parse failure → ADD).
// Usage: bun run scripts/memory-evolve-smoke.ts
import { parseEvolveDecision, decideEvolution, clampImportance, buildEvolvePrompt, MAX_LINKS } from "../src/memory/evolve.ts";
import { MemoryStore, type MemoryBrain } from "../src/memory/store.ts";
import { makeEmbedder } from "../src/memory/embed.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

// ── pure decision layer ──
const ids = new Set([1, 5, 9]);
check("clampImportance clamps + defaults", clampImportance(99) === 10 && clampImportance(0) === 1 && clampImportance("x") === 5);
check("parses an ADD", parseEvolveDecision('{"event":"ADD","importance":7}', ids, "f").event === "ADD");
{
  const d = parseEvolveDecision('{"event":"UPDATE","id":5,"text":"merged","importance":8}', ids, "f");
  check("parses UPDATE with valid id + merged text", d.event === "UPDATE" && d.id === 5 && d.text === "merged" && d.importance === 8);
}
check("DELETE with valid id", parseEvolveDecision('{"event":"DELETE","id":9}', ids, "f").event === "DELETE");
check("NONE maps to NOOP", parseEvolveDecision('{"event":"NONE","id":1}', ids, "f").event === "NOOP");
check("tolerates code fences + prose", parseEvolveDecision('sure:\n```json\n{"event":"ADD","importance":3}\n```', ids, "f").event === "ADD");
// safeguards
check("SAFEGUARD hallucinated id (not in set) → ADD", parseEvolveDecision('{"event":"UPDATE","id":42,"text":"x"}', ids, "f").event === "ADD");
check("SAFEGUARD missing id on UPDATE → ADD", parseEvolveDecision('{"event":"DELETE"}', ids, "f").event === "ADD");
check("SAFEGUARD unparseable → ADD", parseEvolveDecision("the model rambled with no json", ids, "f").event === "ADD");
check("UPDATE with blank text falls back to the new fact", parseEvolveDecision('{"event":"UPDATE","id":1,"text":"  "}', ids, "newfact").text === "newfact");
check("buildEvolvePrompt lists neighbor ids + the new fact", (() => { const p = buildEvolvePrompt("brand new", [{ id: 5, fact: "old" }]); return p.includes("5:") && p.includes("brand new") && p.includes("do NOT invent"); })());

// ── auto-linking (#7): validate, dedup, cap, drop bad rels/ids ──
{
  const d = parseEvolveDecision('{"event":"ADD","importance":5,"links":[{"id":5,"rel":"refines"},{"id":1,"rel":"related_to"}]}', ids, "f");
  check("parses valid links with their relations", d.links.length === 2 && d.links[0].rel === "refines" && d.links[0].targetId === 5);
}
check("links to unknown ids are dropped", parseEvolveDecision('{"event":"ADD","links":[{"id":777,"rel":"related_to"}]}', ids, "f").links.length === 0);
check("links with a bad relation label are dropped", parseEvolveDecision('{"event":"ADD","links":[{"id":1,"rel":"frobnicates"}]}', ids, "f").links.length === 0);
check("duplicate link targets are deduped", parseEvolveDecision('{"event":"ADD","links":[{"id":1,"rel":"related_to"},{"id":1,"rel":"refines"}]}', ids, "f").links.length === 1);
{
  const many = '{"event":"ADD","links":[{"id":1,"rel":"related_to"},{"id":5,"rel":"related_to"},{"id":9,"rel":"related_to"},{"id":1,"rel":"refines"}]}';
  const d = parseEvolveDecision(many, new Set([1, 5, 9]), "f");
  check(`links are capped at MAX_LINKS (${MAX_LINKS})`, d.links.length === MAX_LINKS && d.linksRequested === 4);
}
// decideEvolution short-circuits with no neighbors
check("no neighbors → trivial ADD (no ask call)", (await decideEvolution("x", [], async () => { throw new Error("should not be called"); })).event === "ADD");

// ── store integration: a fake brain returns a scripted decision per new fact ──
const mkStore = (decide: (fact: string) => string): { store: MemoryStore; notes: string[] } => {
  const notes: string[] = [];
  const brain: MemoryBrain = { ask: async (prompt) => decide(prompt), evolve: true, onNote: (s) => notes.push(s) };
  return { store: new MemoryStore(":memory:", makeEmbedder(), brain), notes };
};

// scored-importance ADD (with neighbors) then NOOP (duplicate)
{
  const { store, notes } = mkStore((p) => p.includes("dup of auth") ? '{"event":"NOOP","id":1,"importance":5}' : '{"event":"ADD","importance":6}');
  const a = await store.remember("auth uses JWT tokens"); // first fact: no neighbors → trivial ADD, default importance 5
  check("first fact (no neighbors) gets default importance", store.listFacts()[0].importance === 5);
  const c = await store.remember("the build system uses Bun"); // neighbors exist → model ADDs with importance 6
  check("evolving ADD scored importance via the model", store.listFacts().find((f) => f.id === c)?.importance === 6);
  const b = await store.remember("dup of auth — JWT again"); // → NOOP against #1
  check("NOOP dropped the duplicate (no new fact)", store.listFacts().length === 2 && b === a);
  check("NOOP surfaced a visible note", notes.some((n) => n.includes("duplicate of #" + a)));
  store.close();
}
// UPDATE merges in place (same id, new text, revision recorded)
{
  const { store, notes } = mkStore((p) => p.includes("now also refreshes") ? '{"event":"UPDATE","id":1,"text":"auth uses JWT and refresh tokens","importance":9}' : '{"event":"ADD","importance":4}');
  const a = await store.remember("auth uses JWT");
  const b = await store.remember("auth now also refreshes tokens");
  check("UPDATE kept the same id (merge in place)", b === a && store.listFacts().length === 1);
  check("UPDATE rewrote the text + importance", store.listFacts()[0].fact.includes("refresh") && store.listFacts()[0].importance === 9);
  check("UPDATE recorded an immutable revision (created + updated)", store.revisions(a).map((r) => r.op).join(",") === "created,updated");
  check("UPDATE surfaced a 'merged into' note", notes.some((n) => n.includes("merged into #" + a)));
  store.close();
}
// DELETE supersedes a contradicted fact (old archived + revision kept, new added)
{
  const { store, notes } = mkStore((p) => p.includes("python") ? '{"event":"DELETE","id":1,"importance":7}' : '{"event":"ADD","importance":5}');
  const a = await store.remember("the project is written in TypeScript");
  const b = await store.remember("correction: the project is written in python");
  check("DELETE archived the contradicted fact", store.listFacts().find((f) => f.id === a) === undefined);
  check("DELETE added the new (superseding) fact", store.listFacts().some((f) => f.id === b && f.fact.includes("python")));
  check("contradicted fact is recoverable (archived, not hard-deleted)", store.listFacts(true).some((f) => f.id === a) && store.revisions(a).some((r) => r.op === "deleted"));
  check("DELETE surfaced a 'superseded' note", notes.some((n) => n.includes("superseded #" + a)));
  store.close();
}
// fail-safe: ask throws → fact still ADDed
{
  const notes: string[] = [];
  const brain: MemoryBrain = { ask: async () => { throw new Error("model down"); }, evolve: true, onNote: (s) => notes.push(s) };
  const store = new MemoryStore(":memory:", makeEmbedder(), brain);
  const a = await store.remember("important fact during an outage");
  check("ask failure still stores the fact (never lose info)", store.listFacts().length === 1 && a > 0);
  store.close();
}
// auto-linking through a real store: the evolve call's links become idempotent fact↔fact edges
{
  const notes: string[] = [];
  // First two facts seed neighbors; the third ADDs and links to #1 (related_to) + #2 (refines).
  const brain: MemoryBrain = {
    ask: async (p) => p.includes("login flow ties together")
      ? '{"event":"ADD","importance":7,"links":[{"id":1,"rel":"related_to"},{"id":2,"rel":"refines"}]}'
      : '{"event":"ADD","importance":5}',
    evolve: true, autolink: true, onNote: (s) => notes.push(s),
  };
  const store = new MemoryStore(":memory:", makeEmbedder(), brain);
  const a = await store.remember("auth issues JWT tokens");
  const b = await store.remember("sessions expire after one hour");
  const c = await store.remember("the login flow ties together auth and sessions");
  check("auto-link created the proposed fact↔fact edges", store.factLinks(c).length === 2);
  check("auto-link kept the relation labels", store.factLinks(c).some((l) => l.dst === a && l.rel === "related_to") && store.factLinks(c).some((l) => l.dst === b && l.rel === "refines"));
  check("auto-link is idempotent (re-link is a no-op)", store.linkFacts(c, a, "related_to") === false);
  check("no self-links", store.linkFacts(c, c, "related_to") === false);
  check("auto-link surfaced a visible 🔗 note", notes.some((n) => n.includes("linked #" + c)));
  store.close();
}

// evolve OFF → plain append (no ask call), and live toggle works
{
  const brain: MemoryBrain = { ask: async () => { throw new Error("should not run when off"); }, evolve: false };
  const store = new MemoryStore(":memory:", makeEmbedder(), brain);
  await store.remember("a"); await store.remember("a"); // identical, but no evolution → both append
  check("evolve OFF appends without calling the brain", store.listFacts().length === 2 && !store.evolveOn);
  store.setMemoryFlags({ evolve: true });
  check("setMemoryFlags flips evolution on", store.evolveOn);
  store.close();
}

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
