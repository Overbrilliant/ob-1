// Structured claim / report schema (parity with claw-code's report_schema).
//
// Anti-hallucination grounding: an agent's findings are not all equal — an OBSERVED FACT (read from a
// file, seen in command output) is trustworthy; an INFERENCE is derived; a HYPOTHESIS is a guess; a
// RECOMMENDATION is an action proposal. Typing each claim lets us project a grounded view (e.g. "facts
// only"), dedupe identical claims across agents by content hash, and flag when a report is mostly
// speculation. Pure + dependency-free (hash via node:crypto, a Bun built-in).
import { createHash } from "node:crypto";

export type ClaimKind = "observed_fact" | "inference" | "hypothesis" | "recommendation";

/** Trust ordering, most-grounded first. Used for default projection order + the "speculative" check. */
export const CLAIM_ORDER: ClaimKind[] = ["observed_fact", "inference", "hypothesis", "recommendation"];

export const CLAIM_LABEL: Record<ClaimKind, string> = {
  observed_fact: "Observed facts",
  inference: "Inferences",
  hypothesis: "Hypotheses",
  recommendation: "Recommendations",
};

export interface Claim {
  kind: ClaimKind;
  text: string;
  evidence?: string; // optional source (file:line, command, url) backing an observed_fact
  hash: string;      // 12-hex content fingerprint (kind + normalized text) for dedupe
}

export const REPORT_SCHEMA_V1 = "ob1.report.v1";
export interface Report {
  schema: string;
  createdAt?: string; // ISO; stamped by the caller (keeps this module Date-free / testable)
  claims: Claim[];
}

/** Stable content fingerprint: SHA-256 of "kind:normalized-text", first 12 hex chars. Identical claims
 *  (case/whitespace-insensitive) from different agents collapse to one. */
export function hashClaim(kind: ClaimKind, text: string): string {
  const norm = `${kind}:${text.trim().replace(/\s+/g, " ").toLowerCase()}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

export function makeClaim(kind: ClaimKind, text: string, evidence?: string): Claim {
  const t = text.trim();
  return { kind, text: t, evidence: evidence?.trim() || undefined, hash: hashClaim(kind, t) };
}

// Tag aliases the model may write inline, mapped to a kind. Case-insensitive; bracketed at line start.
const TAG_TO_KIND: Record<string, ClaimKind> = {
  fact: "observed_fact", observed: "observed_fact", observed_fact: "observed_fact",
  inference: "inference", infer: "inference", derived: "inference",
  hypothesis: "hypothesis", hyp: "hypothesis", guess: "hypothesis", maybe: "hypothesis",
  recommendation: "recommendation", rec: "recommendation", recommend: "recommendation", action: "recommendation",
};

/** Parse claims from text the model tagged inline, e.g.
 *    [FACT] config.ts:158 hardcodes api.ob1.dev (evidence: config.ts:158)
 *    [HYPOTHESIS] the flake is timing-related
 *  Lines without a recognized tag are ignored. Optional trailing "(evidence: …)" backs the claim. */
export function parseTaggedClaims(text: string): Claim[] {
  const out: Claim[] = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    const m = rawLine.match(/^\s*[-*]?\s*\[([A-Za-z_]+)\]\s*(.+?)\s*$/);
    if (!m) continue;
    const kind = TAG_TO_KIND[m[1].toLowerCase()];
    if (!kind) continue;
    let body = m[2];
    let evidence: string | undefined;
    const ev = body.match(/\(evidence:\s*([^)]+)\)\s*$/i);
    if (ev) { evidence = ev[1].trim(); body = body.slice(0, ev.index).trim(); }
    if (body) out.push(makeClaim(kind, body, evidence));
  }
  return out;
}

/** Dedupe claims by content hash, keeping the FIRST occurrence (which may carry evidence). */
export function dedupeClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const c of claims) { if (!seen.has(c.hash)) { seen.add(c.hash); out.push(c); } }
  return out;
}

export interface ProjectionPolicy {
  include?: ClaimKind[]; // which kinds to keep (default: all)
  order?: ClaimKind[];   // render order (default: CLAIM_ORDER)
  dedupe?: boolean;      // collapse identical claims (default: true)
  max?: number;          // cap total claims (default: unlimited)
}

/** Apply a projection policy: filter by kind, dedupe, order by trust, cap. The grounded "view" of a report. */
export function projectClaims(claims: Claim[], policy: ProjectionPolicy = {}): Claim[] {
  const include = new Set(policy.include ?? CLAIM_ORDER);
  const order = policy.order ?? CLAIM_ORDER;
  let list = claims.filter((c) => include.has(c.kind));
  if (policy.dedupe !== false) list = dedupeClaims(list);
  list = list.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (policy.max != null) list = list.slice(0, policy.max);
  return list;
}

/** Build a report from raw claims (deduped). `createdAt` is passed in to keep the module Date-free. */
export function buildReport(claims: Claim[], createdAt?: string): Report {
  return { schema: REPORT_SCHEMA_V1, createdAt, claims: dedupeClaims(claims) };
}

export interface ReportStats { total: number; byKind: Record<ClaimKind, number>; grounded: number; speculative: number }
/** Count claims by kind. `grounded` = observed facts; `speculative` = hypotheses (a high ratio is a
 *  signal the report rests on guesses rather than evidence). */
export function reportStats(report: Report): ReportStats {
  const byKind: Record<ClaimKind, number> = { observed_fact: 0, inference: 0, hypothesis: 0, recommendation: 0 };
  for (const c of report.claims) byKind[c.kind]++;
  return { total: report.claims.length, byKind, grounded: byKind.observed_fact, speculative: byKind.hypothesis };
}

/** Render a report as grouped markdown (the grounded view). Empty string when there are no claims. */
export function renderReport(report: Report, policy: ProjectionPolicy = {}): string {
  const claims = projectClaims(report.claims, policy);
  if (!claims.length) return "";
  const order = policy.order ?? CLAIM_ORDER;
  const lines: string[] = [];
  for (const kind of order) {
    const group = claims.filter((c) => c.kind === kind);
    if (!group.length) continue;
    lines.push(`**${CLAIM_LABEL[kind]}**`);
    for (const c of group) lines.push(`- ${c.text}${c.evidence ? `  _(evidence: ${c.evidence})_` : ""}`);
  }
  return lines.join("\n");
}
