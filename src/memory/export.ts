// Relationship-graph export — the `/memory export [dot|html]` feature (PLAN-V2 item #8).
//
// The `/memory` viewer prints the graph in the terminal; this writes it out for real visualization.
// From a web survey of export formats:
//   • DOT (Graphviz) is the zero-dependency, human-readable text format — any Graphviz install or
//     online viewer renders it; we just emit a string. The default.
//   • HTML must be FULLY self-contained (no external `src=`, opens offline from file://). Rather than
//     vendor a ~250KB graph library, we emit a small inline SVG with a deterministic circular layout —
//     zero-dependency, offline, and deterministic (so the smoke can assert exact output).
//   • Bi-temporal honesty: invalidated/expired edges are rendered DASHED + dimmed, never dropped, in
//     both formats — same semantics as the store keeps them.
// Sources: graphviz.org/docs/edges · visjs.github.io/vis-network (standalone build).
import type { Entity, Relationship } from "./store.ts";

export type ExportFormat = "dot" | "html";

/** Quote + escape a string for a DOT id/label (backslash and double-quote are the special chars). */
function dq(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

/** Graphviz DOT. Active edges solid; invalidated edges dashed + grey (bi-temporal, never dropped). */
export function toDot(entities: Entity[], relationships: Relationship[]): string {
  const lines = ["digraph memory {", "  rankdir=LR;", "  node [shape=box, style=rounded, fontname=\"sans-serif\"];", "  edge [fontname=\"sans-serif\", fontsize=10];"];
  for (const e of entities) {
    const label = e.kind ? `${e.name}\n(${e.kind})` : e.name;
    lines.push(`  ${dq(e.name)} [label=${dq(label)}];`);
  }
  for (const r of relationships) {
    const attrs = [`label=${dq(r.rel)}`];
    if (r.invalidated) attrs.push("style=dashed", 'color="grey60"', 'fontcolor="grey60"');
    lines.push(`  ${dq(r.src)} -> ${dq(r.dst)} [${attrs.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const r2 = (n: number): number => Math.round(n * 100) / 100; // stable 2-dp coords → deterministic output

/** Self-contained HTML: inline SVG, deterministic circular layout, no external resources.
 *  Invalidated edges are dashed + half-opacity (visible but demoted), matching the DOT export. */
export function toHtml(entities: Entity[], relationships: Relationship[]): string {
  const nodes = entities.map((e) => e.name);
  const n = Math.max(nodes.length, 1);
  const W = 900, H = 640, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 90;
  const pos = new Map<string, [number, number]>();
  nodes.forEach((name, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    pos.set(name, [r2(cx + R * Math.cos(a)), r2(cy + R * Math.sin(a))]);
  });

  const edgeSvg = relationships.map((rel) => {
    const p = pos.get(rel.src), q = pos.get(rel.dst);
    if (!p || !q) return "";
    const mx = r2((p[0] + q[0]) / 2), my = r2((p[1] + q[1]) / 2);
    const stroke = rel.invalidated ? "#999999" : "#4a90d9";
    const dash = rel.invalidated ? ' stroke-dasharray="6,4"' : "";
    const op = rel.invalidated ? ' opacity="0.5"' : "";
    return `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${stroke}" stroke-width="1.5"${dash}${op} marker-end="url(#arr)"/>` +
      `<text x="${mx}" y="${my}" fill="${stroke}" font-size="11" text-anchor="middle"${op}>${esc(rel.rel)}</text>`;
  }).join("\n");

  const nodeSvg = nodes.map((name) => {
    const [x, y] = pos.get(name)!;
    return `<circle cx="${x}" cy="${y}" r="7" fill="#1d3557"/>` +
      `<text x="${x}" y="${y - 13}" font-size="13" font-weight="600" text-anchor="middle" fill="#1d3557">${esc(name)}</text>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OB-1 memory graph</title>
<style>body{margin:0;background:#fafafa;font-family:sans-serif}h1{font-size:15px;color:#444;padding:10px 16px;margin:0}
.legend{padding:0 16px 8px;font-size:12px;color:#666}.legend b{color:#4a90d9}.legend i{color:#999}</style></head>
<body>
<h1>OB-1 memory graph — ${entities.length} entities · ${relationships.length} relationships</h1>
<div class="legend"><b>— active</b> &nbsp; <i>- - expired (invalidated)</i></div>
<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:90vh" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="arr" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="#888"/></marker></defs>
${edgeSvg}
${nodeSvg}
</svg>
</body></html>`;
}

export function exportGraph(format: ExportFormat, entities: Entity[], relationships: Relationship[]): string {
  return format === "html" ? toHtml(entities, relationships) : toDot(entities, relationships);
}
