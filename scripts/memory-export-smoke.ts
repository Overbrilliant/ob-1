// Deterministic test for the memory graph export (/memory export [dot|html]). No API key / no UI.
// Verifies: DOT structure + escaping + dashed/grey invalidated edges; self-contained HTML (no external
// resources) with dashed+dimmed expired edges; bi-temporal honesty (invalidated edges rendered, never
// dropped); deterministic output; and the real store path (listEntities + listRelationships(true)).
// Usage: bun run scripts/memory-export-smoke.ts
import { toDot, toHtml, exportGraph } from "../src/memory/export.ts";
import { MemoryStore } from "../src/memory/store.ts";
import type { Entity, Relationship } from "../src/memory/store.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

const entities: Entity[] = [
  { id: 1, name: "auth.ts", kind: "module", summary: null, created_at: "t" },
  { id: 2, name: 'we"ird', kind: null, summary: null, created_at: "t" }, // a quote → must be escaped
  { id: 3, name: "session", kind: "concept", summary: null, created_at: "t" },
];
const rels: Relationship[] = [
  { id: 1, src: "auth.ts", rel: "creates", dst: "session", valid_from: "t", valid_to: null, invalidated: 0, created_at: "t" },
  { id: 2, src: 'we"ird', rel: "depends_on", dst: "auth.ts", valid_from: "t", valid_to: "t2", invalidated: 1, created_at: "t" }, // expired
];

// ── DOT ──
const dot = toDot(entities, rels);
check("DOT wraps in a digraph", dot.startsWith("digraph memory {") && dot.trimEnd().endsWith("}"));
check("DOT emits a node per entity", dot.includes('"auth.ts"') && dot.includes('"session"'));
check("DOT escapes a double-quote in a name", dot.includes('we\\"ird'));
check("DOT renders the active edge with its label", dot.includes('"auth.ts" -> "session" [label="creates"]'));
check("DOT renders the invalidated edge dashed + grey (not dropped)", /depends_on".*style=dashed.*grey60/.test(dot));

// ── HTML ──
const html = toHtml(entities, rels);
check("HTML is a complete document", html.startsWith("<!doctype html>") && html.includes("</html>"));
check("HTML is self-contained (no external src=/http resource)", !/\bsrc=/.test(html) && !/https?:\/\//.test(html.replace('xmlns="http://www.w3.org/2000/svg"', "")));
check("HTML embeds an inline SVG with an arrow marker", html.includes("<svg ") && html.includes('<marker id="arr"'));
check("HTML escapes the quote in the entity name", html.includes("we&quot;ird") && !html.includes('we"ird'));
check("HTML draws the active edge solid (no dasharray)", /creates<\/text>/.test(html));
check("HTML draws the expired edge dashed + dimmed", /stroke-dasharray="6,4"[^>]*opacity="0.5"/.test(html));
check("HTML header shows the counts", html.includes("3 entities") && html.includes("2 relationships"));
check("HTML output is deterministic (stable layout)", toHtml(entities, rels) === html);

// ── exportGraph dispatch ──
check("exportGraph('dot') == toDot", exportGraph("dot", entities, rels) === dot);
check("exportGraph('html') == toHtml", exportGraph("html", entities, rels) === html);

// ── real store path (listEntities + listRelationships(true) feed the exporter) ──
{
  const store = new MemoryStore(":memory:");
  const eid = store.addRelationship("alpha", "calls", "beta");
  store.addRelationship("beta", "uses", "gamma");
  store.invalidateRelationship(eid); // expire the first edge
  const allEdges = store.listRelationships(true);
  check("store exposes listEntities (3 endpoints)", store.listEntities().map((e) => e.name).sort().join(",") === "alpha,beta,gamma");
  check("export includes the invalidated edge when given listRelationships(true)", allEdges.length === 2);
  const d = exportGraph("dot", store.listEntities(), allEdges);
  check("real-store DOT marks the expired edge dashed", /alpha" -> "beta".*style=dashed/.test(d));
  check("real-store DOT keeps the active edge solid", d.includes('"beta" -> "gamma" [label="uses"]'));
  store.close();
}

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
