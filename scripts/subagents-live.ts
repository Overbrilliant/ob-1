// LIVE end-to-end check for spawn_subagents (needs a configured model route).
// Two parts:
//   1. runSubagents directly with the REAL model on 3 independent read-only tasks → verifies they run
//      in parallel, return findings, and the registry tracks each one's progress live.
//   2. runTurn with canSpawn ON + a decomposable prompt → verifies the model actually CALLS
//      spawn_subagents and synthesizes the findings (the full agent path).
// Usage: bun run scripts/subagents-live.ts
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { buildTools } from "../src/agent/tools.ts";
import { runSubagents, formatSubagentFindings } from "../src/multimind/subagents.ts";
import { runTurn } from "../src/agent/loop.ts";
import { AgentRegistry } from "../src/agent/agent-registry.ts";
import type { WorkerEvent } from "../src/multimind/runtime.ts";

const cfg = loadConfig();
if (!cfg.apiKey && !cfg.providerProfile) { console.error("no configured model route — sign in, or use /models for Free models or Custom API; skipping live test"); process.exit(0); }
console.log(`provider=${cfg.provider} model=${cfg.model}\n`);

const store = new MemoryStore(":memory:");
const tools = buildTools(cfg, store);
const reg = new AgentRegistry();
let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// Live progress: mirror what the footer registry sees.
const onEvent = (ev: WorkerEvent) => {
  if (ev.phase === "start") console.log(`   ▸ ${ev.label} started`);
  if (ev.phase === "tool") console.log(`     → ${ev.label}: ${ev.tool}`);
  if (ev.phase === "done") console.log(`   ${ev.ok ? "✓" : "✗"} ${ev.label} done`);
};

// ── Part 1: runSubagents directly on 3 independent tasks ──
console.log("Part 1 — runSubagents on 3 parallel read-only tasks:\n");
const subtasks = [
  { task: "In one sentence, what does src/agent/procs.ts do? Read it to be sure." },
  { task: "In one sentence, what does src/multimind/runtime.ts provide? Read it to be sure." },
  { task: "In one sentence, what does src/agent/agent-registry.ts track? Read it to be sure." },
];
const t0 = Date.now();
const r = await runSubagents({ subtasks, cfg, tools, registry: reg, onEvent, concurrency: 3 });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n(${secs}s · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens)\n`);
check("all 3 subagents returned output", r.results.length === 3 && r.results.every((x) => x.ok && x.text.length > 0));
check("registry tracked all 3 to done", reg.list().length === 3 && reg.list().every((a) => a.status === "done"));
check("each finding references its own file", r.results[0].text.toLowerCase().includes("proc") || r.results[0].text.toLowerCase().includes("process"));
console.log("\nFindings:\n" + formatSubagentFindings(subtasks, r).slice(0, 1200) + "\n");

// ── Part 2: full agent loop — does the model CALL spawn_subagents on a decomposable task? ──
console.log("\nPart 2 — runTurn (canSpawn ON) on a decomposable prompt:\n");
reg.clear();
const history: any[] = [];
let spawned = false;
const out = await runTurn(
  "I need a quick independent summary of THREE separate files: src/config.ts, src/agent/loop.ts, and src/cli/ui.ts. " +
  "These are unrelated, so investigate them in parallel with subagents, then give me a 1-line summary of each.",
  history,
  {
    cfg, tools, store, approve: async () => true,
    log: (s) => process.stdout.write(s + "\n"),
    canSpawn: true, agentReg: reg,
    onWorkerEvent: (ev) => { if (ev.phase === "start") spawned = true; onEvent(ev); },
    onText: (d) => process.stdout.write(d),
  },
);
console.log("");
check("model invoked spawn_subagents (parallel path taken)", spawned);
check("turn completed without escalation", !out.escalate);
check("a tool_result with subagent findings landed in history", history.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result" && String(b.content).includes("subagent"))));

if (fail) { console.error("\n✗ subagents LIVE test FAILED"); process.exit(1); }
console.log("\n✓ subagents live test passed (parallel read-only fan-out + real model spawn + synthesis)");
process.exit(0);
