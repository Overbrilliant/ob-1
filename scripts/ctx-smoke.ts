// Deterministic test for context-editing (no API key needed).
// Usage: bun run scripts/ctx-smoke.ts
import { editContext, totalChars, compactIfNeeded } from "../src/agent/context.ts";
import type { Message } from "../src/providers/types.ts";

let fail = false;
const check = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${ok || !d ? "" : `  — ${d}`}`); if (!ok) fail = true; };

// ── raised default threshold: a moderately long history must NOT thrash-evict early ──
const moderate: Message[] = [];
for (let i = 0; i < 20; i++) {
  moderate.push({ role: "assistant", content: [{ type: "tool_use", id: `m${i}`, name: "read_file", input: { path: `f${i}.ts` } }] });
  moderate.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `m${i}`, content: "X".repeat(4000) }] }); // ~80k chars total
}
const modRes = editContext(moderate); // defaults (200k trigger) — ~80k history stays untouched
check("moderate history under the (raised) default trigger is left intact", modRes.cleared === 0, `cleared ${modRes.cleared}`);

// ── path-aware eviction: protect the freshest read of every file; reclaim re-runnable bulk ──
const h: Message[] = [];
const pair = (name: string, id: string, content: string, path?: string) => {
  h.push({ role: "assistant", content: [{ type: "tool_use", id, name, input: path ? { path } : {} }] });
  h.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] });
};
pair("read_file", "rOld", "SHAREDOLD" + "X".repeat(4000), "shared.ts"); // stale read — later superseded
for (let i = 0; i < 8; i++) pair("run_bash", `b${i}`, "BASHDUMP" + "B".repeat(4000));        // re-runnable bulk → evictable
pair("read_file", "rNew", "SHAREDNEW" + "X".repeat(4000), "shared.ts"); // fresh read of the SAME file
pair("read_file", "rKeep", "KEEPONLY" + "X".repeat(4000), "keep.ts");   // only read of this file
for (let i = 0; i < 12; i++) h.push({ role: "user", content: `recent ${i}` }); // fill the keepRecent window

const before = totalChars(h);
const res = editContext(h, { triggerChars: 20_000, keepRecent: 12 });
const after = totalChars(h);
console.log(`eviction: ${before.toLocaleString()} → ${after.toLocaleString()} chars · ${res.cleared} results cleared · ${res.savedChars.toLocaleString()} saved`);

const allResults = h.flatMap((m) => Array.isArray(m.content) ? (m.content as any[]).filter((b) => b.type === "tool_result").map((b) => b.content as string) : []);
const has = (marker: string) => allResults.some((c) => c.includes(marker));
check("freshest read of a re-read file is PRESERVED", has("SHAREDNEW"));
check("once-read file is PRESERVED (latest read of its path)", has("KEEPONLY"));
check("superseded earlier read of the same file is evicted", !has("SHAREDOLD"));
check("re-runnable bash output is evicted", !has("BASHDUMP"));
check("evicted placeholders name the tool/path for re-running", allResults.some((c) => c.includes("[cleared") && c.includes("shared.ts")));
check("net context shrank", after < before && res.cleared >= 9);

// --- LLM-summary compaction (with an injected summarizer; no model needed) ---
const big: Message[] = [];
for (let i = 0; i < 30; i++) {
  big.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "x", input: {} }] });
  big.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "Y".repeat(4000) }] });
}
const lenBefore = big.length;
const did = await compactIfNeeded(big, { hardCapChars: 50_000, summarize: async () => "SUMMARY OF EARLIER WORK" });
const compacted = did === true && big.length < lenBefore && typeof big[0].content === "string" && (big[0].content as string).includes("SUMMARY OF EARLIER WORK");
const noop = await compactIfNeeded([{ role: "user", content: "hi" }], { summarize: async () => "x" }); // under cap → false
const noSummarizer = await compactIfNeeded(big, { hardCapChars: 1 }); // no summarizer → false even over cap
check("compaction summarizes older turns into a head note", compacted, `${lenBefore} → ${big.length}`);
check("compaction is a no-op under the cap", noop === false);
check("compaction is a no-op without a summarizer", noSummarizer === false);

console.log("");
if (fail) { console.error("✗ context-editing smoke FAILED"); process.exit(1); }
console.log("✓ context-editing smoke passed (path-aware eviction + raised thresholds + compaction)");
