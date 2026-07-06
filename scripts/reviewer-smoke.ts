// Deterministic test for the refute-reviewer (reviewer.ts) — no API key, no network, no filesystem. A
// fake `_run` stands in for the read-only worker and returns SCRIPTED text, so the smoke exercises the
// real wiring (model choice, read-only tools, task assembly, token roll-up) and the three parse outcomes
// the caller must distinguish:
//   (a) findings path   — scripted FINDING lines → strict parse → findings populated, none:false
//   (b) NONE path       — scripted "NONE"        → none:true, no findings (genuinely clean)
//   (c) garbled path    — scripted prose         → none:false, no findings, raw carried (printed UNPARSED)
// Usage: bun run scripts/reviewer-smoke.ts
import { runReview, pickReviewerModel, buildReviewTask, DIFF_CAP, type Finding } from "../src/multimind/reviewer.ts";
import { readOnlyTools, type WorkerResult, type runWorker } from "../src/multimind/runtime.ts";
import type { Tool } from "../src/agent/tools.ts";
import { loadConfig } from "../src/config.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

// provider forced to a non-free one so ensembleModels(cfg) is deterministically [cfg.model] (the free
// router would read live registry/health state — non-deterministic in a smoke).
const cfg = { ...loadConfig(), provider: "openai", apiKey: "test-key", model: "author-model", cwd: process.cwd() } as any;
const mk = (name: string, mutating = false): [string, Tool] => [name, { def: { name, description: "", input_schema: { type: "object" } }, mutating, run: async () => "" }];
// A mixed tool map: the reviewer must get a READ-ONLY view (read_file kept; write_file dropped by readOnlyTools).
const tools = new Map<string, Tool>([mk("read_file"), mk("list_dir"), mk("write_file", true)]);

/** Build a fake worker that returns `text`, emitting the same start/step/done events a real worker would
 *  (so token accrual is exercised), and capture the opts it was called with for wiring assertions. */
function fakeRunReturning(text: string): { run: typeof runWorker; seen: () => any } {
  let captured: any = null;
  const run: typeof runWorker = (async (o: any): Promise<WorkerResult> => {
    captured = o;
    o.onEvent?.({ label: o.label, phase: "start" });
    o.onEvent?.({ label: o.label, phase: "step", inputTokens: 120, outputTokens: 60 });
    o.onEvent?.({ label: o.label, phase: "done", inputTokens: 120, outputTokens: 60, ok: true });
    return { label: o.label, text, inputTokens: 120, outputTokens: 60, ok: true };
  }) as any;
  return { run, seen: () => captured };
}

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-const n = xs.length\n+const n = xs.length - 1";

// ── (a) findings path: strict parse of scripted FINDING lines ──
{
  const scripted = [
    "After trying to refute each, these survive:",
    "FINDING: src/a.ts:2 — off-by-one: reads one past the end — xs=[1] → n=0, loop touches xs[0..0] but skips nothing; xs=[] → n=-1 underflow",
    "FINDING: src/a.ts — missing empty-array guard — xs=[] makes n negative and the slice throws",
  ].join("\n");
  const { run, seen } = fakeRunReturning(scripted);
  const steps: number[] = [];
  const r = await runReview({ cfg, tools, diff: DIFF, task: "make it exclusive", model: "reviewer-model", _run: run, onEvent: (ev) => { if (ev.phase === "step") steps.push(ev.inputTokens); } });

  check("(a) parses both FINDING lines", r.findings.length === 2, `got ${r.findings.length}`);
  check("(a) none:false when findings exist", r.none === false);
  check("(a) first finding: file+line+summary+scenario", r.findings[0].file === "src/a.ts" && r.findings[0].line === 2 && /off-by-one/.test(r.findings[0].summary) && /underflow/.test(r.findings[0].scenario));
  check("(a) second finding tolerates a missing :line", r.findings[1].file === "src/a.ts" && r.findings[1].line === undefined);
  check("(a) raw carries the exact model text", r.raw === scripted);
  check("(a) token totals roll up from the worker", r.totalInputTokens === 120 && r.totalOutputTokens === 60);
  check("(a) onEvent step fired (tokens accrue at the call site)", steps.length === 1 && steps[0] === 120);

  const o = seen();
  check("(a) worker labelled 'reviewer'", o.label === "reviewer");
  check("(a) explicit model override is honored", o.model === "reviewer-model");
  check("(a) worker got a READ-ONLY tool set (read_file kept; write_file dropped)", o.tools.has("read_file") && !o.tools.has("write_file"));
  check("(a) task carries the diff + task context + strict format", o.task.includes(DIFF) && o.task.includes("make it exclusive") && o.task.includes("FINDING:"));
  check("(a) system prompt is the adversarial refuter (refute + exactly NONE)", /refute/i.test(o.system) && /exactly NONE/.test(o.system) && o.system.includes("Workspace root:"));
}

// ── (b) NONE path: a genuinely clean verdict ──
{
  const { run } = fakeRunReturning("Checked each candidate; all refuted.\nNONE");
  const r = await runReview({ cfg, tools, diff: DIFF, _run: run });
  check("(b) none:true on a NONE verdict", r.none === true);
  check("(b) no findings on NONE", r.findings.length === 0);
  check("(b) raw still carried", /NONE/.test(r.raw));
}

// ── (c) garbled path: neither NONE nor any FINDING → flagged unparsed by the caller ──
{
  const garbled = "The change converts an inclusive bound to an exclusive one; looks fine overall.";
  const { run } = fakeRunReturning(garbled);
  const r = await runReview({ cfg, tools, diff: DIFF, _run: run });
  check("(c) none:false on garbled output (NOT a false clean)", r.none === false);
  check("(c) no findings parsed from garbled output", r.findings.length === 0);
  check("(c) raw carries the garbled text for the caller to print dimmed", r.raw === garbled);
}

// ── default model choice: falls back to the author model when no distinct ensemble model exists ──
{
  // Non-free provider → ensembleModels(cfg) == [cfg.model], so pickReviewerModel returns cfg.model.
  check("default model falls back to the author model (same model, fresh context)", pickReviewerModel([cfg.model], cfg.model) === cfg.model);
  const { run, seen } = fakeRunReturning("NONE");
  await runReview({ cfg, tools, diff: DIFF, _run: run });
  check("runReview with no model override uses the author model on a non-ensemble provider", seen().model === cfg.model);
}

// ── diff bounding note is present only when the diff exceeds the cap ──
{
  check("buildReviewTask omits the truncation note for a small diff", !buildReviewTask("tiny").includes("truncated"));
  check("buildReviewTask adds the truncation note past the cap", buildReviewTask("z".repeat(DIFF_CAP + 1)).includes("truncated"));
}

// ── readOnlyTools sanity (the reviewer never gets a mutating surface) ──
{
  const ro = readOnlyTools(tools);
  check("readOnlyTools drops write_file for the reviewer", !ro.has("write_file") && ro.has("read_file"));
}

const _ignore: Finding = { file: "x", summary: "y", scenario: "z" }; void _ignore; // type-exercise the export

console.log("");
if (fail) { console.error("✗ reviewer smoke FAILED"); process.exit(1); }
console.log("✓ reviewer smoke passed");
