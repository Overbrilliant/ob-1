#!/usr/bin/env bun
// Standalone compute-matched eval (Phase 7). Needs a configured model route. Usage:
//   bun run scripts/eval.ts [solo fusion council personas]   (default: all)
//   OB1_EVAL_TRIALS=3 bun run scripts/eval.ts                (more trials → real Solo@k estimate)
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { makeEmbedder } from "../src/memory/embed.ts";
import { buildTools } from "../src/agent/tools.ts";
import { loadTasks } from "../src/eval/tasks.ts";
import { buildRunners, ALL_MODES, SELECTABLE_MODES } from "../src/eval/runners.ts";
import { runEval, computeMatched, computeCapability } from "../src/eval/harness.ts";
import { renderReport, renderCapability } from "../src/eval/report.ts";

const cfg = loadConfig();
if (!cfg.apiKey && !cfg.providerProfile) { console.error("eval needs a configured model route: sign in for the managed server, or use /models for FreeLLMAPI or Custom API"); process.exit(1); }

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const picked = requested.filter((m) => (SELECTABLE_MODES as readonly string[]).includes(m));
let modes = picked.length ? picked : [...ALL_MODES];
if (!modes.includes("solo")) modes = ["solo", ...modes];
const trials = Math.max(1, Number(process.env.OB1_EVAL_TRIALS ?? 1));

const store = new MemoryStore(cfg.dbPath, makeEmbedder());
const tools = buildTools(cfg, store);
const onlyIds = (process.env.OB1_EVAL_TASK ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const tasks = loadTasks(cfg.cwd).filter((t) => !onlyIds.length || onlyIds.includes(t.id));
if (!tasks.length) { console.error(`no tasks matched OB1_EVAL_TASK=${onlyIds.join(",")}`); process.exit(1); }

console.error(`eval: ${tasks.length} task(s) × ${modes.join(", ")} × ${trials} trial(s) on ${cfg.model}…`);
const outcomes = await runEval({ tasks, runners: buildRunners(cfg, tools, modes), cwd: cfg.cwd, trials, onProgress: (m) => console.error("  · " + m) });
store.close();
console.log("\n" + renderCapability(computeCapability(outcomes, { baseline: "solo" })));
console.log("\n" + renderReport(computeMatched(outcomes, { baseline: "solo" })));
