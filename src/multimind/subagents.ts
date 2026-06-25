// spawn_subagents — agent-callable parallel task decomposition (the "subagents" feature).
//
// When Solo hits a BIG task that splits into INDEPENDENT parts (investigate N areas, research N
// options, audit N modules), it calls the spawn_subagents tool with the list; this runs each part as
// an isolated, READ-ONLY worker in parallel, returns each one's distilled findings to Solo, and Solo
// then synthesizes + makes any edits itself through the normal gated write path. This is decomposition
// parallelism (different sub-tasks), distinct from Fusion's best-of-N (same task, N angles).
//
// Design rules (from research/SUBAGENTS-PLAN.md, grounded in the Cognition vs Anthropic debate):
//   • read-only subagents only — a single writer (Solo) avoids conflicting parallel edits;
//   • summary-only return — the orchestrator never inherits a subagent's raw transcript;
//   • no nesting — subagents get neither spawn_subagents nor escalate;
//   • hard, shallow caps — bounded subtask count + concurrency;
//   • visible — every worker's progress streams to the footer registry + the inline meter.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runWorker, runParallel, readOnlyTools, type WorkerEvent, type WorkerResult } from "./runtime.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";
import type { AgentRegistry } from "../agent/agent-registry.ts";
import { parseTaggedClaims, buildReport, renderReport, reportStats } from "../agent/claims.ts";

export interface SubagentTask { task: string; context?: string }
export interface SubagentsResult {
  results: WorkerResult[];
  totalInputTokens: number;
  totalOutputTokens: number;
  clamped: boolean; // true if we capped the subtask count (surfaced to the user, never silent)
}

export const MAX_SUBTASKS = 8;
export const MAX_CONCURRENCY = 6;
const DEFAULT_CONCURRENCY = 4;

const SUBAGENT_SYS =
  "You are an OB-1 subagent working one slice of a larger task in an ISOLATED, read-only context. " +
  "Investigate with the read-only tools as needed, then report a concise, concrete findings summary " +
  "(facts, file:line references, the answer or recommendation) — no preamble, no plan, just the result. " +
  "Your output is handed back verbatim to the lead agent, which will synthesize and make any edits.";

/** Remove named tools from a tool map (used to deny subagents the spawn/escalate tools → no nesting). */
export function stripTools(tools: Map<string, Tool>, names: string[]): Map<string, Tool> {
  const deny = new Set(names);
  const m = new Map<string, Tool>();
  for (const [k, t] of tools) if (!deny.has(t.def.name)) m.set(k, t);
  return m;
}

/** Run independent sub-tasks as isolated read-only workers in parallel; collect each one's findings. */
export async function runSubagents(opts: {
  subtasks: SubagentTask[];
  cfg: Config;
  tools: Map<string, Tool>;
  model?: string;
  concurrency?: number;
  onEvent?: (ev: WorkerEvent) => void;   // inline live meter (the orchestrator's workerProgress)
  registry?: AgentRegistry;              // footer progress tracker
  signal?: AbortSignal;                  // ESC → abort all in-flight subagents
  _run?: typeof runWorker;               // injectable for deterministic tests
}): Promise<SubagentsResult> {
  const run = opts._run ?? runWorker;
  // Read-only + no nesting: subagents can't write, and can't spawn subagents or escalate.
  const subTools = stripTools(readOnlyTools(opts.tools), ["spawn_subagents", "escalate"]);
  // Anchor the worker to the workspace root so it uses correct relative paths from the start, instead
  // of burning its step budget guessing at ~/…, /…, and doubled-relative forms (the cause of subagents
  // "failing" — they exhaust 12 steps on path lookups that ENOENT and never produce findings).
  const system = `${SUBAGENT_SYS}\n\nWorkspace root: ${opts.cfg.cwd}. Pass every file path RELATIVE to this root (e.g. "src/agent/loop.ts") — never an absolute path or a ~ home path. If a path doesn't exist, use list_dir to find the right one rather than guessing.`;

  const clamped = opts.subtasks.length > MAX_SUBTASKS;
  const subtasks = opts.subtasks.slice(0, MAX_SUBTASKS);
  const concurrency = Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY);

  // Pre-register the whole batch so the footer shows every agent (queued → running → done) from the
  // start — even the ones waiting on a concurrency slot.
  opts.registry?.begin();
  const ids = subtasks.map((st, i) => opts.registry?.start(`subagent-${i + 1}`, st.task));

  const results = await runParallel(
    subtasks,
    (st, i) =>
      run({
        label: `subagent-${i + 1}`,
        task: st.context ? `${st.context.trim()}\n\n${st.task.trim()}` : st.task.trim(),
        system,
        cfg: opts.cfg,
        tools: subTools,
        model: opts.model,
        signal: opts.signal,
        onEvent: (ev) => { const id = ids[i]; if (id !== undefined) opts.registry?.event(id, ev); opts.onEvent?.(ev); },
      }),
    concurrency,
  );

  return {
    results,
    totalInputTokens: results.reduce((a, r) => a + r.inputTokens, 0),
    totalOutputTokens: results.reduce((a, r) => a + r.outputTokens, 0),
    clamped,
  };
}

/** Format subagent findings as the tool_result handed back to Solo (summary-only, bounded). */
export function formatSubagentFindings(subtasks: SubagentTask[], r: SubagentsResult): string {
  const head = `${r.results.length} subagent${r.results.length === 1 ? "" : "s"} finished (read-only). Synthesize their findings below, then make any edits yourself.`;
  const note = r.clamped ? `\n(note: only the first ${MAX_SUBTASKS} sub-tasks were run; the rest were dropped.)` : "";
  const body = r.results
    .map((res, i) => {
      const status = res.ok ? "" : ` [FAILED${res.error ? ": " + res.error : ""}]`;
      const text = (res.text || "(no output)").trim().slice(0, 6000);
      return `### ${res.label} — ${subtasks[i]?.task ?? ""}${status}\n${text}`;
    })
    .join("\n\n");
  const meter = `\n\n[${r.results.length} subagents · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens]`;
  return `${head}${note}\n\n${body}${meter}`;
}

// ─── Reviewable saved report (PLAN-V2 item #1 / SUBAGENTS-PLAN Phase B) ───────────────────────────
// The findings handed back to Solo are bounded + ephemeral (they scroll away). This writes the FULL,
// durable artifact the user can open later — the part normally lost. Web-survey best practices
// (Claude Code summary-only return + Cline per-subagent cost rollup): lead with the parent task + a
// run-metadata header, then a one-row-per-subagent summary table whose tokens reconcile to the total,
// then one delimited section per subagent carrying the EXACT dispatched sub-task + its full findings;
// failures stay visible (never silently dropped) and are called out up front so they're findable.

/** Render the full subagent run as a reviewable Markdown report (pure — `ts` is passed, not read). */
export function formatSubagentReport(parentTask: string, subtasks: SubagentTask[], r: SubagentsResult, ts: string): string {
  const ok = r.results.filter((x) => x.ok).length;
  const failedIdx = r.results.map((x, i) => (x.ok ? -1 : i + 1)).filter((n) => n > 0);
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
  const head = [
    `# Subagents report — ${ts}`,
    "",
    `**Parent task:** ${parentTask.trim() || "(unspecified)"}`,
    "",
    `${r.results.length} subagent${r.results.length === 1 ? "" : "s"} · ${ok} ok · ${r.results.length - ok} failed · ` +
      `~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens (read-only)`,
    failedIdx.length ? `\n> ⚠ failures: ${failedIdx.map((n) => "#" + n).join(", ")} — review their sections below.` : "",
    r.clamped ? `\n> note: only the first ${MAX_SUBTASKS} sub-tasks ran; the rest were dropped (cap).` : "",
  ].filter(Boolean).join("\n");

  const table = [
    "## Summary",
    "",
    "| # | subagent | status | tokens (in/out) | sub-task |",
    "|---|----------|--------|-----------------|----------|",
    ...r.results.map((res, i) =>
      `| ${i + 1} | ${res.label} | ${res.ok ? "ok" : "**FAILED**"} | ${res.inputTokens}/${res.outputTokens} | ${esc(subtasks[i]?.task ?? "")} |`),
  ].join("\n");

  const sections = r.results.map((res, i) => {
    const st = subtasks[i];
    const lines = [
      `### [${i + 1}/${r.results.length}] ${res.ok ? "ok" : "FAILED"} — ${res.label}`,
      "",
      `**Sub-task dispatched:** ${st?.task ?? "(unknown)"}`,
      st?.context ? `\n**Context:** ${st.context.trim()}` : "",
      `\n**Tokens:** ${res.inputTokens} in / ${res.outputTokens} out`,
      res.ok ? "" : `\n**Error:** ${res.error ?? "(no error message)"}`,
      "",
      (res.text || "(no output)").trim(),
    ].filter(Boolean);
    return lines.join("\n");
  });

  // Grounded claims: parse any tagged claims ([FACT]/[INFERENCE]/[HYPOTHESIS]/[RECOMMENDATION]) the
  // subagents emitted, dedupe identical ones across agents by content hash, and render a typed projection
  // — so a reader sees observed facts separately from inferences/guesses. Omitted when nothing was tagged.
  const allClaims = r.results.flatMap((res) => parseTaggedClaims(res.text || ""));
  const report = buildReport(allClaims, ts);
  const claimsMd = renderReport(report);
  const stats = reportStats(report);
  const claimsSection = claimsMd
    ? ["## Grounded claims", "", `${stats.grounded} observed fact(s) · ${stats.byKind.inference} inference(s) · ${stats.speculative} hypothesis(es) · ${stats.byKind.recommendation} recommendation(s)`, "", claimsMd, ""].join("\n")
    : "";

  return [head, "", table, "", claimsSection, "## Findings", "", sections.join("\n\n---\n\n"), ""].filter(Boolean).join("\n");
}

/** Write the report to `<dataDir>/subagents/<ts>.md` and return the path. `ts` is an ISO string;
 *  `:` is filename-unsafe on some hosts, so the filename uses a sanitized form. */
export function writeSubagentReport(dataDir: string, parentTask: string, subtasks: SubagentTask[], r: SubagentsResult, ts: string): string {
  const dir = join(dataDir, "subagents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${ts.replace(/[:.]/g, "-")}.md`);
  writeFileSync(path, formatSubagentReport(parentTask, subtasks, r, ts));
  return path;
}

/** Whether to write the saved report. Default ON (the feature's whole point is reviewability);
 *  opt out with OB1_SUBAGENTS_REPORT=0|off (env-only — low-surface, like OB1_SUGGEST). */
export function reportEnabled(): boolean {
  const v = (process.env.OB1_SUBAGENTS_REPORT ?? "").toLowerCase();
  return v !== "0" && v !== "off" && v !== "false";
}
