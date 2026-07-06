// Persistent token/cost analytics — the `/usage` feature (PLAN-V2 item #13).
//
// We already show a LIVE in-session meter (TUI <StatusBar>), but nothing survived a restart, so
// "where did my tokens actually go" was unanswerable across sessions — the #1 "measure first" gap.
// This appends ONE JSON line per model call to `<dataDir>/usage.jsonl` (gitignored, per-folder) and
// rolls the lines up by day / model / mode on demand.
//
// Grounded in a web survey of ccusage (the Claude Code usage tool) + token-logging best practices:
//   • keep the FOUR token counters separate (input · output · cache-read · cache-write) — never
//     collapse them; cache-read bills ~0.1× and cache-write ~1.25× of the input rate, so folding
//     them into "input" mis-bills by an order of magnitude;
//   • cache-read/-write are reported ALONGSIDE input_tokens (not a subset) — sum, don't subtract;
//   • precompute cost at append time so aggregation never needs live pricing;
//   • tolerate corrupt/partial lines (a half-written tail must never break the reader).
// Sources: github.com/ryoppippi/ccusage · braintrust.dev "how to track llm token usage".
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { estimateCost, hasKnownPricing } from "../providers/models.ts";

export interface UsageEntry {
  ts: string;        // ISO-8601 timestamp (stamped by the caller — keeps this module's core Date-free)
  model: string;     // resolved concrete model id (for pricing lookup)
  provider: string;  // "openai" | "anthropic" — attribution
  mode: string;      // solo | fusion | council | personas — per-feature attribution
  in: number;        // uncached input tokens
  out: number;       // output tokens
  cacheRead: number; // cache-read input tokens (bills ~0.1× input)
  cacheWrite: number;// cache-creation input tokens (bills ~1.25× input)
  costUsd: number;   // precomputed at append time
  estimated?: boolean; // true when the provider omitted usage and we estimated locally
}

// Cache multipliers relative to the base INPUT rate (pinned here, not duplicated per-model; pricing
// itself stays in src/providers/models.ts). Verify against live Anthropic pricing before trusting the
// absolute cost on a cache-heavy Anthropic run — current ratios for Claude.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

/** USD cost for one usage event. All cache tokens price off the INPUT rate, so we fold them into an
 *  "effective input" count and reuse estimateCost — no second copy of the per-model price table. */
export function costForUsage(model: string, inTok: number, outTok: number, cacheRead = 0, cacheWrite = 0): number {
  const effIn = inTok + cacheRead * CACHE_READ_MULT + cacheWrite * CACHE_WRITE_MULT;
  return estimateCost(model, effIn, outTok);
}

/** USD cost for one turn, priced by ROUTE not just model id. The embedded free-models router serves
 *  genuinely-free models whose ids (e.g. "google/gemini-3-flash-preview") happen to regex-match a priced
 *  frontier family in MODELS[] — pricing those by the table would print a phantom "~$0.0034" for a $0 call.
 *  So provider "free" is always $0; every other route prices by the model's table rate. */
export function turnCost(provider: string, model: string, inTok: number, outTok: number, cacheRead = 0, cacheWrite = 0): number {
  if (provider === "free") return 0;
  return costForUsage(model, inTok, outTok, cacheRead, cacheWrite);
}

/** Append one usage line. Best-effort: creates the dir, never throws into the turn (caller wraps too). */
export function appendUsage(path: string, e: UsageEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(e) + "\n");
}

/** Parse a usage.jsonl body, skipping blank/corrupt lines (a partial tail must not break the reader). */
export function parseLines(text: string): UsageEntry[] {
  const out: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object" && typeof o.ts === "string") out.push(o as UsageEntry);
    } catch { /* skip a corrupt/half-written line */ }
  }
  return out;
}

export function loadUsage(path: string): UsageEntry[] {
  if (!existsSync(path)) return [];
  return parseLines(readFileSync(path, "utf8"));
}

export interface Bucket { in: number; out: number; cacheRead: number; cacheWrite: number; costUsd: number; calls: number; unknownCalls: number; }
export interface UsageAgg {
  total: Bucket;
  byDay: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
  byMode: Record<string, Bucket>;
}

function emptyBucket(): Bucket { return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0, unknownCalls: 0 }; }
function add(b: Bucket, e: UsageEntry): void {
  b.in += e.in || 0; b.out += e.out || 0; b.cacheRead += e.cacheRead || 0;
  b.cacheWrite += e.cacheWrite || 0; b.costUsd += e.costUsd || 0; b.calls += 1;
  // A call whose model isn't in the price table contributes $0 to costUsd — track it so the report can
  // show "n/a" (not a misleading $0.00) and annotate how many calls are excluded from the dollar total.
  if (!hasKnownPricing(e.model || "")) b.unknownCalls += 1;
}
function into(rec: Record<string, Bucket>, key: string, e: UsageEntry): void {
  (rec[key] ??= emptyBucket()); add(rec[key], e);
}

/** Roll usage entries up into total + by-day + by-model + by-mode buckets (pure — the testable core). */
export function aggregate(entries: UsageEntry[]): UsageAgg {
  const agg: UsageAgg = { total: emptyBucket(), byDay: {}, byModel: {}, byMode: {} };
  for (const e of entries) {
    add(agg.total, e);
    into(agg.byDay, (e.ts || "").slice(0, 10) || "unknown", e);
    into(agg.byModel, e.model || "unknown", e);
    into(agg.byMode, e.mode || "solo", e);
  }
  return agg;
}

const fmtTok = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const fmtUsd = (n: number): string => (n > 0 && n < 0.01 ? "<$0.01" : "$" + n.toFixed(2));

/** Cost cell for a bucket: "n/a" when EVERY call in it is an unknown-priced (custom/LAN) model — its $0
 *  isn't "free", it's unpriceable, so don't print a misleading $0.00. Otherwise the (known-priced) cost. */
const costCell = (b: Bucket): string => (b.unknownCalls === b.calls ? "n/a" : fmtUsd(b.costUsd));

/** Render an aggregate as a plain-text report (the `/usage` output). */
export function formatUsage(agg: UsageAgg): string {
  const t = agg.total;
  if (t.calls === 0) return "  no usage recorded yet (run a turn, then try /usage)";
  const row = (label: string, b: Bucket): string =>
    `    ${label.padEnd(22)} ${fmtTok(b.in).padStart(7)} in ${fmtTok(b.out).padStart(7)} out ` +
    `${fmtTok(b.cacheRead).padStart(7)} cache-r  ${costCell(b).padStart(7)}  ${b.calls} calls`;
  const section = (title: string, rec: Record<string, Bucket>, sortByCost = true): string[] => {
    const keys = Object.keys(rec).sort((a, b) => (sortByCost ? rec[b].costUsd - rec[a].costUsd : a < b ? 1 : -1));
    return [`  ${title}`, ...keys.map((k) => row(k, rec[k]))];
  };
  const lines: string[] = [];
  // The dollar total already excludes unknown-priced calls (they cost $0); annotate how many so a big
  // custom/LAN session doesn't silently read as $0.00 = free.
  const totalCost = costCell(t);
  const excl = t.unknownCalls > 0 ? `  (excludes ${t.unknownCalls} call${t.unknownCalls === 1 ? "" : "s"} with unknown pricing)` : "";
  lines.push(`  USAGE — ${t.calls} model calls · ${fmtTok(t.in)} in / ${fmtTok(t.out)} out · ${fmtTok(t.cacheRead)} cache-read · total ${totalCost}${excl}`);
  lines.push("");
  lines.push(...section("by day", agg.byDay, false));
  lines.push("");
  lines.push(...section("by model", agg.byModel));
  lines.push("");
  lines.push(...section("by mode", agg.byMode));
  return lines.join("\n");
}
