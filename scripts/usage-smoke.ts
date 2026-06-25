// Deterministic test for persistent usage analytics (the /usage feature). No API key / no UI.
// Verifies: append→reload round-trip, corrupt-line tolerance, the four-counter aggregation by
// day/model/mode, cache-aware cost (cache-read 0.1× / cache-write 1.25× of input, reusing the model
// price table), and that the cost reconciles (Σ buckets == total). Fixed timestamps keep it exact.
// Usage: bun run scripts/usage-smoke.ts
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsage, loadUsage, parseLines, aggregate, formatUsage, costForUsage, CACHE_READ_MULT, CACHE_WRITE_MULT, type UsageEntry } from "../src/usage/log.ts";
import { estimateCost } from "../src/providers/models.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const dir = mkdtempSync(join(tmpdir(), "ob1-usage-"));
const path = join(dir, "sub", "usage.jsonl"); // sub/ exercises mkdir-on-append
const M = "anthropic/claude-opus-4-8"; // a model the registry prices (else cost is 0 and the cost checks are vacuous)

// 1. append creates the dir + file and round-trips through loadUsage.
const mk = (over: Partial<UsageEntry>): UsageEntry => ({
  ts: "2026-06-22T10:00:00.000Z", model: M, provider: "anthropic", mode: "solo",
  in: 1000, out: 200, cacheRead: 0, cacheWrite: 0,
  costUsd: costForUsage(M, 1000, 200, 0, 0), ...over,
});
appendUsage(path, mk({}));
appendUsage(path, mk({ ts: "2026-06-22T11:00:00.000Z", mode: "fusion", in: 500, out: 100, cacheRead: 400, costUsd: costForUsage(M, 500, 100, 400, 0) }));
appendUsage(path, mk({ ts: "2026-06-23T09:00:00.000Z", model: "openai/gpt-5.5", provider: "openai", in: 2000, out: 800, costUsd: costForUsage("openai/gpt-5.5", 2000, 800, 0, 0) }));
let entries = loadUsage(path);
check("append → loadUsage round-trips every line", entries.length === 3, String(entries.length));

// 2. corrupt / blank lines are skipped, valid lines after them still parse.
appendFileSync(path, "{ this is not json\n\n   \n");
appendFileSync(path, JSON.stringify(mk({ ts: "2026-06-23T10:00:00.000Z" })) + "\n");
entries = loadUsage(path);
check("corrupt + blank lines skipped, later valid line kept", entries.length === 4, String(entries.length));
check("parseLines drops a line missing a ts", parseLines('{"model":"x","in":1}\n').length === 0);

// 3. cost: cache tokens price off the INPUT rate (read 0.1×, write 1.25×).
const baseIn = estimateCost(M, 1000, 0);
check("cache-read costs 0.1× the input rate", near(costForUsage(M, 0, 0, 1000, 0), baseIn * CACHE_READ_MULT), `${CACHE_READ_MULT}`);
check("cache-write costs 1.25× the input rate", near(costForUsage(M, 0, 0, 0, 1000), baseIn * CACHE_WRITE_MULT), `${CACHE_WRITE_MULT}`);

// 4. aggregation: four counters, by day / model / mode, and Σ-reconciliation.
const agg = aggregate(entries);
check("total.calls counts every entry", agg.total.calls === 4, String(agg.total.calls));
check("total.in sums uncached input", agg.total.in === 1000 + 500 + 2000 + 1000, String(agg.total.in));
check("total.cacheRead summed separately (not folded into in)", agg.total.cacheRead === 400, String(agg.total.cacheRead));
check("byDay splits on the date prefix", Object.keys(agg.byDay).sort().join(",") === "2026-06-22,2026-06-23");
check("byModel attributes per model", agg.byModel[M].calls === 3 && agg.byModel["openai/gpt-5.5"].calls === 1);
check("byMode attributes per mode", agg.byMode.solo.calls === 3 && agg.byMode.fusion.calls === 1);
const sumDayCost = Object.values(agg.byDay).reduce((a, b) => a + b.costUsd, 0);
check("Σ byDay cost reconciles with total (auditable)", near(sumDayCost, agg.total.costUsd), `${sumDayCost} vs ${agg.total.costUsd}`);

// 5. empty + formatting.
check("empty aggregate reports nothing recorded", formatUsage(aggregate([])).includes("no usage recorded"));
const report = formatUsage(agg);
check("report shows the headline + sections", report.includes("USAGE") && report.includes("by day") && report.includes("by model") && report.includes("by mode"));
check("report renders a positive total cost", /\$\d/.test(report), report.split("\n")[0]);

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
