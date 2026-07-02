// Deterministic test for the structured claim/report schema (no network).
// Usage: bun run scripts/claims-smoke.ts
import { makeClaim, hashClaim, parseTaggedClaims, dedupeClaims, projectClaims, buildReport, reportStats, renderReport, CLAIM_ORDER } from "../src/agent/claims.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── hashing: stable + normalization-insensitive ───────────────────────────────
const stableHash = hashClaim("observed_fact", "X");
check("hash is stable for identical input", stableHash === hashClaim("observed_fact", "X"));
check("hash ignores case/whitespace", hashClaim("inference", "The  Flake") === hashClaim("inference", "the flake"));
check("hash distinguishes kind", hashClaim("observed_fact", "x") !== hashClaim("hypothesis", "x"));
check("hash is 12 hex chars", /^[0-9a-f]{12}$/.test(hashClaim("inference", "y")));

// ── parsing tagged claims ─────────────────────────────────────────────────────
const text = [
  "[FACT] config.ts:158 hardcodes api.ob1.dev (evidence: config.ts:158)",
  "- [INFERENCE] the footer reads the wrong env var",
  "* [HYPOTHESIS] the flake is timing-related",
  "[REC] add OB1_SERVER to .env",
  "this line has no tag and is ignored",
  "[BOGUS] unknown tag is ignored",
].join("\n");
const claims = parseTaggedClaims(text);
check("parses exactly the 4 recognized tags", claims.length === 4);
check("FACT → observed_fact with evidence parsed", claims[0].kind === "observed_fact" && claims[0].evidence === "config.ts:158" && !claims[0].text.includes("evidence"));
check("list-bullet + tag aliases parse (INFERENCE/HYPOTHESIS/REC)", claims[1].kind === "inference" && claims[2].kind === "hypothesis" && claims[3].kind === "recommendation");
check("untagged + unknown-tag lines are ignored", !claims.some((c) => c.text.includes("no tag") || c.text.includes("unknown tag")));

// ── dedupe by content hash ─────────────────────────────────────────────────────
const dupes = [makeClaim("observed_fact", "same thing"), makeClaim("observed_fact", "SAME THING"), makeClaim("inference", "other")];
check("dedupe collapses case/space-identical claims", dedupeClaims(dupes).length === 2);

// ── projection policy: filter + order + cap ────────────────────────────────────
const mixed = [
  makeClaim("recommendation", "do X"),
  makeClaim("hypothesis", "maybe Y"),
  makeClaim("observed_fact", "saw Z"),
  makeClaim("inference", "thus W"),
];
const ordered = projectClaims(mixed);
check("projection orders by trust (facts first, recs last)", ordered[0].kind === "observed_fact" && ordered[3].kind === "recommendation");
check("projection can filter to facts only", projectClaims(mixed, { include: ["observed_fact"] }).every((c) => c.kind === "observed_fact"));
check("projection respects max", projectClaims(mixed, { max: 2 }).length === 2);

// ── report stats ───────────────────────────────────────────────────────────────
const report = buildReport([...mixed, makeClaim("hypothesis", "maybe Y")]); // last is a dupe
const stats = reportStats(report);
check("buildReport dedupes", report.claims.length === 4);
check("stats count grounded (facts) vs speculative (hypotheses)", stats.grounded === 1 && stats.speculative === 1 && stats.total === 4);

// ── rendering ────────────────────────────────────────────────────────────────
const md = renderReport(report);
check("render groups by kind with labels", md.includes("**Observed facts**") && md.includes("**Hypotheses**") && md.includes("saw Z"));
check("render shows evidence when present", renderReport(buildReport([makeClaim("observed_fact", "f", "src.ts:1")])).includes("evidence: src.ts:1"));
check("render empty report → empty string", renderReport(buildReport([])) === "");
check("CLAIM_ORDER is facts→inference→hypothesis→recommendation", CLAIM_ORDER.join(",") === "observed_fact,inference,hypothesis,recommendation");

if (fail) { console.error("\n✗ claims smoke FAILED"); process.exit(1); }
console.log("\n✓ claims smoke passed");
