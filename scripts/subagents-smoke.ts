// Deterministic test for the parallel-subagents feature (no API key). Covers:
//   • AgentRegistry — begin/start/event(start→tool→step→done)/list/runningCount/clear/subscribe (footer state)
//   • stripTools / readOnly enforcement — subagents get no mutating, spawn, or escalate tools
//   • runSubagents — parallel under the concurrency cap, clamp to MAX_SUBTASKS, registry advances, token totals
//   • formatSubagentFindings — labelled, bounded, clamp note, meter
//   • runTurn integration — Solo calls spawn_subagents → loop fans out → findings feed back; gated by canSpawn
// Usage: bun run scripts/subagents-smoke.ts
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../src/agent/agent-registry.ts";
import { runSubagents, formatSubagentFindings, formatSubagentReport, writeSubagentReport, reportEnabled, stripTools, MAX_SUBTASKS, type SubagentsResult, type SubagentTask } from "../src/multimind/subagents.ts";
import { runTurn, type TurnDeps } from "../src/agent/loop.ts";
import { readOnlyTools, type WorkerResult, type runWorker } from "../src/multimind/runtime.ts";
import type { Tool } from "../src/agent/tools.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import { loadConfig } from "../src/config.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// dataDir → a temp dir so saved subagent reports never touch the repo's .ob1 during the test.
const dataDir = mkdtempSync(join(tmpdir(), "ob1-subagents-"));
const cfg = { ...loadConfig(), apiKey: "test-key", dataDir } as any;

// ── AgentRegistry unit ──
{
  const reg = new AgentRegistry();
  let events = 0;
  reg.subscribe(() => { events++; });
  reg.begin();
  const id1 = reg.start("subagent-1", "audit auth");
  const id2 = reg.start("subagent-2", "audit tokens");
  check("start registers queued agents", reg.size === 2 && reg.list()[0].status === "queued" && reg.runningCount === 2);
  reg.event(id1, { label: "subagent-1", phase: "start" });
  check("start event → running", reg.list()[0].status === "running");
  reg.event(id1, { label: "subagent-1", phase: "tool", tool: "read_file", input: { path: "src/auth.ts" } });
  check("tool event → activity reflects the call", reg.list()[0].activity.includes("read_file") && reg.list()[0].activity.includes("src/auth.ts"));
  reg.event(id1, { label: "subagent-1", phase: "step", inputTokens: 100, outputTokens: 50 });
  check("step event → tokens + step count", reg.list()[0].steps === 1 && reg.list()[0].inTok === 100 && reg.list()[0].outTok === 50);
  reg.event(id1, { label: "subagent-1", phase: "done", inputTokens: 100, outputTokens: 50, ok: true });
  reg.event(id2, { label: "subagent-2", phase: "done", inputTokens: 0, outputTokens: 0, ok: false });
  check("done events → done/failed status", reg.list()[0].status === "done" && reg.list()[1].status === "failed");
  check("runningCount drops to 0 when all finished", reg.runningCount === 0);
  check("events fired for each change", events > 5);
  reg.clear();
  check("clear empties the registry", reg.size === 0);
  reg.begin(); reg.start("a", "x"); reg.begin();
  check("begin() drops the previous batch", reg.size === 0);
}

// ── stripTools ──
{
  const mk = (name: string, mutating = false): [string, Tool] => [name, { def: { name, description: "", input_schema: { type: "object" } }, mutating, run: async () => "" }];
  const tools = new Map<string, Tool>([mk("read_file"), mk("spawn_subagents"), mk("escalate"), mk("write_file", true)]);
  const stripped = stripTools(tools, ["spawn_subagents", "escalate"]);
  check("stripTools removes the named tools", !stripped.has("spawn_subagents") && !stripped.has("escalate") && stripped.has("read_file"));
}

// ── readOnlyTools: input-sensitive mutating tools keep their read-only surface ──
{
  const mk = (name: string, mutating = false, run: Tool["run"] = async () => ""): [string, Tool] => [name, { def: { name, description: "", input_schema: { type: "object" } }, mutating, run }];
  const tools = new Map<string, Tool>([
    mk("read_file"),
    mk("write_file", true),
    mk("execute_sql", true, async () => "sql-ok"),
  ]);
  const ro = readOnlyTools(tools);
  check("readOnlyTools keeps read tools and drops generic mutators", ro.has("read_file") && !ro.has("write_file"));
  check("readOnlyTools keeps execute_sql for SELECT", ro.has("execute_sql") && String(await ro.get("execute_sql")!.run({ sql: "SELECT 1" })) === "sql-ok");
  let blocked = false;
  try { await ro.get("execute_sql")!.run({ sql: "INSERT INTO t VALUES (1)" }); } catch { blocked = true; }
  check("readOnlyTools blocks mutating execute_sql input", blocked);
}

// ── runSubagents: parallel under cap + clamp + registry + read-only/no-nesting tool set ──
{
  const mk = (name: string, mutating = false): [string, Tool] => [name, { def: { name, description: "", input_schema: { type: "object" } }, mutating, run: async () => "" }];
  const tools = new Map<string, Tool>([mk("read_file"), mk("spawn_subagents"), mk("escalate"), mk("write_file", true), mk("memory_add")]);

  let active = 0, maxActive = 0;
  let sawTools: any = null; // the tool map the subagent worker received (asserted below)
  const fakeRun: typeof runWorker = (async (o: any): Promise<WorkerResult> => {
    sawTools = o.tools;
    active++; maxActive = Math.max(maxActive, active);
    o.onEvent?.({ label: o.label, phase: "start" });
    await sleep(10);
    o.onEvent?.({ label: o.label, phase: "step", inputTokens: 10, outputTokens: 5 });
    active--;
    o.onEvent?.({ label: o.label, phase: "done", inputTokens: 10, outputTokens: 5, ok: true });
    return { label: o.label, text: `findings for: ${o.task}`, inputTokens: 10, outputTokens: 5, ok: true };
  }) as any;

  const reg = new AgentRegistry();
  const subtasks = Array.from({ length: 5 }, (_, i) => ({ task: `task ${i + 1}` }));
  const r = await runSubagents({ subtasks, cfg, tools, concurrency: 2, registry: reg, _run: fakeRun });
  check("runSubagents returns one result per subtask", r.results.length === 5 && r.results.every((x) => x.ok));
  check("ran in parallel, capped at the concurrency limit", maxActive === 2);
  check("subagent tool set is read-only + no nesting (no write/spawn/escalate/memory_add)",
    !!sawTools && !sawTools.has("write_file") && !sawTools.has("spawn_subagents") && !sawTools.has("escalate") && !sawTools.has("memory_add") && sawTools.has("read_file"));
  check("token totals sum across subagents", r.totalInputTokens === 50 && r.totalOutputTokens === 25);
  check("registry holds the finished batch (all done)", reg.size === 5 && reg.list().every((a) => a.status === "done"));

  // clamp to MAX_SUBTASKS
  const many = Array.from({ length: MAX_SUBTASKS + 4 }, (_, i) => ({ task: `t${i}` }));
  const rc = await runSubagents({ subtasks: many, cfg, tools, _run: fakeRun });
  check(`clamps to MAX_SUBTASKS (${MAX_SUBTASKS})`, rc.results.length === MAX_SUBTASKS && rc.clamped === true);

  // formatting
  const formatted = formatSubagentFindings(subtasks, r);
  check("formatted findings carry each label + task + finding", formatted.includes("subagent-1") && formatted.includes("task 1") && formatted.includes("findings for: task 1"));
  check("formatted findings include a token meter", /~\d+ in \/ \d+ out tokens/.test(formatted));
  check("clamp note surfaced in formatting", formatSubagentFindings(many, rc).includes("only the first"));
}

// ── saved review report (PLAN-V2 #1): header + reconciling table + per-subagent sections + failures visible ──
{
  const subtasks: SubagentTask[] = [
    { task: "audit auth middleware", context: "focus on token refresh" },
    { task: "audit the rate limiter" },
  ];
  const r: SubagentsResult = {
    results: [
      { label: "subagent-1", text: "auth looks solid; refresh at auth.ts:42", inputTokens: 120, outputTokens: 40, ok: true },
      { label: "subagent-2", text: "(partial) limiter unclear", inputTokens: 30, outputTokens: 5, ok: false, error: "max steps" },
    ],
    totalInputTokens: 150, totalOutputTokens: 45, clamped: false,
  };
  const ts = "2026-06-22T12:34:56.789Z";
  const md = formatSubagentReport("review the API security", subtasks, r, ts);
  check("report leads with the parent task", md.includes("**Parent task:** review the API security"));
  check("report header counts ok/failed + tokens", md.includes("2 subagents · 1 ok · 1 failed") && md.includes("~150 in / 45 out"));
  check("report calls out failures up front (findable)", md.includes("⚠ failures: #2"));
  check("summary table reconciles per-agent tokens", md.includes("| 1 | subagent-1 | ok | 120/40 |") && md.includes("| 2 | subagent-2 | **FAILED** | 30/5 |"));
  check("report records the dispatched sub-task + context", md.includes("**Sub-task dispatched:** audit auth middleware") && md.includes("**Context:** focus on token refresh"));
  check("report carries each subagent's full findings", md.includes("refresh at auth.ts:42") && md.includes("limiter unclear"));
  check("report surfaces the failure's error", md.includes("**Error:** max steps"));

  const path = writeSubagentReport(dataDir, "review the API security", subtasks, r, ts);
  check("writeSubagentReport writes a sanitized-timestamp .md", existsSync(path) && path.endsWith("2026-06-22T12-34-56-789Z.md"));
  check("written file content matches the formatter", readFileSync(path, "utf8") === md);
  check("reportEnabled defaults ON", reportEnabled() === true);
  process.env.OB1_SUBAGENTS_REPORT = "off";
  check("reportEnabled honors the env opt-out", reportEnabled() === false);
  delete process.env.OB1_SUBAGENTS_REPORT;
}

// ── runTurn integration: Solo calls spawn_subagents → loop fans out → findings feed back ──
{
  const store = { searchSemantic: async () => [], listFacts: () => [], listRelationships: () => [] } as any;
  const baseDeps: TurnDeps = { cfg, tools: new Map(), store, approve: async () => true, log: () => {} };
  const fakeRun: typeof runWorker = (async (o: any): Promise<WorkerResult> => {
    o.onEvent?.({ label: o.label, phase: "start" });
    o.onEvent?.({ label: o.label, phase: "step", inputTokens: 7, outputTokens: 3 });
    o.onEvent?.({ label: o.label, phase: "done", inputTokens: 7, outputTokens: 3, ok: true });
    return { label: o.label, text: `did ${o.task}`, inputTokens: 7, outputTokens: 3, ok: true };
  }) as any;

  const spawnResp: ModelResponse = {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tu_s", name: "spawn_subagents", input: { subtasks: [{ task: "alpha" }, { task: "beta" }] } }],
    usage: { input_tokens: 5, output_tokens: 5 } as any,
  };
  const finalResp: ModelResponse = { stop_reason: "end_turn", content: [{ type: "text", text: "synthesized" }], usage: { input_tokens: 1, output_tokens: 1 } as any };

  // (a) canSpawn ON → loop runs subagents, findings come back as the tool_result
  {
    const reg = new AgentRegistry();
    const history: any[] = [];
    let n = 0;
    const calls: ModelResponse[] = [spawnResp, finalResp];
    const out = await runTurn("do a big split task", history, { ...baseDeps, canSpawn: true, agentReg: reg, _runWorker: fakeRun, _callModel: async () => calls[n++] });
    check("spawn integration: no escalation, completes normally", !out.escalate);
    const toolResult = history.find((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result")?.content[0];
    check("spawn integration: tool_result carries both subagents' findings", !!toolResult && toolResult.content.includes("did alpha") && toolResult.content.includes("did beta"));
    check("spawn integration: registry populated the batch for the footer", reg.size === 2 && reg.list().every((a) => a.status === "done"));
    check("spawn integration: second model call ran (Solo synthesized after)", n === 2);
    const reports = existsSync(join(dataDir, "subagents")) ? readdirSync(join(dataDir, "subagents")).filter((f) => f.endsWith(".md")) : [];
    check("spawn integration: a review report was saved end-to-end", reports.length >= 1);
    check("spawn integration: report records the parent task + both findings",
      reports.some((f) => { const t = readFileSync(join(dataDir, "subagents", f), "utf8"); return t.includes("do a big split task") && t.includes("did alpha") && t.includes("did beta"); }));
  }

  // (b) canSpawn OFF → spawn_subagents is not honored (falls through to unknown tool)
  {
    const history: any[] = [];
    let n = 0;
    const calls: ModelResponse[] = [spawnResp, finalResp];
    await runTurn("do it", history, { ...baseDeps, canSpawn: false, _runWorker: fakeRun, _callModel: async () => calls[n++] });
    const toolResult = history.find((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result")?.content[0];
    check("gated off: spawn_subagents is inert (unknown tool, no fan-out)", !!toolResult && toolResult.is_error === true && String(toolResult.content).includes("unknown tool"));
  }
}

if (fail) { console.error("\n✗ subagents smoke FAILED"); process.exit(1); }
console.log("\n✓ subagents smoke passed (registry · stripTools · runSubagents parallel/cap/clamp · formatting · runTurn integration + gating)");
process.exit(0);
