#!/usr/bin/env bun
// OB-1 CLI entry point (Phase 0). A REPL wrapping the gated agent loop, with slash
// commands for mode switching and the /memory inspector (the "very visible" memory, R8).
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveSettings, savedProviderCreds, bakedProviderCreds, hasPersistedSettings, persistedSettings, settingsHealth, ob1ServerUrl, loadAuthToken, persistSubscription, isOpenRouterEndpoint, type Mode, type SandboxMode, type PermissionMode, type Effort, type QualityMode } from "./config.ts";
import { formatSettingsIssues } from "./config-validate.ts";
import { loadPolicy, loadTrust, saveTrust, recordTrust, isTrusted, effectivePermissionMode } from "./safety/policy.ts";
import { readGitState, analyzeBranch } from "./context/git-state.ts";
import { ApprovalStore, parseAllowSpec } from "./agent/approval-tokens.ts";
import { loadHooks } from "./agent/hooks.ts";
import { sandboxNote, sandboxAvailable } from "./safety/sandbox.ts";
import { MemoryStore, type MemoryBrain } from "./memory/store.ts";
import { exportGraph, type ExportFormat } from "./memory/export.ts";
import { makeEmbedder } from "./memory/embed.ts";
import { buildRepoMap, renderRepoMap, invalidateRepoMap } from "./context/repomap.ts";
import { CheckpointStore, type Checkpoint } from "./agent/checkpoint.ts";
import { initTreeSitter, treeSitterStatus } from "./context/treesitter.ts";
import { generateAgentsMd, loadAgentsMd, refreshAgentsMd } from "./context/agents.ts";
import { listEpisodes, listPromotionCandidates, loadAgentsMemory, promoteCandidates, rememberEpisode } from "./context/agent-memory.ts";
import { ensureOb1GitExclude } from "./context/git-exclude.ts";
import { listSkills, readSkill, deleteSkill } from "./skills/registry.ts";
import { maybeLearnSkill } from "./skills/learn.ts";
import { approxTokens, totalChars, budgetChars, compactNow, summaryPrompt } from "./agent/context.ts";
import { newSessionId, saveSession, listSessions, loadSession, deriveTitle, relTime, type SessionFile } from "./agent/session.ts";
import { expandMentions } from "./context/mentions.ts";
import { runCurator, readUsage } from "./skills/usage.ts";
import { buildTools, ReadCache, type Tool, type AskUserFn, type AskUserRequest } from "./agent/tools.ts";
import { SecretStore } from "./agent/secrets.ts";
import { ProcRegistry } from "./agent/procs.ts";
import { AgentRegistry } from "./agent/agent-registry.ts";
import { TodoRegistry } from "./agent/todo-registry.ts";
import { loadMcpServers, makeMcpLoaderTool, type McpLoadResult } from "./mcp/manager.ts";
import { fanout } from "./multimind/orchestrator.ts";
import { runLedger } from "./multimind/ledger.ts";
import { runCodeAct, CODEACT_SYSTEM } from "./agent/codeact.ts";
import { runFusion } from "./multimind/fusion.ts";
import { runCouncil } from "./multimind/council.ts";
import { applySolution as applySolutionStep } from "./multimind/apply.ts";
import { runPersonas } from "./multimind/personas.ts";
import { runAdaptive, suggestMode } from "./multimind/router.ts";
import type { WorkerEvent } from "./multimind/runtime.ts";
import { appendUsage, loadUsage, aggregate, formatUsage, costForUsage } from "./usage/log.ts";
import { loadTasks } from "./eval/tasks.ts";
import { buildRunners, ALL_MODES, SELECTABLE_MODES } from "./eval/runners.ts";
import { runEval, computeMatched, computeCapability } from "./eval/harness.ts";
import { renderReport, renderCapability } from "./eval/report.ts";
import { runTurn, describe as describeTool, systemPrompt } from "./agent/loop.ts";
import { runVerification, shellExec } from "./agent/verify.ts";
import { latestQualityLedger, formatQualityLedger } from "./agent/task-quality.ts";
import { loadQualityScenarios, scoreQualityLedger } from "./eval/scenarios.ts";
import type { Message, Usage } from "./providers/types.ts";
import { callModel } from "./providers/gateway.ts";
import { describeModel, modelSpec, MODELS, isRouterModel, modelReasoning, contextWindowFor } from "./providers/models.ts";
import { FREELLMAPI, CUSTOM, profileById, normalizeBaseUrl, fetchModels, type ProviderProfile } from "./providers/profiles.ts";
import { banner, c, modeColor, explainError, renderFriendly } from "./cli/ui.ts";
import { TuiController, startTui, type ProviderSetupOpts, type ProviderSetupResult } from "./cli/tui.tsx";

const CLI_VERSION = "0.1.3";
const SHELL_HELP = `OB-1 ${CLI_VERSION}

Usage:
  ob1                 Start the interactive CLI in the current directory
  ob1 onboard         Run guided setup
  ob1 login           Sign in to the managed OB-1 server
  ob1 signup          Create an account on the managed OB-1 server
  ob1 logout          Remove the local token
  ob1 --help          Show this help
  ob1 --version       Print the version

Inside OB-1, use /help for interactive commands.`;

// `ob1 login` / `ob1 signup` / `ob1 logout` — handled before any heavy startup (memory, MCP,
// tree-sitter). Auth is email + password straight to the managed server, which returns the per-user
// bearer token — the only credential the open-source client holds (real provider keys live server-side).
{
  const sub = Bun.argv[2];
  if (sub === "--version" || sub === "-v" || sub === "version") {
    console.log(CLI_VERSION);
    process.exit(0);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(SHELL_HELP);
    process.exit(0);
  }
  if (sub === "login" || sub === "signup" || sub === "logout") {
    const { runLogin, runLogout } = await import("./cli/login.ts");
    if (sub === "logout") runLogout();
    else await runLogin({ mode: sub === "signup" ? "signup" : "login" });
    process.exit(process.exitCode ?? 0);
  }
  if (sub === "onboard") { // re-run the guided setup on demand
    const { runOnboarding } = await import("./cli/onboarding.ts");
    await runOnboarding({ force: true });
    process.exit(0);
  }
}

// First-run onboarding (soft + skippable): sign in → pick a provider → for the free path, set up and
// auto-wire the managed FreeLLMAPI proxy. Runs BEFORE loadConfig so the new token/provider are picked
// up by the single resolve below. No-ops on non-TTY (pipes/CI) and once the user has set anything up.
let onboardingRan = false;
{
  const { shouldOnboard, runOnboarding } = await import("./cli/onboarding.ts");
  if (shouldOnboard()) { onboardingRan = true; await runOnboarding(); }
}

let cfg = loadConfig();
ensureOb1GitExclude(cfg.cwd, cfg.dataDir);

/** Can OB-1 reach a model? True with an API key OR a configured provider profile — a keyless Custom/LAN
 *  endpoint (key optional) has no key but is fully usable. Used to gate the model-disabled warning and the
 *  heavier modes so they don't refuse on a working keyless provider. */
function modelReachable(): boolean {
  return !!cfg.apiKey || !!cfg.providerProfile;
}

// Auth guard: when we rely on the managed OB-1 server but the saved token is missing or REJECTED
// (expired, or the account was reset), (re)authenticate before doing anything — otherwise the first
// request dies with a confusing 401. Interactive TTY only; BYOK / Free-LLM / OB1_TOKEN users skip it.
if (stdin.isTTY && !process.env.OB1_TOKEN) {
  const onManaged = !cfg.providerProfile && cfg.provider === "openai" && cfg.baseUrl.startsWith(ob1ServerUrl());
  if (onManaged) {
    const status = await validateAuth();
    // Re-login on a bad token always; on no-token only if onboarding didn't already just ask this run.
    if (status === "unauthorized" || (status === "no-token" && !onboardingRan)) {
      const { runLogin, clearAuthToken } = await import("./cli/login.ts");
      if (status === "unauthorized") {
        clearAuthToken();
        console.log(c.yellow("\n  Your OB-1 session has expired (or the account was reset). Please sign in again."));
      } else {
        console.log(c.dim("\n  You're not signed in. Connect your OB-1 account to use intelligent models."));
      }
      await runLogin({ mode: "login" });
      cfg = loadConfig(); // pick up the freshly-saved token
    }
  }
}
const embedder = makeEmbedder();
// Memory "brain": a cheap one-shot LLM call that powers opt-in memory evolution (#4) / reflection (#6)
// / auto-linking (#7). One mutable object so `/memory evolve on|off` flips the flag live. A separate
// cheap model can be pinned via OB1_MEM_MODEL; defaults to the session model. Only wired when a key exists.
const memBrain: MemoryBrain | undefined = cfg.apiKey
  ? {
      ask: async (prompt: string): Promise<string> => {
        const r = await callModel({
          provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl,
          model: process.env.OB1_MEM_MODEL || cfg.model, system: "",
          messages: [{ role: "user", content: prompt }],
        });
        return r.content.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim();
      },
      evolve: cfg.memEvolve,
      reflect: cfg.memReflect,
      autolink: cfg.memAutolink,
      onNote: (s) => console.log(c.dim(`  🧠 ${s}`)),
    }
  : undefined;
const store = new MemoryStore(cfg.dbPath, embedder, memBrain);
// ask_user routes through the active UI (TUI picker / REPL prompt). Bound late (the UI is set by
// runRepl/runTui) — the closure only runs mid-turn, by which point `ui` exists.
function uiAskUser(req: AskUserRequest): Promise<string> {
  return ui.askUser ? ui.askUser(req) : Promise.resolve("(No interactive UI available to ask the user. Proceed with your best assumption and state it explicitly.)");
}
// Running run_bash subprocesses — shown in the TUI footer; ⌃P opens a manager to kill them.
const procs = new ProcRegistry();
// Safety net: take down every background process the harness started, whatever ends it. The in-app
// paths (ESC, ⌃C, /exit) already call killAll; these cover the rest — an external `kill` (SIGTERM), a
// closed terminal (SIGHUP), a REPL ⌃C (SIGINT), a ⌃\ (SIGQUIT), an alarm/deadline (SIGALRM), and any
// process.exit — so a detached dev server/watcher never outlives OB-1. NOTE: 'exit' does NOT fire when an
// uncaught signal kills us, so each terminating signal must be handled explicitly to reap before exiting;
// SIGKILL/SIGSTOP are the only signals the OS won't let us catch (nothing can prevent that leak).
let _reaped = false;
const reapProcs = (): void => { if (_reaped) return; _reaped = true; try { procs.reapAll(); } catch { /* best-effort */ } };
process.on("exit", reapProcs);
const SIGNAL_EXIT_CODE: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131, SIGALRM: 142 };
for (const sig of Object.keys(SIGNAL_EXIT_CODE)) {
  process.once(sig as NodeJS.Signals, () => {
    reapProcs();
    // Mirror the normal-exit cleanup on a terminating signal too: close MCP clients (else their spawned
    // stdio subprocesses — which aren't in `procs` — orphan) and the store (final WAL checkpoint). Each is
    // best-effort and the try/catch also absorbs a TDZ ref if a signal lands before `mcp` is assigned.
    try { for (const cl of mcp.clients) cl.close(); } catch { /* not loaded yet / already closed */ }
    try { store.close(); } catch { /* best-effort */ }
    process.exit(SIGNAL_EXIT_CODE[sig]);
  });
}
// Live subagents spawned by spawn_subagents — shown in the TUI footer so the user can track each one.
const agentReg = new AgentRegistry();
// The agent's TODO list (update_tasks tool) — rendered above the input; persists across turns.
const todos = new TodoRegistry();
// Shared per-turn read-dedup cache (token optimization). The same instance is baked into `tools`'
// read_file and handed to runTurn (via turnDeps) so the loop can clear it at turn start / on eviction.
const readCache = new ReadCache();
// Session secret store for request_secret / check_secret. The masked prompt routes through the active UI
// (ui.prompt — implemented in both the REPL and the TUI); the closure runs lazily mid-turn, by which point
// `ui` is set. A captured value is exposed to run_bash children as $NAME and is never logged/persisted.
const secrets = new SecretStore({
  prompt: async (name, reason) =>
    ui.prompt ? ui.prompt({ title: `Secret · ${name}`, question: reason ? `Enter ${name} — ${reason}` : `Enter value for ${name}`, mask: true }) : null,
});
const tools = buildTools(cfg, store, uiAskUser, procs, todos, readCache, { secrets });
// Declarative policy rules (.ob1/policy.json in the workspace): pre-decide tool calls (allow/deny/warn)
// before the approval gate. Best-effort: a malformed file just yields no rules (errors surfaced at boot).
const policy = loadPolicy(cfg.cwd);
// Session capability tokens (granted via /allow) — standing approvals so the gate stops re-prompting
// for, e.g., every git command. In-memory only; never persisted (a grant can't outlive the session).
const approvals = new ApprovalStore();
// Programmable hooks (.ob1/hooks.json): PreToolUse can block a call; PostToolUse/PostToolUseFailure feed
// the model lint/format/fix-hint output. Real executor pipes the JSON payload to a shell command (bounded).
const hooks = loadHooks(cfg.cwd);
const hookExec = async (command: string, stdin: string): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bash", "-lc", command], { cwd: cfg.cwd, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 30_000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  } finally { clearTimeout(timer); }
};
// Build a fresh tool map scoped to a different cwd — used by Fusion to give each candidate the FULL
// toolset inside its own writable workspace copy (file tools close over cfg.cwd, so a copy needs its
// own map, not just a different cfg passed to runWorker). Shares the same store/procs/todos/askUser.
const mkTools = (cwd: string): Map<string, Tool> => buildTools({ ...cfg, cwd }, store, uiAskUser, procs, todos, undefined, { secrets });
let mcp: McpLoadResult = { clients: [], tools: [], summary: [] };
let deferredMcp = new Map<string, Tool>(); // MCP tools not sent to the model until load_mcp_tool activates them
let history: Message[] = [];
// /rewind checkpointing: a per-launch session id + a shadow-git store. A snapshot is taken before each
// prompt (see processLine) so the worktree and conversation position can be reverted later.
const sessionId = `${Date.now().toString(36)}-${process.pid}`;
const checkpoints = new CheckpointStore(cfg, sessionId);

// Saved-conversation id for /resume (separate from the checkpoint sessionId). Rotates on /clear so the
// previous conversation stays resumable, exactly like Claude Code. activeGoal drives the /goal loop.
let convoId = newSessionId();
let convoCreated = Date.now();
let activeGoal: string | null = null;

/** Best-effort persist of the current conversation so /resume can reopen it. Never throws into a turn. */
function persistSession(): void {
  if (!history.length) return;
  try {
    saveSession(cfg.dataDir, {
      id: convoId, title: deriveTitle(history), created: convoCreated, updated: Date.now(),
      cwd: cfg.cwd, model: cfg.resolvedModel ?? cfg.model,
      turns: history.filter((m) => m.role === "user").length, history,
    });
  } catch { /* persistence must never break a turn */ }
}

function resumeSession(id: string): void {
  const s = loadSession(cfg.dataDir, id);
  if (!s) { console.log(c.red(`  couldn't load session ${id}`)); return; }
  history = s.history; convoId = s.id; convoCreated = s.created;
  ctrl?.setContext(approxTokens(history));
  console.log(c.green(`  ✓ resumed "${s.title}" — ${history.length} messages (~${approxTokens(history)} tokens)`));
  console.log(c.dim("  continue where you left off, or /clear to start fresh"));
}

/** Copy text to the OS clipboard (pbcopy / clip / xclip). Returns false if no clipboard tool is available. */
async function copyToClipboard(text: string): Promise<boolean> {
  const cmd = process.platform === "darwin" ? ["pbcopy"]
    : process.platform === "win32" ? ["clip"]
    : ["xclip", "-selection", "clipboard"];
  try {
    const p = Bun.spawn(cmd, { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" });
    await p.exited;
    return p.exitCode === 0;
  } catch { return false; }
}

/** Render the conversation as plain markdown for /export. */
function renderTranscript(h: Message[]): string {
  const lines: string[] = [`# OB-1 conversation — ${new Date().toISOString()}`, `model: ${cfg.model}  ·  ${h.length} messages`, ""];
  for (const m of h) {
    const body = typeof m.content === "string"
      ? m.content
      : (m.content as any[]).map((b: any) => {
          if (b?.type === "text") return b.text;
          if (b?.type === "tool_use") return `\`[tool: ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 200)})]\``;
          if (b?.type === "tool_result") return `\`[tool result: ${(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 500)}]\``;
          return "";
        }).filter(Boolean).join("\n");
    lines.push(`## ${m.role}`, body, "");
  }
  return lines.join("\n");
}

/** /goal loop: keep running turns toward `goal` until the model emits GOAL_MET or the cap is hit. ESC stops. */
async function runGoalLoop(goal: string): Promise<void> {
  await ensureProxyHealthy();
  const maxIters = Number(process.env.OB1_GOAL_MAX_ITERS) > 0 ? Number(process.env.OB1_GOAL_MAX_ITERS) : 10;
  for (let i = 0; i < maxIters && activeGoal === goal; i++) {
    const prompt = i === 0
      ? `${goal}\n\n[Goal mode] Work toward this goal. When it is FULLY achieved, end your reply with the exact token GOAL_MET on its own line. If work remains, end with GOAL_CONTINUE.`
      : `Continue toward the goal: ${goal}\n[Goal mode] End with GOAL_MET when fully done, otherwise GOAL_CONTINUE.`;
    const startLen = history.length;
    const outcome = await runTurn(prompt, history, turnDeps());
    rememberTurn(prompt, startLen, "goal");
    persistSession();
    if (activeAbort?.signal.aborted) { console.log(c.dim("  ⊘ goal loop stopped (ESC)")); break; }
    void outcome; // a heavy mode may have run inside; still counts as one iteration
    const txt = lastAssistantText();
    if (/\bGOAL_MET\b/.test(txt)) { console.log(c.green(`  ✓ goal achieved after ${i + 1} iteration(s)`)); activeGoal = null; return; }
    console.log(c.dim(`  ↻ goal iteration ${i + 1}/${maxIters} — not yet met, continuing…`));
  }
  if (activeGoal === goal) console.log(c.yellow(`  goal loop hit the ${maxIters}-iteration cap without GOAL_MET — /goal "${goal}" to keep going, or /goal stop`));
}

// ─── UI bridge ───────────────────────────────────────────────────────────────
// Output routes through `ui` so the SAME agent loop drives either the readline REPL
// (piped / non-TTY) or the Ink TUI (interactive, with a live token/cost meter).
interface UI {
  log: (s: string) => void;
  /** Emit a single deduped blank line between stream blocks (user msg · response · tool call). */
  gap?: () => void;
  onText: (d: string) => void;
  endText: () => void;
  onReasoning?: (d: string) => void;
  endReasoning?: () => void;
  approve: (desc: string) => Promise<boolean>;
  onUsage: (u: Usage) => void;
  /** A router alias (`auto`) resolved to this concrete model — the TUI shows it in the footer. */
  onResolvedModel?: (model: string) => void;
  /** Park an actionable error's action (e.g. an upgrade link) so the TUI can surface it on ↑. */
  onErrorAction?: (action?: { label: string; url: string }) => void;
  // Interactive list picker (TUI only). Returns the chosen value, or null if cancelled. Undefined
  // under the REPL — command handlers fall back to printing a plain list when it's absent.
  pick?: (title: string, items: { label: string; hint?: string; value: string }[], current?: string) => Promise<string | null>;
  // How the most recent pick() closed: "select" (a value), "back" (←, up one level) or "escape" (Esc,
  // leave). Nested pickers use this to make ← return to the parent while Esc exits the whole flow.
  pickReason?: () => "select" | "back" | "escape";
  // Clarification question (TUI shows radio/checkbox + a free-text row; REPL prompts on the next line).
  // Returns a human-readable answer string for the tool result.
  askUser?: AskUserFn;
  // Provider setup tab (opened from /models): collects a proxy URL + key (TUI form / REPL prompts), with a live
  // connection test. Returns the entered {url, key} or null if cancelled.
  providerSetup?: (opts: ProviderSetupOpts) => Promise<ProviderSetupResult>;
  // Inline single-field text prompt (TUI modal / REPL line). Used by the managed Free LLM API setup from
  // /freellm for email/password (mask hides the value). Returns the text, or null if cancelled (Esc).
  prompt?: (opts: { title: string; question: string; mask?: boolean; placeholder?: string }) => Promise<string | null>;
}
let ui: UI;                            // set by runRepl()/runTui() before any turn runs
let ctrl: TuiController | null = null; // present only in TUI mode (drives the live meter)

/** Accrue tokens into the live status meter (TUI only; a no-op under the REPL) AND persist one line to
 *  `<dataDir>/usage.jsonl` for `/usage` analytics. This is the single chokepoint every model call flows
 *  through (Solo turns via onUsage + every multi-mind worker step), so logging here captures the whole
 *  session — heavy modes and subagents included. Best-effort: a logging failure never breaks the turn. */
function accrue(inTok: number, outTok: number, cacheRead = 0, cacheWrite = 0): void {
  ctrl?.addTokens(inTok, outTok, cacheRead);
  try {
    const model = cfg.resolvedModel ?? cfg.model;
    appendUsage(join(cfg.dataDir, "usage.jsonl"), {
      ts: new Date().toISOString(), model, provider: cfg.provider, mode: cfg.mode,
      in: inTok, out: outTok, cacheRead, cacheWrite,
      costUsd: costForUsage(model, inTok, outTok, cacheRead, cacheWrite),
    });
  } catch { /* analytics must never interrupt a turn */ }
}

/** Live progress for the multi-call modes (Fusion/Council/Personas/Adaptive), so the TUI shows the
 *  workers actually working instead of a silent "working… 0.0k": a "· label…" header on start, the
 *  worker's streamed thinking (sequential workers only), each tool call ("  → label: read_file …"),
 *  and a per-model-call token-meter bump. NOTE: tokens accrue here per `step`, so the turn handlers
 *  must NOT also accrue the orchestrator total — that would double-count. */
let workerStreaming = false;
let lastWorkerLabel = "";  // the worker whose "· label…" header is currently on screen
function flushWorkerStream(): void { if (workerStreaming) { ui.endText(); workerStreaming = false; } }
function workerProgress(ev: WorkerEvent): void {
  switch (ev.phase) {
    case "start": flushWorkerStream(); lastWorkerLabel = ev.label; console.log(c.dim(`  · ${ev.label}…`)); break;
    case "text":  ui.onText(ev.delta); workerStreaming = true; break; // live "thinking" (TUI stream / REPL stdout)
    case "tool": {
      flushWorkerStream();
      // The "· label…" header already names the worker, so only re-label a tool call when a DIFFERENT
      // worker's call interleaves (parallel critics/candidates). A single worker (e.g. solo) → no repeat.
      const prefix = ev.label === lastWorkerLabel ? "" : `${ev.label}: `;
      lastWorkerLabel = ev.label;
      console.log(c.gray(`    → ${prefix}${describeTool(ev.tool, ev.input)}`));
      break;
    }
    case "step":  accrue(ev.inputTokens, ev.outputTokens); break;     // meter moves after every model call
    case "done":  flushWorkerStream(); break;                          // commit any trailing streamed text
  }
}

/** Save a multi-mind mode's synthesized solution to disk via the MAIN gated agent loop (full
 *  write/edit/bash tools + approval gate) — see ./multimind/apply.ts for the rationale. NOTE: the
 *  deliberation itself runs in isolated worker histories and never enters the shared `history`; it's
 *  this apply turn (the prompt + its tool calls) that lands in the main conversation, so follow-ups
 *  see the applied solution but not the candidates/critiques that produced it. */
async function applySolution(task: string, solution: string): Promise<void> {
  await applySolutionStep({
    task, solution, planMode: cfg.planMode,
    run: async (prompt) => { await runTurn(prompt, history, turnDeps({ canEscalate: false, canSpawn: false, canSpawnWrite: false })); }, // applying a mode's result must not re-escalate or re-spawn
    log: console.log, note: c.dim,
  });
}

let activeAbort: AbortController | null = null; // the current turn's cancel handle (ESC); null when idle
let turnMutated = false; // did a mutating tool (write/edit/bash) run THIS turn? → ESC warns edits may be partial

// The SILENT post-turn gate runs only fast compile checks (typecheck / `cargo check` / `go build` /
// ruff / mypy), which finish in seconds on a sane project. A much tighter cap than shellExec's 300s
// default keeps a pathological check (a watch-mode `tsc -w`, a cold `cargo`/`go` blocked on a network
// fetch, an npm script that spawns a server) from freezing the turn at "⚙ verifying changes…" for
// minutes. Anything genuinely slower is the agent's call via the `verify` tool, which keeps the long cap.
const AUTO_VERIFY_TIMEOUT_MS = 120_000;
/** The auto-verify hook for the self-fix loop: run the project's FAST checks (typecheck/compile) and
 *  report pass/fail. Honors the current ESC signal so a long check can be cancelled. Bounded by
 *  AUTO_VERIFY_TIMEOUT_MS so a hanging check times out (timedOut) instead of dangling. Never throws. */
async function autoVerify(): Promise<{ ran: boolean; ok: boolean; report: string; timedOut: boolean } | null> {
  try {
    const r = await runVerification(cfg.cwd, (cmd) => shellExec({ cwd: cfg.cwd, sandbox: cfg.sandbox, command: cmd, timeoutMs: AUTO_VERIFY_TIMEOUT_MS, signal: activeAbort?.signal }), "auto");
    return { ran: r.ran, ok: r.ok, report: r.report, timedOut: r.timedOut };
  } catch { return null; }
}

function turnDeps(overrides?: { canEscalate?: boolean; canSpawn?: boolean; canSpawnWrite?: boolean }) {
  return {
    cfg, tools, store, readCache, approve: ui.approve, log: ui.log, gap: ui.gap, onText: ui.onText, endText: ui.endText,
    onReasoning: ui.onReasoning, endReasoning: ui.endReasoning, onUsage: ui.onUsage, onResolvedModel: ui.onResolvedModel, onErrorAction: ui.onErrorAction,
    onMutate: () => { turnMutated = true; }, signal: activeAbort?.signal,
    // Auto-verify + self-correct after a file-changing turn — ALWAYS on (not a setting). Suppressed only
    // in Plan mode, which is read-only by definition. Apply turns (heavy-mode results) verify too — they
    // write files, so confirming them is just as valuable. The agent also decides, via the `verify` tool,
    // when to run wider checks (tests/build) for the task at hand.
    verify: cfg.planMode ? undefined : autoVerify,
    policy: policy.rules,
    approvals,
    hooks: hooks.hooks,
    hookExec,
    // The LLM router: offer Solo the escalate tool only when auto-route is on. Callers can force it off
    // (apply turns) so a heavier mode's own result can't recursively re-escalate.
    canEscalate: overrides?.canEscalate ?? cfg.autoRoute,
    // Parallel subagents: offer the spawn tool only when enabled; forced off on apply turns (no nesting).
    // Per-subagent progress drives both the inline meter (workerProgress) and the footer registry.
    canSpawn: overrides?.canSpawn ?? cfg.subagents,
    // Write-subagents: opt-in via OB1_SUBAGENTS_WRITE, high-risk (parallel edits). Forced off on apply turns.
    canSpawnWrite: overrides?.canSpawnWrite ?? /^(1|true|on)$/i.test(process.env.OB1_SUBAGENTS_WRITE ?? ""),
    onWorkerEvent: workerProgress,
    agentReg,
  };
}

/** Parse a positive-integer env override, falling back to `def` for missing OR malformed values. A bare
 *  Number()/Math.max(1, Number()) yields NaN for e.g. "two", and NaN then poisons the mode loops — Council's
 *  `for (r=1; r<=NaN; …)` never runs, leaving an empty rounds[] and a `rounds[len-1]` crash; eval/personas
 *  trial/round counts behave the same way. */
function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function promptStr(): string {
  const m = modeColor(cfg.mode);
  const phase = cfg.planMode ? c.yellow("plan") : c.green("act");
  return `${m(cfg.mode)} ${c.dim("·")} ${phase} ${c.cyan("›")} `;
}

const HELP = `
${c.bold("Commands")}
  ${c.cyan("/help")}                 show this help
  ${c.cyan("/clear")}                reset the conversation context ${c.dim("(previous kept in /resume)")}
  ${c.cyan("/resume")} ${c.dim("[n]")}           reopen a previous conversation ${c.dim("(↑↓ · Enter)")} — saved per workspace
  ${c.cyan("/export")} ${c.dim("[file|clipboard]")}  write the conversation to a markdown file ${c.dim("(or copy it)")}
  ${c.cyan("/exit")} ${c.dim("|")} ${c.cyan("/quit")}          exit the session

  ${c.bold("Model & mode")}
  ${c.cyan("/models")} ${c.dim("|")} ${c.cyan("/model")}       pick a model or provider ${c.dim("(↑↓ · Enter)")}; ${c.bold("FreeLLMAPI")} gives free/local models, frontier models need a subscription
  ${c.cyan("/mode")} ${c.dim("[m]")}             pick a mode ${c.dim("(↑↓ · Enter)")} or /mode solo|fusion|council|personas ${c.dim("— heavy modes stay on (sticky); /solo exits")}
  ${c.cyan("/solo")}                 exit a heavy mode (fusion/council/personas) → back to Solo
  ${c.cyan("/plan")} ${c.dim("|")} ${c.cyan("/act")}           toggle read-only Plan vs Act mode
  ${c.cyan("/effort")} ${c.dim("[low|medium|high]")}  reasoning effort ${c.dim("(↑↓ · Enter)")} — thinking budget for models that support it ${c.dim("(default medium)")}

  ${c.bold("Provider & plan")}
  ${c.cyan("/freellm")}              set up / manage the Free LLM API proxy ${c.dim("(↑↓ · Enter)")} — OB-1 can download, run + wire it for you
  ${c.cyan("/upgrade")}              subscribe or manage your plan — opens pricing already signed in to your account

  ${c.bold("Permissions & safety")}
  ${c.cyan("/permission")} ${c.dim("[ask|autopilot]")}  approval mode ${c.dim("(↑↓ · Enter)")}: ask before each change, or autopilot (no prompts)
  ${c.cyan("/sandbox")} ${c.dim("[m]")}          pick shell sandbox ${c.dim("(↑↓ · Enter)")}: off | read-only | workspace-write
  ${c.cyan("/trust")}                trust this workspace (allow autopilot here)
  ${c.cyan("/allow")} ${c.dim("<what>")}         standing approval so the gate stops re-prompting ${c.dim("(e.g. /allow git · /allow write src/ · /allow list · /allow clear)")}

  ${c.bold("Context & workspace")}
  ${c.cyan("/compact")} ${c.dim("[focus]")}       summarize earlier turns to free context ${c.dim("(auto-runs near the model's window; /compact focus on X to steer it)")}
  ${c.cyan("/context")}              token usage vs the model's window + where auto-compaction triggers
  ${c.cyan("/diff")}                 show uncommitted git changes
  ${c.cyan("/init")} ${c.dim("[force]")}         generate ${c.dim("AGENTS.md")} (project guide) from the codebase
  ${c.cyan("/repomap")} ${c.dim("[on|off]")}     repo map in context ${c.dim("(↑↓ · Enter)")} — auto codebase structure, refreshed as files change ${c.dim("(on by default)")}
  ${c.cyan("/rewind")} ${c.dim("[n]")}           restore code &/or conversation to an earlier prompt ${c.dim("(auto-checkpoint before each prompt · shadow git, your repo untouched)")}
  ${c.cyan("/map")}                  ranked repository map (symbols by centrality)
  ${c.cyan("/memory")}               list facts + relationships
  ${c.cyan("/memory add")} <text>    remember a fact
  ${c.cyan("/memory search")} <q>    keyword-search facts
  ${c.cyan("/memory log")} <id>      show a fact's revision history
  ${c.cyan("/memory graph")}         print the relationship graph
  ${c.cyan("/memory export")} [dot|html]  write the graph to .ob1/memory-graph.* (DOT or self-contained HTML)
  ${c.cyan("/memory evolve")} on|off  consolidate new facts (add/update/supersede/dedup) instead of just appending
  ${c.cyan("/memory reflect")} on|off  distil accumulated facts into higher-level insights (reflection trees)
  ${c.cyan("/memory autolink")} on|off  auto-link related facts on write (rides /memory evolve)
  ${c.cyan("/quality")} ${c.dim("[normal|strict|off|show|scenarios]")}  task-quality contract + evidence ledger
  ${c.cyan("/usage")}                monthly credit pool + token/cost analytics

  ${c.bold("Orchestration modes")}
  ${c.cyan("/goal")} ${c.dim("<condition>")}     keep working until a condition is met ${c.dim("(bounded loop · ESC or /goal stop)")}
  ${c.cyan("/autoroute")} ${c.dim("[on|off]")}   Solo auto-routing ${c.dim("(↑↓ · Enter)")} — Solo itself decides (via the escalate tool) when a turn needs a heavier mode ${c.dim("(off by default)")}
  ${c.cyan("/subagents")} ${c.dim("[on|off]")}   parallel subagents ${c.dim("(↑↓ · Enter)")} — Solo may fan out independent read-only sub-tasks; watch them in the footer ${c.dim("(on by default)")}
  ${c.cyan("/route")} <task>         one-shot adaptive: Solo first, escalate only if the task warrants it AND the check fails
  ${c.cyan("/fanout")} <task>        multi-mind: N isolated workers + synthesis (~Nx tokens)
  ${c.cyan("/council")} <task>       author ↔ reviewer revise rounds (≤3) → comprehensive finalizer
  ${c.cyan("/personas")} <task>      goal → expert panel dialogue → facilitator finalizes
  ${c.cyan("/eval")} ${c.dim("[modes…]")}        compute-matched eval: does each mode beat Solo at equal tokens?
  ${c.cyan("/codeact")} <task>       run a task in code-as-action mode (model emits code, sandboxed)

  ${c.bold("Tools & integrations")}
  ${c.cyan("/verify")} ${c.dim("[scope]")}       run the project's checks now ${c.dim("(auto | all | typecheck,test,build,lint)")} — OB-1 also auto-verifies & self-corrects after every file-changing turn
  ${c.cyan("/mcp")}                  list connected MCP servers + their tools
  ${c.cyan("/skills")}               list skills ${c.dim("(✦learned + usage)")} · ${c.cyan("/skills learn on|off")} auto-learn · ${c.cyan("/skills curate")} · ${c.cyan("/skills rm <name>")}
  ${c.cyan("/skill")} ${c.dim("[name]")}        pick a skill ${c.dim("(↑↓ · Enter)")} or /skill <name>
  ${c.cyan("/agents")} ${c.dim("[cmd]")}         project memory index — show/update/episodes/review/promote/regen ${c.dim("(↑↓ · Enter)")}

${c.bold("Account")} ${c.dim("(shell)")}
  ${c.bold("ob1 onboard")}           guided setup: sign in + connect a model provider (Free LLM API)
  ${c.bold("ob1 login")}             sign in to the managed OB-1 server (free models; web search on the paid plan)
  ${c.bold("ob1 logout")}            remove the local token

${c.bold("Inline")} ${c.dim("(type at the prompt)")}
  ${c.cyan("!")}${c.dim("<command>")}            run a shell command directly ${c.dim("(your command, not the model's)")}
  ${c.cyan("@")}${c.dim("<path>")}               attach a file/dir to your message ${c.dim("(pulled into context)")}

${c.bold("Keys")} ${c.dim("(TUI)")}
  ${c.cyan("⌃O")}                    toggle showing the model's reasoning
  ${c.cyan("⌃P")}                    manage running bash processes ${c.dim("(↑↓ · x kill · Esc close)")}
  ${c.cyan("Esc")}                   stop the current turn ${c.dim("(also kills running bash)")}
  ${c.cyan("⌃C")}                    clear the typed prompt; on an empty prompt, exit OB-1
`;

function showMemory(): void {
  const facts = store.listFacts();
  const rels = store.listRelationships();
  console.log(c.bold("\n  Facts"));
  if (!facts.length) console.log(c.dim("    (none yet)"));
  for (const f of facts) console.log(`    ${c.gray("#" + f.id)} ${f.fact}`);
  console.log(c.bold("\n  Relationships"));
  if (!rels.length) console.log(c.dim("    (none yet)"));
  for (const e of rels) console.log(`    ${c.cyan(e.src)} ${c.dim("--" + e.rel + "-->")} ${c.cyan(e.dst)}`);
  const s = store.stats();
  console.log(c.dim(`\n  ${s.facts} facts · ${s.archived} archived · ${s.entities} entities · ${s.edges} edges\n`));
}

const cacheWarn = (): void => { if (history.length) console.log(c.yellow("  ⚠ switching mid-session invalidates the prompt cache (R1) — /clear to reset context.")); };

// Next-step suggestion: after a turn, ask the CURRENT model for the single most likely next user
// message and show it as the input placeholder (Tab accepts). Best-effort + cancellable; built from
// the last exchange (extracted text, NOT a history slice — slicing could break tool_use/result pairing).
let suggestAbort: AbortController | null = null;
function lastUserText(): string {
  for (let i = history.length - 1; i >= 0; i--) { const m = history[i]; if (m.role === "user" && typeof m.content === "string") return m.content; }
  return "";
}
function lastAssistantText(): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const t = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      if (t) return t;
    }
  }
  return "";
}
// On by default; OB1_SUGGEST=off|0|false disables it (a quiet env kill-switch, not a settings entry).
const suggestEnabled = (): boolean => !/^(0|false|off)$/i.test(process.env.OB1_SUGGEST ?? "");
async function generateSuggestion(): Promise<void> {
  if (!suggestEnabled() || !ctrl) return;
  const lastUser = lastUserText(), lastAssistant = lastAssistantText();
  if (!lastUser || !lastAssistant) return; // nothing to base a suggestion on (e.g. a tool-only/empty turn)
  suggestAbort?.abort();
  const ac = new AbortController(); suggestAbort = ac;
  try {
    const resp = await callModel({
      provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, model: cfg.model, maxTokens: 64, effort: "low", openrouter: isOpenRouterEndpoint(cfg),
      system: "You predict the user's likely NEXT message in a coding session. Output ONLY that message — concrete, imperative, ≤12 words, no quotes, no preamble, no options. If nothing sensible follows, output nothing.",
      messages: [{ role: "user", content: `My last request: ${lastUser}\n\nYour response:\n${lastAssistant.slice(0, 1500)}\n\nWhat's the single most likely thing I'd ask you to do next? Reply with ONLY that short message.` }],
      signal: ac.signal,
    });
    if (ac.signal.aborted) return;
    const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      .trim().split("\n")[0].replace(/^["'`]|["'`]$/g, "").trim().slice(0, 120);
    if (text && !ac.signal.aborted) ctrl.setSuggestion(text);
  } catch { /* best-effort — a failed/again-routed suggestion is silently dropped */ }
}

// ── subscription / managed-server awareness ───────────────────────────────────
// Frontier models are served by the managed OB-1 server on the signed-in user's plan credits (the
// server proxies the upstream provider — the client never names or talks to it directly). The picker
// needs to know the plan so it can: show frontier models as usable when subscribed, or locked → pricing
// when free.
export interface UsageWindow { cap: number; used: number }
export interface PlanStatus {
  plan: string;
  credits_remaining?: number;
  credits_per_month?: number;
  month?: UsageWindow;
}
/** The signed-in user's plan via the managed server. null = couldn't tell (offline / not signed in) →
 *  treated as free for gating, but never blocks the picker. Re-fetched each time the picker opens (a
 *  quick call, and it must reflect a just-completed subscription) with a short timeout. */
async function fetchPlan(timeoutMs = 4000): Promise<PlanStatus | null> {
  const token = loadAuthToken();
  if (!token) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${ob1ServerUrl()}/v1/billing/status`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    return r.ok ? (await r.json()) as PlanStatus : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
const isSubscribed = (p: PlanStatus | null): boolean => !!p && p.plan !== "free";

/** Push the signed-in user's MONTHLY credit usage into the footer (rendered as a bar like the context
 *  meter) when on a paid managed plan — and clear it (so the $ cost shows instead) on free/BYOK. Best-
 *  effort + bounded; called at TUI start and after each model turn so the bar tracks credits as spent. */
async function refreshSubscriptionFooter(): Promise<void> {
  if (!ctrl) return;
  const onManaged = !cfg.providerProfile && cfg.provider === "openai" && cfg.baseUrl.startsWith(ob1ServerUrl());
  if (!onManaged) { ctrl.setSubscription(false); return; }
  const plan = await fetchPlan(4000);
  if (!isSubscribed(plan)) { ctrl.setSubscription(false); return; }
  const cap = plan!.month?.cap ?? plan!.credits_per_month ?? 0;
  const used = plan!.month?.used ?? Math.max(0, (plan!.credits_per_month ?? 0) - (plan!.credits_remaining ?? 0));
  ctrl.setSubscription(true, used, cap);
}

/** Check whether the saved managed-server token actually works, distinguishing a REJECTED token (401 —
 *  expired / account reset) from a server we just can't reach, so startup re-prompts login only when the
 *  token is genuinely bad (and never nags when the server is merely down). */
async function validateAuth(timeoutMs = 3000): Promise<"ok" | "unauthorized" | "unreachable" | "no-token"> {
  const token = loadAuthToken();
  if (!token) return "no-token";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${ob1ServerUrl()}/v1/billing/status`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    if (r.status === 401) return "unauthorized";
    return r.ok ? "ok" : "unreachable"; // other non-OK → treat as transient, don't force a re-login
  } catch { return "unreachable"; } finally { clearTimeout(timer); }
}

/** Render the managed-server plan usage as terminal lines: the monthly credit pool (the only limit) as
 *  used/cap with a small meter, plus credits remaining. Returns [] when not on a paid plan so /usage
 *  can fall back to local analytics only. */
function formatPlanUsage(p: PlanStatus | null): string[] {
  if (!p || p.plan === "free") return [];
  const money = (n = 0) => `$${n.toFixed(2)}`;
  const meter = (used = 0, cap = 0, w = 16) => {
    const frac = cap > 0 ? Math.max(0, Math.min(1, used / cap)) : 0;
    const fill = Math.round(frac * w);
    return `${"█".repeat(fill)}${"░".repeat(w - fill)}`;
  };
  const row = (label: string, win?: UsageWindow) =>
    `    ${label.padEnd(10)} ${c.cyan(meter(win?.used, win?.cap))}  ${money(win?.used).padStart(7)} / ${money(win?.cap)}`;
  return [
    c.bold(`  ${p.plan.charAt(0).toUpperCase() + p.plan.slice(1)} plan`) + c.dim(`  ·  ${money(p.credits_remaining)} of ${money(p.credits_per_month)} monthly credits left`),
    row("month", p.month ?? { cap: p.credits_per_month ?? 0, used: Math.max(0, (p.credits_per_month ?? 0) - (p.credits_remaining ?? 0)) }),
    "",
  ];
}

/** Open the server's pricing page in the browser, ALREADY SIGNED IN when possible: trade the CLI token
 *  for a one-time web-login URL (so "Choose a plan" goes straight to Stripe on the user's account). Falls
 *  back to the plain /pricing page. Shared by the model picker (free user picks a frontier model) and the
 *  footer upsell. */
async function openPricingPage(next = "/pricing"): Promise<void> {
  const { openBrowser } = await import("./cli/login.ts");
  const server = ob1ServerUrl();
  let url = `${server}${next}`;
  const token = loadAuthToken();
  if (token) {
    try {
      const r = await fetch(`${server}/v1/web-login`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ next }),
      });
      const b = await r.json().catch(() => ({})) as { url?: string };
      if (r.ok && b.url) url = b.url;
    } catch { /* fall back to the plain pricing page */ }
  }
  openBrowser(url);
  (ctrl?.pushLine ?? ((s: string) => console.log(s)))(c.dim(`  ↗ opening pricing in your browser — ${server}${next}`));
}

/** Poll the managed server's billing status after the user starts a checkout, so the CLI reflects a new
 *  subscription WITHOUT a restart: once the plan goes active we clear the stale "upgrade" banner and print
 *  a confirmation. Bounded to ~5 min; a no-op if already watching or not on the managed server. */
let subWatch: ReturnType<typeof setInterval> | undefined;
function watchForSubscription(): void {
  if (subWatch || !loadAuthToken()) return;
  ctrl?.pushLine(c.dim("  ⏳ waiting for checkout to complete in your browser… (this updates automatically)"));
  const started = Date.now();
  subWatch = setInterval(async () => {
    if (Date.now() - started > 5 * 60_000) { clearInterval(subWatch!); subWatch = undefined; return; }
    const plan = await fetchPlan(4000);
    if (isSubscribed(plan)) {
      clearInterval(subWatch!); subWatch = undefined;
      ctrl?.setErrorAction(undefined); // the upgrade banner is no longer relevant
      const name = plan!.plan.charAt(0).toUpperCase() + plan!.plan.slice(1);
      ctrl?.pushLine(c.green(`  ✓ Subscription active — you're on the ${name} plan. Frontier models unlocked.`));
    }
  }, 5000);
  // Don't let this poller keep the process alive: if the user exits before checkout completes (or the
  // 5-min cap), an un-unref'd interval would hang the process — polling every 5s — instead of exiting.
  subWatch.unref?.();
}

/** Point the CLI at the managed OB-1 server (the subscription path) with `model`, switching back from a
 *  FreeLLMAPI/other profile if needed. The server proxies every frontier model on the user's credits, so
 *  there's no key to enter. Mirrors persistSubscription on disk (clears the active profile, keeps the
 *  per-provider cred memory) and updates the live config + status. */
function switchToManaged(model: string): void {
  cacheWarn();
  cfg.provider = "openai";
  cfg.baseUrl = `${ob1ServerUrl()}/v1`;
  cfg.apiKey = loadAuthToken();
  cfg.providerProfile = undefined;
  cfg.model = model;
  cfg.resolvedModel = undefined;
  ctrl?.setStatus({ model, resolvedModel: undefined, estTok: false });
  persistSubscription(cfg.settingsDir, model); // clears the profile on disk; keeps the per-provider cred map
  console.log(`  model → ${c.cyan(model)}  ${c.dim(describeModel(model))}`);
}

/** Set up a provider profile (FreeLLMAPI = free proxy): the setup "tab" prompts
 *  for the URL + key, tests the connection live, then configures + persists it (global
 *  ~/.ob1/settings.json). Switching keeps the OTHER provider's creds remembered, so you can flip
 *  free⇄paid without re-entry. Returns true on success. Reached from the /models group menu. */
async function setupProvider(prof: ProviderProfile = FREELLMAPI): Promise<boolean> {
  if (!ui.providerSetup) { console.log(c.yellow("  provider setup needs an interactive session")); return false; }
  const active = cfg.providerProfile === prof.id;
  const remembered = savedProviderCreds(cfg.settingsDir)[prof.id]; // last key entered for THIS provider
  // A profile that wants the model typed (Custom/LAN) prefills the current model if we're editing it, else blank.
  const initialModel = prof.needsModel ? (active && cfg.model && cfg.model !== prof.defaultModel ? cfg.model : "") : undefined;
  const res = await ui.providerSetup({
    title: `Connect ${prof.name}`,
    blurb: [prof.tagline, "", ...prof.blurb, "", `Docs: ${prof.docsUrl}`],
    presets: prof.presets,
    keyPrefix: prof.keyPrefix,
    keyOptional: prof.keyOptional,
    collectModel: prof.needsModel,
    initialModel,
    modelPlaceholder: prof.needsModel ? "e.g. ornith, llama3.1, qwen2.5-coder" : undefined,
    initialUrl: (active ? cfg.baseUrl : remembered?.url ?? "") || prof.defaultLocalUrl,
    initialKey: active ? (cfg.apiKey ?? "") : (remembered?.key ?? ""),
    onTest: async (url, key) => {
      const u = normalizeBaseUrl(url);
      const r = await fetchModels(u, key);
      return r.ok
        ? `✓ connected to ${u} — ${r.models.length} model(s) available`
        : `✗ ${r.status ? `HTTP ${r.status} — ` : ""}${(r.error ?? "connection failed").split("\n")[0].slice(0, 120)}`;
    },
  });
  if (!res) { console.log(c.dim("  provider setup cancelled")); return false; }
  const url = normalizeBaseUrl(res.url);
  cacheWarn();
  cfg.provider = prof.wire;
  cfg.baseUrl = url;
  cfg.apiKey = res.key || undefined; // key is optional (a keyless local/LAN endpoint) → undefined, not ""
  cfg.providerProfile = prof.id;
  // Model: a typed one (Custom) wins; otherwise a first-time connect adopts the profile default.
  if (res.model) cfg.model = res.model;
  else if (!active) cfg.model = prof.defaultModel;
  cfg.resolvedModel = undefined; ctrl?.setStatus({ model: cfg.model, resolvedModel: undefined, estTok: false }); // new provider → drop stale resolution/est marker
  console.log(`  provider → ${c.cyan(prof.name)}  ${c.dim(url)}`);
  saveSettings(cfg); // persist active provider + per-provider creds + model (global ~/.ob1/settings.json — shared across folders)
  const note = prof.id === "freellmapi" ? " (auto = the proxy picks the best free model)"
    : prof.id === "custom" && !cfg.apiKey ? " (no key — sent without auth)" : "";
  console.log(c.green(`  ✓ ${prof.name} connected — model: ${c.bold(cfg.model || "(none set)")}${note}. Saved to ~/.ob1/settings.json (shared across every folder).`));
  return true;
}

/** Make `prof` the active provider, switching from another if needed. Uses, in order: creds remembered
 *  from a previous setup, then the shipped baked-in key (OpenRouter — so paid models need no setup).
 *  Only a provider with neither (the self-hosted FreeLLMAPI proxy) falls through to the setup form.
 *  Returns false if that setup was cancelled. The model is left at the profile's default after a switch
 *  — the caller's picker sets the real one next. */
async function ensureProvider(prof: ProviderProfile): Promise<boolean> {
  if (cfg.providerProfile === prof.id && (cfg.apiKey || prof.keyOptional)) return true; // already active
  const creds = savedProviderCreds(cfg.settingsDir)[prof.id] ?? bakedProviderCreds(prof.id);
  // Activate remembered creds when there's a key OR the profile allows none (a keyless Custom/LAN endpoint
  // is remembered with an empty key, which still pins its URL). The key-optional path also needs a URL.
  if (creds && (creds.key || (prof.keyOptional && creds.url))) {
    cacheWarn();
    cfg.provider = prof.wire;
    cfg.baseUrl = creds.url || prof.defaultLocalUrl;
    cfg.apiKey = creds.key || undefined;
    cfg.providerProfile = prof.id;
    cfg.model = prof.defaultModel; // sensible default for the new provider; the picker sets the real model next
    cfg.resolvedModel = undefined; ctrl?.setStatus({ model: cfg.model, resolvedModel: undefined, estTok: false });
    saveSettings(cfg);
    console.log(`  provider → ${c.cyan(prof.name)}  ${c.dim(cfg.baseUrl)}`);
    return true;
  }
  return await setupProvider(prof); // never configured + no baked key → prompt for it
}

/** Make FreeLLMAPI the active provider, OFFERING the managed setup first when nothing is configured yet.
 *  This is the difference from the bare ensureProvider(): reached from the model picker (/models →
 *  → Free LLM API), a first-time user should be offered "OB-1 downloads + runs + wires the proxy for you"
 *  (clone→run→auto-wire from the repo) — not dropped straight onto a manual URL/key form. Once a proxy is
 *  managed or creds are remembered, it just activates them (via ensureProvider). Returns true when active. */
async function ensureFreeLLM(): Promise<boolean> {
  if (cfg.providerProfile === FREELLMAPI.id && cfg.apiKey) return true; // already connected
  const { loadManaged } = await import("./cli/freellm-manage.ts");
  const haveCreds = !!(savedProviderCreds(cfg.settingsDir)[FREELLMAPI.id]?.key ?? bakedProviderCreds(FREELLMAPI.id)?.key);
  // First time, and OB-1 isn't already running a managed proxy → offer managed (default) vs manual.
  if (!loadManaged()?.managed && !haveCreds && ui.pick) {
    const a = await ui.pick("Free LLM API — not set up yet", [
      { label: "set up (managed)", hint: "OB-1 downloads, runs + wires the proxy for you — right here", value: "setup" },
      { label: "connect manually", hint: "enter a URL + key yourself", value: "manual" },
    ]);
    if (a == null) return false;                              // cancelled — leave the provider unchanged
    if (a === "manual") return await setupProvider(FREELLMAPI);
    await runManagedFreeLLMSetup();                           // clone → run → auto-wire (persists creds on success)
    // Proceed only if setup actually wired creds; on failure it already explained why and we stop here.
    if (!savedProviderCreds(cfg.settingsDir)[FREELLMAPI.id]?.key) return false;
  }
  return await ensureProvider(FREELLMAPI); // activate the (now-)remembered creds into the live session
}

/** FREE source: the FreeLLMAPI proxy's LIVE catalog (auto = the proxy's router), plus a reconnect row.
 *  Switches to FreeLLMAPI first if a different provider is active. No typing — arrow-key selection. */
async function pickFreeModel(): Promise<void> {
  if (!ui.pick) return;
  if (!(await ensureFreeLLM())) return;
  const conn = await fetchModels(cfg.baseUrl, cfg.apiKey ?? "");
  const items: { label: string; hint?: string; value: string }[] = [];
  if (conn.ok) {
    for (const m of conn.models.filter((x) => x.available !== false)) {
      const hint = `${m.name ?? ""}${m.contextWindow ? `${m.name ? " · " : ""}${(m.contextWindow / 1000).toFixed(0)}k ctx` : ""}`.trim();
      items.push({ label: m.id + (m.id === FREELLMAPI.defaultModel ? " (default · router)" : ""), hint: hint || undefined, value: m.id });
    }
  } else {
    console.log(c.yellow(`  ⚠ couldn't list models (${conn.error ?? "offline"}) — keeping "${cfg.model}".`));
    items.push({ label: FREELLMAPI.defaultModel + " (default · router)", hint: "the proxy picks the best available model", value: FREELLMAPI.defaultModel });
  }
  items.push({ label: "↻ change connection (URL / key)…", value: "__reconnect__" });
  const picked = await ui.pick(`${FREELLMAPI.name} — pick a model  ↑↓ · Enter · ← back · Esc  ·  auto = proxy router`, items, cfg.model);
  if (picked == null) return;
  if (picked === "__reconnect__") { await setupProvider(FREELLMAPI); return; }
  if (picked === cfg.model) { console.log(c.dim(`  model unchanged (${cfg.model})`)); return; }
  cacheWarn();
  cfg.model = picked; ctrl?.setStatus({ model: picked, resolvedModel: undefined, estTok: false });
  console.log(`  model → ${c.cyan(picked)}`);
}

/** The single model/provider entry point (/models · /model · the Settings "model" row). Level one is
 *  the frontier models themselves (Claude, GPT, Gemini, …) PLUS one "Free LLM API ▸" sibling that
 *  expands into the free proxy's own catalog. Frontier models are served by the managed OB-1 server on
 *  the user's subscription credits — no provider/key to configure, and OpenRouter is never surfaced (the
 *  server proxies it). A SUBSCRIBED user picks a frontier model and it just switches the active model on
 *  the managed server. A FREE user still SEES every frontier model (locked) — picking one opens pricing.
 *  Picking Free LLM API drills into the proxy router (auto); ← from that subgroup returns here. */
async function pickModel(): Promise<void> {
  if (!ui.pick) return;
  const plan = await fetchPlan();
  const subscribed = isSubscribed(plan);
  while (true) {
    const onFree = cfg.providerProfile === FREELLMAPI.id;
    const onCustom = cfg.providerProfile === CUSTOM.id;
    const items: { label: string; hint?: string; value: string }[] = MODELS.map((m) => ({
      label: m.label + (m.notes === "default" ? " (default)" : "") + (subscribed ? "" : "  🔒"),
      hint: subscribed
        ? `${(m.contextWindow / 1000).toFixed(0)}k ctx · ${(m.maxOutput / 1000).toFixed(0)}k out`
        : "frontier model — subscribe to unlock",
      value: m.id ?? m.label,
    }));
    items.push({ label: "Free LLM API ▸", hint: "free · ~16 providers via the proxy router (auto)", value: "__free__" });
    items.push({ label: "Custom endpoint ▸", hint: onCustom ? `connected · ${cfg.model || "no model"} · ${cfg.baseUrl}` : "your own OpenAI-compatible server — local/LAN (Ollama, llama.cpp, vLLM…); key optional", value: "__custom__" });
    const title = subscribed
      ? "Select a model  ↑↓ · Enter · Esc"
      : "Select a model  ↑↓ · Enter · Esc  ·  🔒 = subscribe to unlock";
    const initial = onCustom ? "__custom__" : (onFree || (!cfg.apiKey && !subscribed)) ? "__free__" : cfg.model;
    const picked = await ui.pick(title, items, initial);
    if (picked == null) return;
    if (picked === "__free__") { await pickFreeModel(); if (ui.pickReason?.() === "back") continue; return; }
    if (picked === "__custom__") { await setupProvider(CUSTOM); return; } // collects URL + model id (+ optional key)
    // A frontier model.
    if (!subscribed) {
      // Free (or signed-out) user — frontier models are gated. Take them to pricing instead of selecting.
      console.log(c.dim("  🔒 Frontier models need a subscription — opening pricing…"));
      await openPricingPage();
      return;
    }
    // Subscribed → served by the managed OB-1 server. Make it the active provider (switch back from a
    // FreeLLMAPI profile if needed), then set the model. No key prompt, no OpenRouter.
    const onManaged = !cfg.providerProfile && cfg.provider === "openai" && cfg.baseUrl.startsWith(ob1ServerUrl());
    if (onManaged && picked === cfg.model) { console.log(c.dim(`  model unchanged (${cfg.model})`)); return; }
    switchToManaged(picked);
    return;
  }
}

// One-line description of what each mode does — shown after a switch and as a picker hint.
function modeNote(m: Mode): string {
  return m === "fusion" ? "each task → N same-prompt candidates, auto-scored, synthesizer merges the best parts"
    : m === "council" ? "each task → author ↔ reviewer revise rounds, then a comprehensive finalizer"
    : m === "personas" ? "each goal → a tailored expert panel dialogue, then facilitator synthesis"
    : m === "adaptive" ? "Solo first; escalate only when the task warrants deeper analysis AND the objective check fails"
    : "one model, one pass — the frugal default";
}
// Rough cost multiplier shown in the per-turn "still in <mode>" reminder — these modes fan out into
// several model calls, so a stray heavy turn is expensive. Approximate, by design (depends on the task).
function modeCostHint(m: Mode): string {
  return m === "fusion" ? "~3× cost — candidates + synthesis"
    : m === "council" ? "~3× cost — author ↔ reviewer rounds"
    : m === "personas" ? "~5× cost — multi-expert panel"
    : "";
}
/** Set when a heavy mode is freshly selected, so the FIRST turn after selection skips the "still in …"
 *  reminder (the user just chose it); every later turn shows it. Consumed in processLine. */
let modeJustSet = false;
/** Apply a mode switch and echo it with its description (shared by /mode and the pickers). */
function setMode(m: Mode): void {
  cfg.mode = m;
  modeJustSet = true;
  const sticky = m === "solo" ? "" : c.dim("  · stays on until you switch (/solo to exit)");
  console.log(`  mode → ${modeColor(m)(m)}${m === "solo" ? "" : c.dim("  (" + modeNote(m) + ")") + sticky}`);
}

/** Set the reasoning effort (low/medium/high) for THIS session. Persisted so it survives restarts, and
 *  re-locked here deliberately (effort is otherwise fixed at startup for prompt-cache stability). Tells
 *  the user when the active model can't use it, or reasons but hides the trace. */
function setEffort(e: Effort): void {
  cfg.effort = e;
  saveSettings(cfg);
  ctrl?.setStatus({ effort: e });
  const cap = modelReasoning(cfg.model);
  const note = !cap ? c.dim(`  — ${modelSpec(cfg.model)?.label ?? cfg.model} has no reasoning, so this is ignored`)
    : !cap.visible ? c.dim("  (this model reasons but hides its trace — ⌃O won't show it)")
    : "";
  console.log(`  effort → ${c.yellow(e)}${note}`);
}

function setQualityMode(q: QualityMode): void {
  cfg.qualityMode = q;
  saveSettings(cfg);
  const note = q === "strict"
    ? " — missing required evidence marks the run blocked"
    : q === "normal"
      ? " — compact contract + evidence ledger"
      : " — quality contract disabled";
  console.log(`  quality → ${q === "off" ? "off" : c.yellow(q)}${c.dim(note)}`);
}

// ─── Per-setting pickers ───────────────────────────────────────────────────────
// Each opens the same arrow-key list — no typing (↑↓ navigate · ↵/→ select · ←/Esc back). Shared by
// /models and by the bare /mode · /sandbox · /skill · /agents commands on a TTY. The TUI footer
// shows the keys, so titles stay terse.
async function pickMode(): Promise<void> {
  if (!ui.pick) return;
  const topo: Mode[] = ["solo", "fusion", "council", "personas"];
  const items: { label: string; hint?: string; value: string }[] = topo.map((x) => ({ label: x, hint: modeNote(x), value: x }));
  // Plan/act is part of HOW a turn runs, so it lives in the mode picker (not a separate setting).
  items.push({
    label: cfg.planMode ? "→ switch to Act" : "→ switch to Plan (read-only)",
    hint: `phase: currently ${cfg.planMode ? "plan — investigate only" : "act — edits allowed"}`,
    value: "__phase__",
  });
  const m = await ui.pick("Mode", items, cfg.mode);
  if (!m) return;
  if (m === "__phase__") { cfg.planMode = !cfg.planMode; console.log(cfg.planMode ? c.yellow("  Plan mode (read-only)") : c.green("  Act mode")); }
  else setMode(m as Mode);
}
async function pickSandbox(): Promise<void> {
  if (!ui.pick) return;
  const s = await ui.pick("Sandbox", [
    { label: "off", hint: "no sandbox — the shell runs unrestricted", value: "off" },
    { label: "read-only", hint: "block every write", value: "read-only" },
    { label: "workspace-write", hint: "writes confined to the workspace", value: "workspace-write" },
  ], cfg.sandbox);
  if (s) { cfg.sandbox = s as SandboxMode; console.log(`  sandbox → ${s === "off" ? s : c.yellow(s)}${c.dim(sandboxNote(s as SandboxMode))}`); }
}
async function pickPermission(): Promise<void> {
  if (!ui.pick) return;
  const p = await ui.pick("Permission", [
    { label: "ask", hint: "prompt before every mutating tool", value: "ask" },
    { label: "autopilot", hint: "execute without asking — the default; use with care", value: "autopilot" },
  ], cfg.permissionMode);
  if (p) { cfg.permissionMode = p as PermissionMode; console.log(`  permission → ${p === "autopilot" ? c.yellow("autopilot (no prompts)") : "ask"}`); }
}
async function pickEffort(): Promise<void> {
  if (!ui.pick) return;
  const cap = modelReasoning(cfg.model);
  const tail = !cap ? c.dim(` — ${modelSpec(cfg.model)?.label ?? cfg.model} has no reasoning (ignored)`)
    : !cap.visible ? c.dim(" — reasons but hides its trace (⌃O won't show it)") : "";
  const e = await ui.pick(`Reasoning effort${tail}`, [
    { label: "low", hint: "fastest, cheapest — a small thinking budget", value: "low" },
    { label: "medium", hint: "balanced (default) — moderate thinking budget", value: "medium" },
    { label: "high", hint: "deepest — a large thinking budget; slower + more tokens", value: "high" },
  ], cfg.effort ?? "medium");
  if (e) setEffort(e as Effort);
}
async function pickAutoRoute(): Promise<void> {
  if (!ui.pick) return;
  const a = await ui.pick("Solo auto-route", [
    { label: "off", hint: "always stay Solo (default) — never auto-escalate", value: "off" },
    { label: "on", hint: "Solo may route a hard/high-stakes turn to Fusion/Council/Personas (it decides)", value: "on" },
  ], cfg.autoRoute ? "on" : "off");
  if (a) { cfg.autoRoute = a === "on"; console.log(`  auto-route ${cfg.autoRoute ? c.yellow("ON") : "off"}${c.dim(" — Solo decides per-turn whether to route to a heavier mode")}`); }
}
async function pickSubagents(): Promise<void> {
  if (!ui.pick) return;
  const a = await ui.pick("Subagents (parallel)", [
    { label: "on", hint: "Solo may fan out independent read-only sub-tasks in parallel (default)", value: "on" },
    { label: "off", hint: "no spawn_subagents tool", value: "off" },
  ], cfg.subagents ? "on" : "off");
  if (a) { cfg.subagents = a === "on"; console.log(`  subagents ${cfg.subagents ? c.yellow("ON") : "off"}${c.dim(" — Solo may spawn parallel read-only subagents for big, splittable tasks")}`); }
}
async function pickRepoMap(): Promise<void> {
  if (!ui.pick) return;
  const a = await ui.pick("Auto repo map", [
    { label: "on", hint: "inject a fresh codebase map into every prompt so the AI knows the structure (default)", value: "on" },
    { label: "off", hint: "don't inject it (the repo_map tool still works on demand)", value: "off" },
  ], cfg.repoMap ? "on" : "off");
  if (a) { cfg.repoMap = a === "on"; console.log(`  repo map ${cfg.repoMap ? c.yellow("ON") : "off"}${c.dim(" — auto codebase structure in context, refreshed as files change")}`); }
}
async function pickQuality(): Promise<void> {
  if (!ui.pick) return;
  const q = await ui.pick("Task quality", [
    { label: "normal", hint: "compact quality contract + .ob1/runs evidence ledger (default)", value: "normal" },
    { label: "strict", hint: "same, but marks the run blocked if required evidence is missing", value: "strict" },
    { label: "off", hint: "no quality contract or run ledger", value: "off" },
  ], cfg.qualityMode);
  if (q) setQualityMode(q as QualityMode);
}
async function pickSkill(): Promise<void> {
  if (!ui.pick) return;
  const sk = listSkills(cfg.cwd);
  if (!sk.length) { console.log(c.dim("  (no skills — add markdown files under skills/ or .ob1/skills/)")); return; }
  const name = await ui.pick("Skill", sk.map((s) => ({ label: s.name, hint: s.description, value: s.name })));
  if (name) { const body = readSkill(cfg.cwd, name); console.log(body ? "\n" + body + "\n" : c.red(`  skill not found: ${name}`)); }
}
async function pickAgents(): Promise<void> {
  if (!ui.pick) return;
  const a = await ui.pick("AGENTS.md", [
    { label: "show", hint: "print the current project index", value: "show" },
    { label: "update", hint: "refresh OB-1 managed sections from repo + memory", value: "update" },
    { label: "episodes", hint: "show recent project-memory episodes", value: "episodes" },
    { label: "review", hint: "show pending memory promotion candidates", value: "review" },
    { label: "promote all", hint: "promote all pending candidates into project memory", value: "promote-all" },
  ]);
  if (a === "show") { const md = loadAgentsMd(cfg.cwd); console.log(md ? "\n" + md + "\n" : c.dim("  (no AGENTS.md)")); }
  else if (a === "update") showAgentsUpdate();
  else if (a === "episodes") showAgentEpisodes();
  else if (a === "review") showAgentCandidates();
  else if (a === "promote-all") promoteAgentCandidates(["all"]);
}

function showAgentsUpdate(): void {
  const r = refreshAgentsMd(cfg.cwd, loadAgentsMemory(cfg.cwd));
  console.log(r.updated ? c.green("  ✓ refreshed AGENTS.md managed sections") : c.dim("  AGENTS.md already current (or human-owned; no managed blocks changed)"));
}

function showAgentEpisodes(): void {
  const eps = listEpisodes(cfg.cwd, 12);
  if (!eps.length) { console.log(c.dim("  no episodes yet — run a task and OB-1 will write .ob1/episodes/*.md")); return; }
  console.log(c.bold("  Recent episodes"));
  for (const ep of eps) console.log(`    ${c.cyan(ep.id)} ${c.dim(ep.ts.slice(0, 10))} — ${ep.task}`);
}

function showAgentCandidates(): void {
  const candidates = listPromotionCandidates(cfg.cwd);
  if (!candidates.length) { console.log(c.dim("  no pending promotion candidates")); return; }
  console.log(c.bold("  Pending memory candidates"));
  for (const cand of candidates) {
    console.log(`    ${c.cyan(cand.id)} ${c.dim(`${cand.kind} · seen ${cand.count}×`)}\n      ${cand.text}`);
  }
  console.log(c.dim("  promote with /agents promote <id> or /agents promote all"));
}

function promoteAgentCandidates(args: string[]): void {
  const target = args[0] === "all" ? "all" : args;
  if (target !== "all" && !target.length) { console.log(c.red("  usage: /agents promote <id>|all")); return; }
  const r = promoteCandidates(cfg.cwd, target);
  if (!r.promoted.length) { console.log(c.dim("  no matching pending candidates")); return; }
  console.log(c.green(`  ✓ promoted ${r.promoted.length} item${r.promoted.length === 1 ? "" : "s"} into project memory`));
}

function rememberTurn(task: string, startLen: number, mode: string): void {
  const slice = history.slice(startLen);
  if (!slice.length) return;
  try {
    const { episode } = rememberEpisode(cfg.cwd, task, mode, slice);
    console.log(c.dim(`  🧭 episode saved: ${episode.id}`));
  } catch {
    /* project memory must never break a turn */
  }
}

/** Run the managed FreeLLMAPI setup (clone → run proxy → dashboard account → auto-wire) INLINE — using
 *  the inline text-prompt for email/password — so it works from inside the live TUI without dropping to
 *  the shell. Same pipeline as `ob1 onboard`'s free path (shared freeLLMSetupFlow); available to free and
 *  paid users alike. */
async function runManagedFreeLLMSetup(): Promise<void> {
  if (!ui.prompt) { console.log(c.dim("  run `ob1 onboard` in your shell to set up the managed Free LLM API proxy")); return; }
  const ask = ui.prompt;
  const { freeLLMSetupFlow } = await import("./cli/onboarding.ts");
  const { openBrowser } = await import("./cli/login.ts");
  await freeLLMSetupFlow({
    ask: async (q, opts) => (await ask({ title: "Set up Free LLM API", question: q, mask: opts?.mask })) ?? "",
    out: (s = "") => console.log(s),
    openUrl: openBrowser,
    waitForDone: async () => { await ask({ title: "Free LLM API", question: "Press Enter when you've added your keys (or to skip)", placeholder: "" }); },
  });
}

/** Manage the OB-1-managed local FreeLLMAPI proxy (status + start/stop/restart/open/manual/unmanage).
 *  Setup runs inline via runManagedFreeLLMSetup (works inside the TUI). */
async function pickFreeLLM(): Promise<void> {
  if (!ui.pick) return;
  const flm = await import("./cli/freellm-manage.ts");
  const { openBrowser } = await import("./cli/login.ts");
  const st = flm.loadManaged();
  if (!st?.managed) {
    const a = await ui.pick("Free LLM API", [
      { label: "set up (managed)", hint: "OB-1 downloads, runs + wires the proxy for you — right here", value: "setup" },
      { label: "connect manually", hint: "enter a URL + key yourself", value: "manual" },
    ]);
    if (a === "manual") await setupProvider(FREELLMAPI);
    else if (a === "setup") await runManagedFreeLLMSetup();
    return;
  }
  const up = await flm.isUp(st.url);
  const nKeys = st.providerKeys ?? 0;
  const status = up ? `running · ${nKeys} provider key${nKeys === 1 ? "" : "s"}` : "stopped";
  const a = await ui.pick(`Free LLM API (${status})`, [
    { label: "open dashboard", hint: `${st.url} — add provider keys here`, value: "open" },
    { label: up ? "restart" : "start", hint: "(re)start the local proxy", value: "restart" },
    { label: "stop", hint: "stop the local proxy", value: "stop" },
    { label: "connect manually", hint: "switch to a manual URL + key instead", value: "manual" },
    { label: "unmanage", hint: "OB-1 stops managing it (won't auto-start)", value: "off" },
  ]);
  if (a === "open") { openBrowser(st.url); console.log(c.dim(`  opened ${st.url}`)); }
  else if (a === "restart") {
    console.log(c.dim("  restarting the proxy…"));
    if (up) flm.stop(st);
    const ok = flm.start(st.dir, st.runtime, st.port) && await flm.waitReady(st.url, fetch, 20000);
    console.log(ok ? c.dim("  ✓ proxy running") : c.yellow("  ✗ couldn't start it — try `ob1 onboard`"));
  } else if (a === "stop") { flm.stop(st); console.log(c.dim("  stopped the proxy")); }
  else if (a === "manual") await setupProvider(FREELLMAPI);
  else if (a === "off") { flm.clearManaged(); console.log(c.dim("  OB-1 no longer manages the proxy (the container/files remain)")); }
}


/** Compact relative time for the /rewind list ("3m ago"). */
function fmtAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** /rewind — restore code and/or conversation to an earlier checkpoint (one per prompt). On a TTY it shows
 *  a picker of prompts, then a Claude-Code-style action menu (code+conversation / code only / conversation
 *  only). In the non-TTY REPL: `/rewind` lists them, `/rewind <n> [code|conv|both]` restores. Code restore
 *  reverts the whole worktree via the shadow repo; conversation restore truncates the in-memory history. */
async function rewindCmd(rest: string[]): Promise<void> {
  if (!cfg.checkpoint) { console.log(c.yellow("  checkpointing is OFF — set OB1_CHECKPOINT=on and restart to enable /rewind.")); return; }
  if (!checkpoints.available()) { console.log(c.yellow("  /rewind needs the `git` binary (checkpoints use a private shadow repo — your real repo is untouched).")); return; }
  const all = checkpoints.list();
  if (!all.length) { console.log(c.dim("  no checkpoints yet — one is saved automatically before each prompt.")); return; }
  const newest = [...all].reverse(); // newest first for display

  // 1. Resolve which checkpoint: explicit arg (1-based index from the list, or an id/sha prefix) or picker.
  let target: Checkpoint | undefined;
  if (rest[0]) {
    const a = rest[0];
    target = (/^\d+$/.test(a) ? newest[Number(a) - 1] : undefined) ?? newest.find((ck) => ck.id.startsWith(a) || ck.sha.startsWith(a));
    if (!target) { console.log(c.red(`  no checkpoint matches "${a}" — run /rewind with no argument to list them.`)); return; }
  } else if (ui.pick) {
    const items = newest.slice(0, 50).map((ck) => ({
      label: `${fmtAgo(ck.ts).padStart(7)}  ${ck.label.slice(0, 60) || "(empty prompt)"}`,
      hint: ck.session === sessionId ? "this session" : "earlier session",
      value: ck.sha,
    }));
    const sha = await ui.pick("Rewind to which prompt?  ↑↓ · Enter · Esc cancel", items);
    if (!sha) return;
    target = newest.find((ck) => ck.sha === sha);
  } else {
    console.log(c.bold("\n  Checkpoints") + c.dim(" (newest first) — /rewind <n> [code|conv|both]:"));
    newest.slice(0, 30).forEach((ck, i) => console.log(`  ${c.cyan(String(i + 1).padStart(2))}  ${c.dim(fmtAgo(ck.ts).padStart(7))}  ${ck.label.slice(0, 70) || c.dim("(empty)")}`));
    console.log("");
    return;
  }
  if (!target) return;
  const sameSession = target.session === sessionId;

  // 2. Choose the action (menu on a TTY; arg or default otherwise).
  let action = "both";
  if (rest[1] && ["both", "code", "conv", "conversation"].includes(rest[1])) action = rest[1] === "conversation" ? "conv" : rest[1];
  else if (ui.pick) {
    const opts = [
      ...(sameSession ? [{ label: "Restore code + conversation", hint: "files and chat", value: "both" }] : []),
      { label: "Restore code only", hint: "files; keep the conversation", value: "code" },
      ...(sameSession ? [{ label: "Restore conversation only", hint: "chat; keep the files", value: "conv" }] : []),
      { label: "Cancel", hint: "", value: "cancel" },
    ];
    const a = await ui.pick(`Restore to "${target.label.slice(0, 40) || "(empty)"}" — what?`, opts);
    if (!a || a === "cancel") return;
    action = a;
  }
  // A past session's conversation isn't in memory, so it can't be restored — fall back to code only.
  if ((action === "both" || action === "conv") && !sameSession) {
    console.log(c.yellow("  ⚠ that checkpoint is from an earlier session — its conversation can't be restored; doing code only."));
    action = "code";
  }
  const doCode = action === "both" || action === "code";
  const doConv = action === "both" || action === "conv";

  // 3. Apply. Code restore overwrites uncommitted work, so confirm and first snapshot the CURRENT state
  //    (so the rewind itself is reversible — /rewind again to undo it).
  if (doCode) {
    const n = checkpoints.changeCount(target.sha);
    if (!(await ui.approve(`revert ${n < 0 ? "" : n + " "}file change(s) in the worktree to "${target.label.slice(0, 40) || "(empty)"}"`))) {
      console.log(c.yellow("  ✗ rewind cancelled — nothing changed.")); return;
    }
    checkpoints.snapshot("(state before rewind)", history.length);
    if (!checkpoints.restoreCode(target.sha)) { console.log(c.red("  ✗ code restore failed (the checkpoint commit may be missing).")); return; }
    invalidateRepoMap();
    console.log(c.green(`  ✓ reverted the worktree to ${c.dim(target.id)} (${fmtAgo(target.ts)})`));
  }
  if (doConv) {
    const before = history.length;
    if (target.historyLen <= history.length) history.length = target.historyLen;
    ctrl?.setContext(approxTokens(history)); // shrink the context meter to match the rewound history
    console.log(c.green(`  ✓ conversation rewound to before this prompt (${before} → ${history.length} message${history.length === 1 ? "" : "s"})`));
    // Drop the rewound prompt back into the input so the user can edit / re-run it (Claude-Code style).
    if (target.label) {
      if (ctrl?.setInput) { ctrl.setInput(target.label); console.log(c.dim("  ↩ that prompt is back in your input — edit it, or press Enter to run it again.")); }
      else console.log(c.dim(`  ↩ re-run this prompt:\n     ${target.label.slice(0, 200)}`));
    }
  }
  if (doCode) console.log(c.dim("  (a '(state before rewind)' checkpoint was saved — /rewind it to undo this.)"));
}

/** Returns true to exit the REPL. */
async function handleCommand(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "help": console.log(HELP); break;
    case "exit": case "quit": return true;
    case "clear": persistSession(); history = []; todos.clear(); activeGoal = null; convoId = newSessionId(); convoCreated = Date.now(); ctrl?.setContext(0); console.log(c.dim("  context cleared (previous conversation kept in /resume)")); break;
    case "compact": {
      // Manual on-demand version of the loop's auto-compaction: summarize older turns into one note,
      // keeping the recent window. Optional free-text focus steers the summary (/compact focus on X).
      if (!modelReachable()) { console.log(c.yellow("  /compact needs a model provider (a key, or a configured endpoint via /models)")); break; }
      if (history.length < 4) { console.log(c.dim("  nothing to compact yet — the conversation is still short")); break; }
      const before = approxTokens(history);
      console.log(c.dim(`  compacting ${history.length} messages (~${before} tokens) into a summary…`));
      let ok = false;
      try {
        ok = await compactNow(history, async (older) => {
          const r = await callModel({
            provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, model: cfg.model, maxTokens: cfg.maxTokens,
            system: summaryPrompt(arg),
            messages: [{ role: "user", content: older.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n").slice(0, 120_000) }],
          });
          return r.content.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim() || "(summary unavailable)";
        });
      } catch (e) { console.log(c.red(`  compaction failed: ${(e as Error).message} — history left intact`)); break; }
      if (ok) {
        const after = approxTokens(history);
        ctrl?.setContext(after);
        console.log(c.green(`  ✓ compacted${arg ? c.dim(` (focus: ${arg})`) : ""} — ~${before} → ~${after} tokens`));
      } else console.log(c.dim("  nothing to compact yet — not enough older history beyond the recent window"));
      break;
    }
    case "resume": {
      const sessions = listSessions(cfg.dataDir, cfg.cwd);
      if (!sessions.length) { console.log(c.dim("  no saved sessions for this workspace yet")); break; }
      if (arg) {
        const target = /^\d+$/.test(arg) ? sessions[Number(arg) - 1] : sessions.find((s) => s.id === arg || s.id.startsWith(arg));
        if (!target) { console.log(c.red(`  no session matching "${arg}" — /resume to list`)); break; }
        resumeSession(target.id);
        break;
      }
      if (ui.pick) {
        const items = sessions.slice(0, 20).map((s) => ({ label: s.title, hint: `${relTime(s.updated)} · ${s.turns} turn(s)`, value: s.id }));
        const picked = await ui.pick("Resume a session  ↑↓ · Enter · Esc", items);
        if (picked) resumeSession(picked);
        break;
      }
      console.log(c.bold("  saved sessions (newest first):"));
      sessions.slice(0, 20).forEach((s, i) => console.log(`    ${c.cyan(String(i + 1).padStart(2))}  ${s.title}  ${c.dim(`· ${relTime(s.updated)} · ${s.turns} turn(s)`)}`));
      console.log(c.dim("  resume one with /resume <n>"));
      break;
    }
    case "context": {
      const model = cfg.resolvedModel ?? cfg.model;
      const win = contextWindowFor(model);
      const tk = (ch: number) => Math.round(ch / 4); // ~4 chars/token, matching approxTokens()
      // Fixed per-turn overhead that is NOT stored in history: the system prompt (repo map + AGENTS.md +
      // memory) and the tool schemas. Counting these makes the % reflect the REAL window occupancy.
      const sysTok = tk(systemPrompt(cfg, store).reduce((n, b) => n + b.text.length, 0));
      const toolsTok = tk(JSON.stringify([...tools.values()].map((t) => t.def)).length);
      let textCh = 0, toolCh = 0, otherCh = 0;
      for (const m of history) {
        if (typeof m.content === "string") { textCh += m.content.length; continue; }
        for (const b of m.content as any[]) {
          const len = typeof b?.content === "string" ? b.content.length : JSON.stringify(b ?? "").length;
          if (b?.type === "tool_result") toolCh += len;
          else if (b?.type === "text") textCh += (b.text?.length ?? 0);
          else otherCh += len;
        }
      }
      const histTok = tk(textCh + toolCh + otherCh);
      const totalTok = sysTok + toolsTok + histTok;
      const pct = win ? Math.min(100, Math.round((totalTok / win) * 100)) : 0;
      const barLen = 32, filled = Math.min(barLen, Math.round((pct / 100) * barLen));
      const bar = c.cyan("█".repeat(filled)) + c.dim("░".repeat(barLen - filled));
      const budget = budgetChars(model);
      console.log(`\n  ${c.bold("Context")}  ${c.dim(describeModel(model))}`);
      console.log(`  ${bar}  ${pct}%  ${c.dim(`(~${totalTok} / ${(win / 1000).toFixed(0)}k tokens · estimate)`)}`);
      console.log(c.dim(`  system+tools ~${sysTok + toolsTok} tok ${c.dim(`(prompt ~${sysTok} · tools ~${toolsTok})`)}`));
      console.log(c.dim(`  conversation ~${histTok} tok  ${c.dim(`(messages ~${tk(textCh)} · tool results ~${tk(toolCh)} · ${history.length} msgs)`)}`));
      console.log(c.dim(`  auto-compaction (history): evict ~${Math.round((budget * 0.60) / 4 / 1000)}k tok · summarize ~${Math.round((budget * 0.85) / 4 / 1000)}k tok`));
      if (histTok > (budget * 0.85) / 4) console.log(c.yellow("  ⚠ history is over the summary threshold — /compact to free space now"));
      console.log("");
      break;
    }
    case "diff": {
      // status --short surfaces untracked/new files (which a bare `git diff` omits); the full diff follows,
      // separated by a sentinel. Check ONLY the status section for the not-a-repo error — the diff body can
      // legitimately contain the phrase "not a git repository" (e.g. this very source file).
      const r = await shellExec({ cwd: cfg.cwd, sandbox: "off", command: "git -c color.ui=always --no-pager status --short 2>&1; echo '@@OB1DIFF@@'; git -c color.ui=always --no-pager diff 2>&1", signal: activeAbort?.signal });
      const [statusPart = "", diffPart = ""] = r.output.split("@@OB1DIFF@@");
      if (/not a git repository|fatal:/i.test(statusPart)) { console.log(c.dim("  not a git repository (or git unavailable)")); break; }
      const body = (statusPart.trim() + (diffPart.trim() ? "\n\n" + diffPart.trim() : "")).trim();
      if (!body) { console.log(c.dim("  no uncommitted changes")); break; }
      const lines = body.split("\n"), cap = 400;
      console.log("\n" + lines.slice(0, cap).join("\n"));
      if (lines.length > cap) console.log(c.dim(`  … ${lines.length - cap} more lines (run \`git diff\` for the full output)`));
      console.log("");
      break;
    }
    case "init": {
      const path = join(cfg.cwd, "AGENTS.md");
      const exists = existsSync(path);
      if (exists && rest[0] !== "force") { console.log(c.yellow("  AGENTS.md already exists — /init force to regenerate, or /agents to view")); break; }
      try {
        const md = generateAgentsMd(cfg.cwd, loadAgentsMemory(cfg.cwd));
        writeFileSync(path, md);
        console.log(c.green(`  ✓ ${exists ? "regenerated" : "created"} AGENTS.md (${md.length} chars)`) + c.dim(" — OB-1's project guide, auto-injected each session. Edit it to add conventions/architecture notes."));
      } catch (e) { console.log(c.red(`  /init failed: ${(e as Error).message}`)); }
      break;
    }
    case "goal": {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "clear" || sub === "stop" || sub === "off") { activeGoal = null; console.log(c.dim("  goal cleared")); break; }
      if (!arg) { console.log(activeGoal ? `  active goal: ${c.cyan(activeGoal)}` : c.dim("  no active goal — /goal <condition> to set one (OB-1 works until it's met)")); break; }
      if (!modelReachable()) { console.log(c.yellow("  /goal needs a model provider (a key, or a configured endpoint via /models)")); break; }
      const cap = Number(process.env.OB1_GOAL_MAX_ITERS) > 0 ? Number(process.env.OB1_GOAL_MAX_ITERS) : 10;
      activeGoal = arg;
      console.log(c.green(`  ✓ goal set: ${arg}`));
      console.log(c.dim(`  working until met (max ${cap} iterations) · ESC to stop · /goal stop to cancel`));
      await runGoalLoop(arg);
      break;
    }
    case "export": {
      if (!history.length) { console.log(c.dim("  nothing to export yet")); break; }
      const text = renderTranscript(history);
      if (/^(clipboard|copy|clip)$/i.test(arg.trim())) {
        const ok = await copyToClipboard(text);
        console.log(ok ? c.green(`  ✓ copied ${history.length} messages to the clipboard`) : c.yellow("  couldn't access the clipboard — try /export <file> instead"));
        break;
      }
      try {
        const dir = join(cfg.dataDir, "exports");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const file = arg ? (arg.startsWith("/") ? arg : join(cfg.cwd, arg)) : join(dir, `conversation-${convoId}.md`);
        writeFileSync(file, text);
        console.log(c.green(`  ✓ exported ${history.length} messages → ${file}`));
      } catch (e) { console.log(c.red(`  /export failed: ${(e as Error).message}`)); }
      break;
    }
    case "trust": {
      saveTrust(cfg.settingsDir, recordTrust(cfg.cwd, loadTrust(cfg.settingsDir)));
      console.log(c.green(`  ✓ trusted this workspace (${cfg.cwd}) — autopilot is now allowed here.`));
      break;
    }
    case "allow": {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "list") {
        const ts = approvals.list();
        console.log(ts.length ? "  active /allow grants (this session):\n" + ts.map((t) => `    ${t.id}  ${t.label}${t.remaining != null ? ` (${t.remaining} left)` : ""}`).join("\n") : c.dim("  no active /allow grants"));
        break;
      }
      if (sub === "clear" || sub === "revoke") { approvals.clear(); console.log(c.dim("  cleared all /allow grants")); break; }
      // optional trailing "x5" sets a finite use count: /allow git x5
      const args = rest.filter((a) => !/^x\d+$/i.test(a));
      const usesArg = rest.find((a) => /^x\d+$/i.test(a));
      const uses = usesArg ? Number(usesArg.slice(1)) : undefined;
      const spec = parseAllowSpec(args.join(" "));
      if (!spec) { console.log(c.yellow("  usage: /allow <git|bash|write [path]|toolName> [xN] · /allow list · /allow clear")); break; }
      approvals.grant(spec.scope, { label: spec.label, uses });
      // "write" covers two tools (write_file + edit_file) — grant the edit lane too.
      if (spec.scope.tool === "write_file") approvals.grant({ ...spec.scope, tool: "edit_file" }, { label: spec.label.replace("writes", "edits"), uses });
      console.log(c.green(`  ✓ allowed ${spec.label}${uses != null ? ` for ${uses} use(s)` : " for this session"} — the gate won't re-prompt. /allow clear to revoke.`));
      break;
    }
    case "rewind": await rewindCmd(rest); break;
    case "mode": {
      const m = rest[0] as Mode;
      if (["solo", "fusion", "council", "personas"].includes(m)) setMode(m);
      else if (!rest[0] && ui.pick) await pickMode();   // bare /mode opens the picker on a TTY
      else console.log(c.red("  usage: /mode solo|fusion|council|personas"));
      break;
    }
    case "solo": setMode("solo"); break; // quick exit from a sticky heavy mode
    case "plan": cfg.planMode = true; console.log(c.yellow("  Plan mode (read-only)")); break;
    case "act": cfg.planMode = false; console.log(c.green("  Act mode")); break;
    case "map": {
      const map = buildRepoMap(cfg.cwd);
      console.log("\n" + renderRepoMap(map, { maxFiles: 20 }));
      console.log(c.dim(`\n  ${map.totalFiles} files · ${map.totalSymbols} symbols\n`));
      break;
    }
    case "fanout": {
      if (!modelReachable()) { console.log(c.yellow("  /fanout needs a model provider (a key, or a configured endpoint via /models)")); break; }
      if (!arg) { console.log(c.red("  usage: /fanout <task>")); break; }
      // Optional dual-ledger controller (item #11): act → assess → re-plan-on-stall, bounded. Default
      // OFF; OB1_ORCH_LEDGER=1 routes /fanout through it instead of the single-shot fan-out.
      if (process.env.OB1_ORCH_LEDGER === "1") {
        console.log(c.dim("  dual-ledger orchestration (act → assess → re-plan on stall)…"));
        const lr = await runLedger({ ledger: { task: arg, facts: [], guesses: [], plan: [arg] }, cfg, tools, onEvent: workerProgress, signal: activeAbort?.signal });
        if (activeAbort?.signal.aborted) break;
        const status = lr.satisfied ? c.green("satisfied") : lr.stalledOut ? c.yellow("stalled out (recovery exhausted)") : c.yellow("round cap reached");
        console.log("\n" + c.bold("Ledger result:") + "\n" + lr.finalText + "\n");
        console.log(c.dim(`  [${status} · ${lr.rounds} rounds · ${lr.replans} re-plans · ~${lr.totalInputTokens} in / ${lr.totalOutputTokens} out tokens]`));
        break;
      }
      console.log(c.dim("  spawning isolated workers (multi-mind — uses ~Nx tokens)…"));
      const r = await fanout({ task: arg, cfg, tools, onEvent: workerProgress, signal: activeAbort?.signal });
      if (activeAbort?.signal.aborted) break; // ESC
      // (token meter already ticked up per-worker via workerProgress — do not accrue the total again)
      for (const w of r.workers) console.log(c.dim(`  • ${w.label}: ${w.outputTokens} out tok${w.ok ? "" : c.yellow(" (incomplete)")}`));
      console.log("\n" + c.bold("Synthesis:") + "\n" + r.synthesis + "\n");
      console.log(c.dim(`  [${r.workers.length} workers + synthesizer · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens total]`));
      // Persist the synthesized result like Fusion/Council/Personas do: the fan-out workers run read-only
      // in isolated contexts, so without this the synthesis is only PRINTED and never lands on disk. Gated
      // by shouldApply (only writes when the synthesis carries code, and never in Plan mode).
      await applySolution(arg, r.synthesis);
      break;
    }
    case "council": {
      if (!modelReachable()) { console.log(c.yellow("  /council needs a model provider (a key, or a configured endpoint via /models)")); break; }
      if (!arg) { console.log(c.red("  usage: /council <task>")); break; }
      await councilTurn(arg);
      break;
    }
    case "personas": {
      if (!modelReachable()) { console.log(c.yellow("  /personas needs a model provider (a key, or a configured endpoint via /models)")); break; }
      if (!arg) { console.log(c.red("  usage: /personas <task>")); break; }
      await personasTurn(arg);
      break;
    }
    case "route": {
      if (!modelReachable()) { console.log(c.yellow("  /route needs a model provider (a key, or a configured endpoint via /models)")); break; }
      if (!arg) { console.log(c.red("  usage: /route <task>")); break; }
      await adaptiveTurn(arg);
      break;
    }
    case "eval": {
      if (!modelReachable()) { console.log(c.yellow("  /eval needs a model provider (a key, or a configured endpoint via /models)")); break; }
      await evalTurn(rest);
      break;
    }
    case "mcp": {
      if (!mcp.clients.length) { console.log(c.dim("  no MCP servers connected (configure .ob1/mcp.json or mcp.json)")); break; }
      const active = new Set([...tools.keys()].filter((k) => k.startsWith("mcp__")));
      console.log(c.bold(`  ${mcp.clients.length} server(s) · ${deferredMcp.size} tools (deferred; load_mcp_tool activates)`));
      for (const k of deferredMcp.keys()) console.log(`    ${c.cyan(k)}${active.has(k) ? c.green("  ● active") : c.dim("  ○ deferred")}`);
      break;
    }
    case "agents": {
      const sub = rest[0];
      if (sub === "regen") {
        writeFileSync(join(cfg.cwd, "AGENTS.md"), generateAgentsMd(cfg.cwd, loadAgentsMemory(cfg.cwd)));
        console.log(c.dim("  regenerated AGENTS.md"));
      } else if (sub === "update") {
        showAgentsUpdate();
      } else if (sub === "episodes") {
        showAgentEpisodes();
      } else if (sub === "review") {
        showAgentCandidates();
      } else if (sub === "promote") {
        promoteAgentCandidates(rest.slice(1));
      } else if (!rest[0] && ui.pick) {
        await pickAgents();                             // bare /agents → project-memory picker
      } else {
        const a = loadAgentsMd(cfg.cwd);
        console.log(a ? "\n" + a + "\n" : c.dim("  (no AGENTS.md)"));
      }
      break;
    }
    case "skills": {
      // /skills learn on|off — toggle automatic skill learning (one cheap LLM call per substantive turn).
      if (rest[0] === "learn") {
        if (!memBrain) { console.log(c.yellow("  automatic skill learning needs a provider key")); break; }
        if (rest[1] === "on" || rest[1] === "off") {
          cfg.skillLearn = rest[1] === "on"; saveSettings(cfg);
          console.log(`  automatic skill learning ${cfg.skillLearn ? c.yellow("ON") : "off"}${c.dim(" — distils a reusable skill from each substantive turn into .ob1/skills/")}`);
        } else console.log(c.red(`  usage: /skills learn on|off (current: ${cfg.skillLearn ? "on" : "off"})`));
        break;
      }
      // /skills curate — age learned skills by inactivity now (active→stale→archived; reactivate on use).
      if (rest[0] === "curate") {
        const cur = runCurator(cfg.cwd);
        const moved = cur.staled.length + cur.archived.length + cur.reactivated.length;
        console.log(moved
          ? c.dim(`  curated — ${cur.staled.length} → stale, ${cur.archived.length} → archived, ${cur.reactivated.length} reactivated`)
          : c.dim("  nothing to curate"));
        break;
      }
      // /skills rm <name> — remove a LEARNED skill (shipped/user skills are protected by the registry).
      if (rest[0] === "rm" || rest[0] === "remove" || rest[0] === "delete") {
        const target = rest[1];
        if (!target) { console.log(c.red("  usage: /skills rm <name>")); break; }
        const r = deleteSkill(cfg.cwd, target);
        console.log(r.ok ? c.dim(`  removed learned skill: ${target}`) : c.red(`  ${r.error}`));
        break;
      }
      const sk = listSkills(cfg.cwd, { includeArchived: true });
      if (!sk.length) { console.log(c.dim("  (no skills — add markdown under skills/ or let OB-1 learn them into .ob1/skills/)")); break; }
      const usage = readUsage(cfg.cwd);
      const learned = sk.filter((s) => s.origin === "agent").length;
      for (const s of sk) {
        const tag = s.origin === "agent" ? c.green(" ✦learned") : "";
        const st = s.state === "active" ? "" : c.yellow(` [${s.state}]`);
        const uses = usage[s.name]?.uses ?? 0;
        const used = uses ? c.dim(` ·${uses}×`) : "";
        console.log(`    ${c.cyan(s.name)}${tag}${st}${used} ${c.dim("— " + s.description)}`);
      }
      if (learned) console.log(c.dim(`  ${learned} learned · /skill <name> view · /skills rm <name> remove · /skills curate · /skills learn on|off`));
      break;
    }
    case "skill": {
      if (!arg && ui.pick) { await pickSkill(); break; }  // bare /skill opens the skill picker on a TTY
      const body = arg ? readSkill(cfg.cwd, arg) : null;
      console.log(body ? "\n" + body + "\n" : c.red(`  usage: /skill <name> (try /skills)`));
      break;
    }
    case "model":
      if (arg) {
        if (history.length && arg !== cfg.model) console.log(c.yellow("  ⚠ switching model mid-session invalidates the prompt cache (R1) — every cached prefix must be rebuilt; /clear to reset context."));
        cfg.model = arg; ctrl?.setStatus({ resolvedModel: undefined, estTok: false }); console.log(`  model → ${arg}  ${c.dim(describeModel(arg))}`);
      } else if (ui.pick) { await pickModel(); }            // bare /model opens the picker on a TTY
      else console.log(`  model: ${cfg.model}  ${c.dim(describeModel(cfg.model))}`);
      break;
    case "models": {
      if (ui.pick) { await pickModel(); break; } // interactive on a TTY; plain list + prompts under the REPL
      // REPL (non-TTY): set up the provider if nothing is configured, then list the catalog (pick via /model <id>).
      if (!cfg.apiKey && !cfg.providerProfile && ui.providerSetup) await setupProvider();
      if (cfg.providerProfile) {
        const conn = await fetchModels(cfg.baseUrl, cfg.apiKey ?? "");
        console.log(`  ${c.bold("current")}: ${cfg.model}  ${c.dim("(auto = the proxy's router picks the best free model)")}`);
        if (conn.ok) for (const m of conn.models.filter((x) => x.available !== false)) console.log(`    ${c.cyan(m.id.padEnd(22))} ${c.dim(`${m.name ?? ""}${m.contextWindow ? `${m.name ? " · " : ""}${(m.contextWindow / 1000).toFixed(0)}k ctx` : ""}`)}`);
        else console.log(c.yellow(`  couldn't list models: ${conn.error}`));
        console.log(c.dim("  set one with /model <id>"));
        break;
      }
      console.log(c.dim(`  output length is governed by the model${cfg.maxTokens ? ` (capped at ${cfg.maxTokens} by OB1_MAX_TOKENS)` : " (no cap on OpenAI-compatible; registry value on Anthropic)"}`));
      console.log(`  ${c.bold("current")}: ${cfg.model}  ${c.dim(describeModel(cfg.model))}`);
      for (const m of MODELS) console.log(`    ${c.cyan(m.label.padEnd(18))} ${c.dim(`${(m.contextWindow / 1000).toFixed(0)}k ctx · ${(m.maxOutput / 1000).toFixed(0)}k out${m.inPrice ? ` · $${m.inPrice}/$${m.outPrice} per 1M` : ""}`)}${m.notes === "default" ? c.green("  ← default") : ""}`);
      break;
    }
    case "settings":
      // /settings was a menu that just duplicated the slash commands. It's gone — every setting is now a
      // first-class command. Keep a friendly redirect so old muscle memory isn't a dead "unknown command".
      console.log(c.dim("  settings are now individual commands — press / to browse them:"));
      console.log(c.dim("    /mode · /model · /effort · /freellm · /permission · /sandbox · /autoroute · /subagents · /repomap · /quality · /trust · /allow"));
      break;
    case "freellm": case "free-llm": {
      if (ui.pick) { await pickFreeLLM(); break; } // managed setup / manage on a TTY
      const { loadManaged } = await import("./cli/freellm-manage.ts");
      const st = loadManaged();
      console.log(st?.managed ? `  Free LLM API: managed · ${st.runtime} · ${st.url}` : c.dim("  Free LLM API: not set up — run `ob1 onboard`, or /models on a TTY"));
      break;
    }
    case "permission": {
      const p = rest[0]?.toLowerCase();
      if (p === "ask" || p === "autopilot") { cfg.permissionMode = p as PermissionMode; console.log(`  permission → ${p === "autopilot" ? c.yellow("autopilot (no prompts)") : "ask"}`); }
      else if (!rest[0] && ui.pick) await pickPermission();  // bare /permission opens the picker on a TTY
      else console.log(c.red(`  usage: /permission ask|autopilot (current: ${cfg.permissionMode})`));
      break;
    }
    case "repomap": case "repo-map": {
      if (rest[0] === "on" || rest[0] === "off") { cfg.repoMap = rest[0] === "on"; console.log(`  repo map ${cfg.repoMap ? c.yellow("ON") : "off"}${c.dim(" — auto codebase structure in context, refreshed as files change")}`); }
      else if (!rest[0] && ui.pick) await pickRepoMap();     // bare /repomap opens the picker on a TTY
      else console.log(c.red(`  usage: /repomap on|off (current: ${cfg.repoMap ? "on" : "off"})`));
      break;
    }
    case "quality": {
      const sub = rest[0]?.toLowerCase();
      if (sub === "normal" || sub === "strict" || sub === "off") setQualityMode(sub as QualityMode);
      else if (sub === "show" || !sub) {
        if (!sub && ui.pick) { await pickQuality(); break; }
        const latest = latestQualityLedger(cfg.cwd);
        console.log(latest ? "\n" + formatQualityLedger(latest.ledger, latest.path) + "\n" : c.dim("  no quality runs yet — complete a task first"));
      } else if (sub === "scenarios") {
        const scenarios = loadQualityScenarios(cfg.cwd);
        const latest = latestQualityLedger(cfg.cwd);
        console.log(c.bold(`  Quality scenarios (${scenarios.length})`));
        if (!latest) {
          for (const s of scenarios) console.log(`    ${c.cyan(s.id)} ${c.dim("— " + (s.description ?? s.prompt))}`);
          console.log(c.dim("  no quality run to score yet; run a task, then /quality scenarios"));
        } else {
          for (const s of scenarios) {
            const score = scoreQualityLedger(s, latest.ledger);
            const pct = Math.round(score.score * 100);
            console.log(`    ${score.passed ? c.green("✓") : c.yellow("✗")} ${c.cyan(s.id)} ${pct}%${score.issues.length ? c.dim(" — " + score.issues.join("; ")) : ""}`);
          }
        }
      } else console.log(c.red(`  usage: /quality normal|strict|off|show|scenarios (current: ${cfg.qualityMode})`));
      break;
    }
    case "autoroute": {
      if (rest[0] === "on" || rest[0] === "off") {
        cfg.autoRoute = rest[0] === "on";
        console.log(`  auto-route ${cfg.autoRoute ? c.yellow("ON") : "off"}`);
      } else if (!rest[0] && ui.pick) await pickAutoRoute();  // bare /autoroute opens an on/off picker on a TTY
      else console.log(c.red(`  usage: /autoroute on|off (current: ${cfg.autoRoute ? "on" : "off"})`));
      break;
    }
    case "subagents": {
      if (rest[0] === "on" || rest[0] === "off") {
        cfg.subagents = rest[0] === "on";
        console.log(`  subagents ${cfg.subagents ? c.yellow("ON") : "off"}`);
      } else if (!rest[0] && ui.pick) await pickSubagents();  // bare /subagents opens an on/off picker on a TTY
      else console.log(c.red(`  usage: /subagents on|off (current: ${cfg.subagents ? "on" : "off"})`));
      break;
    }
    case "effort": {
      const e = rest[0]?.toLowerCase();
      if (e === "low" || e === "medium" || e === "high") setEffort(e as Effort);
      else if (!rest[0] && ui.pick) await pickEffort();       // bare /effort opens the picker on a TTY
      else console.log(c.red(`  usage: /effort low|medium|high (current: ${cfg.effort ?? "medium"})`));
      break;
    }
    case "upgrade": case "subscribe": {
      // Open pricing via the AUTHENTICATED handoff so checkout is tied to this CLI's account, then watch
      // for the plan to go active and update live (no restart needed).
      await openPricingPage("/pricing");
      watchForSubscription();
      break;
    }
    case "verify": {
      console.log(c.gray("  ⚙ verifying…"));
      const r = await runVerification(cfg.cwd, (cmd) => shellExec({ cwd: cfg.cwd, sandbox: cfg.sandbox, command: cmd, signal: activeAbort?.signal }), rest[0] ? rest.join(" ").split(/[,\s]+/).filter(Boolean) : "auto");
      console.log(r.ran ? `  ${r.ok ? c.green("✓ all checks passed") : c.yellow("✗ some checks failed")}\n${r.report}` : c.dim("  " + r.report));
      break;
    }
    case "sandbox": {
      const m = rest[0] as SandboxMode;
      if (["off", "read-only", "workspace-write"].includes(m)) {
        cfg.sandbox = m;
        console.log(`  sandbox → ${m === "off" ? m : c.yellow(m)}${c.dim(sandboxNote(m))}`);
      } else if (!rest[0] && ui.pick) await pickSandbox();  // bare /sandbox opens the picker on a TTY
      else console.log(c.red(`  usage: /sandbox off|read-only|workspace-write (current: ${cfg.sandbox})`));
      break;
    }
    case "memory": {
      const sub = rest[0];
      if (!sub) { showMemory(); break; }
      const subArg = rest.slice(1).join(" ");
      if (sub === "add" && subArg) console.log(c.dim(`  remembered #${await store.remember(subArg)}`));
      else if (sub === "search" && subArg) {
        const hits = await store.searchSemantic(subArg);
        if (!hits.length) console.log(c.dim("  (no matches)"));
        for (const f of hits) console.log(`    ${c.gray("#" + f.id)} ${f.fact}`);
      } else if (sub === "log" && rest[1]) {
        for (const r of store.revisions(Number(rest[1]))) console.log(`    ${c.dim(r.at)}  ${c.bold(r.op.toUpperCase())}  ${r.fact}`);
      } else if (sub === "graph") {
        for (const e of store.listRelationships()) console.log(`    ${c.cyan(e.src)} --${e.rel}--> ${c.cyan(e.dst)}`);
      } else if (sub === "evolve") {
        if (!store.hasBrain) { console.log(c.yellow("  memory evolution needs a provider key")); break; }
        if (rest[1] === "on" || rest[1] === "off") {
          cfg.memEvolve = rest[1] === "on";
          store.setMemoryFlags({ evolve: cfg.memEvolve });
          console.log(`  memory evolution ${cfg.memEvolve ? c.yellow("ON") : "off"}${c.dim(" — new facts consolidate (add/update/supersede/dedup) instead of just appending")}`);
        } else console.log(c.red(`  usage: /memory evolve on|off (current: ${store.evolveOn ? "on" : "off"})`));
      } else if (sub === "reflect") {
        if (!store.hasBrain) { console.log(c.yellow("  memory reflection needs a provider key")); break; }
        if (rest[1] === "on" || rest[1] === "off") {
          cfg.memReflect = rest[1] === "on";
          store.setMemoryFlags({ reflect: cfg.memReflect });
          console.log(`  memory reflection ${cfg.memReflect ? c.yellow("ON") : "off"}${c.dim(" — distils accumulated facts into higher-level insights")}`);
        } else console.log(c.red(`  usage: /memory reflect on|off (current: ${store.reflectOn ? "on" : "off"})`));
      } else if (sub === "autolink") {
        if (!store.hasBrain) { console.log(c.yellow("  memory auto-linking needs a provider key")); break; }
        if (rest[1] === "on" || rest[1] === "off") {
          cfg.memAutolink = rest[1] === "on";
          store.setMemoryFlags({ autolink: cfg.memAutolink });
          const warn = cfg.memAutolink && !store.evolveOn ? c.yellow("  (note: auto-linking rides memory evolution — also run /memory evolve on)") : "";
          console.log(`  memory auto-linking ${cfg.memAutolink ? c.yellow("ON") : "off"}${c.dim(" — links related facts (related_to/refines/contradicts)")}${warn ? "\n" + warn : ""}`);
        } else console.log(c.red(`  usage: /memory autolink on|off (current: ${store.autolinkOn ? "on" : "off"})`));
      } else if (sub === "export") {
        const fmt = (rest[1] === "html" ? "html" : "dot") as ExportFormat;
        const out = exportGraph(fmt, store.listEntities(), store.listRelationships(true)); // include invalidated edges (dashed)
        const path = join(cfg.dataDir, `memory-graph.${fmt}`);
        writeFileSync(path, out);
        console.log(c.green(`  ✓ exported ${store.listEntities().length} entities → ${path}`) + c.dim(fmt === "dot" ? "  (render: `dot -Tsvg` or paste into a Graphviz viewer)" : "  (open in a browser — self-contained)"));
      } else console.log(c.red("  usage: /memory [add <text> | search <q> | log <id> | graph | export [dot|html] | evolve on|off | reflect on|off | autolink on|off]"));
      break;
    }
    case "usage": {
      // Subscription usage first (the managed-server plan: the monthly credit pool), then the local
      // token+cost analytics. The plan block is omitted for free/self-hosted (FreeLLMAPI) users.
      const planLines = formatPlanUsage(await fetchPlan());
      if (planLines.length) { console.log(""); for (const l of planLines) console.log(l); }
      console.log(formatUsage(aggregate(loadUsage(join(cfg.dataDir, "usage.jsonl")))));
      break;
    }
    case "codeact": {
      if (!modelReachable()) { console.log(c.yellow("  /codeact needs a model provider (a key, or a configured endpoint via /models)")); break; }
      if (!arg) { console.log(c.red("  usage: /codeact <task>")); break; }
      if (cfg.sandbox === "off") console.log(c.yellow("  ⚠ sandbox is OFF — CodeAct will run model-written code unsandboxed. /sandbox workspace-write recommended."));
      console.log(c.dim("  CodeAct (code-as-action · sandbox · approval-gated · unproven ⚠ — measure on /eval)…"));
      const r = await runCodeAct({
        task: arg,
        model: async (messages) => {
          const resp = await callModel({ provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, model: cfg.model, system: CODEACT_SYSTEM, messages });
          return { text: resp.content.filter((b) => b.type === "text").map((b: any) => b.text).join(""), inputTokens: resp.usage?.input_tokens ?? 0, outputTokens: resp.usage?.output_tokens ?? 0 };
        },
        exec: (command) => shellExec({ cwd: cfg.cwd, sandbox: cfg.sandbox, command, signal: activeAbort?.signal }),
        approve: async (action) => {
          console.log(c.dim(`  ┌─ ${action.lang} action:`));
          console.log(action.code.split("\n").map((l) => c.dim("  │ ") + l).join("\n"));
          return cfg.permissionMode === "autopilot" ? true : ui.approve(`run this ${action.lang} block`);
        },
        signal: activeAbort?.signal,
      });
      if (activeAbort?.signal.aborted) break;
      accrue(r.totalInputTokens, r.totalOutputTokens);
      for (const s of r.steps) console.log(c.dim(`  • ${s.action.lang} → exit ${s.code}`));
      console.log("\n" + c.bold("CodeAct:") + "\n" + (r.answer || c.yellow(`(stopped: ${r.stopped})`)) + "\n");
      console.log(c.dim(`  [${r.steps.length} actions · ${r.stopped} · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens]`));
      break;
    }
    default: console.log(c.red(`  unknown command: /${cmd} — try /help`));
  }
  saveSettings(cfg); // remember model / mode / sandbox / permission / … across sessions
  return false;
}

async function fusionTurn(task: string): Promise<void> {
  if (!modelReachable()) { console.log(c.yellow("  fusion needs a model provider (a key, or a configured endpoint via /models)")); return; }
  const models = process.env.OB1_FUSION_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
  const n = process.env.OB1_FUSION_N ? envInt("OB1_FUSION_N", 3) : undefined;
  const check = process.env.OB1_FUSION_CHECK;
  const moa = process.env.OB1_FUSION_MOA === "1";
  const judgeModel = process.env.OB1_FUSION_JUDGE_MODEL;
  const worktree = process.env.OB1_FUSION_WORKTREE === "1";
  const testCmd = process.env.OB1_FUSION_TEST_CMD;
  const targetPath = process.env.OB1_FUSION_TARGET;
  const nCand = n ?? Math.max(3, models?.length ?? 0);
  console.log(c.dim(`  budget (declared up front): ~${nCand + 1 + (moa ? nCand : 0)} model calls ≈ ${nCand + 1 + (moa ? nCand : 0)}× a Solo pass`));
  const copyKind = cfg.planMode ? "read-only (plan mode)" : "full tools in a private workspace copy each";
  console.log(c.dim(`  Fusion: ${nCand} candidates (same prompt · ${copyKind}) + auto-score → synthesizer merges the best parts${models?.length ? ` · ${models.length} models` : ""}${moa ? " + MoA refine" : ""}${worktree ? ` + worktree real-test (${testCmd ?? "bun test"})` : ""}…`));
  const r = await runFusion({ task, cfg, tools, n, models, check, moa, judgeModel, worktree, testCmd, targetPath, mkTools, planMode: cfg.planMode, onEvent: workerProgress, signal: activeAbort?.signal });
  if (activeAbort?.signal.aborted) return; // ESC: don't render a partial result or apply it
  // (token meter already ticked up per-worker via workerProgress — do not accrue the total again)
  for (const cnd of r.candidates) {
    const v = !cnd.score?.checked ? c.gray("unscored") : cnd.score.ok ? c.green("PASS") : c.red("FAIL");
    console.log(c.dim(`  • ${cnd.label} [${cnd.model}] `) + v + c.dim(`  ${cnd.outputTokens} out tok`));
  }
  if (r.reverted) console.log(c.yellow("  synthesis failed the objective check → reverted to a passing candidate"));
  console.log("\n" + c.bold(modeColor("fusion")("Fusion result:")) + "\n" + r.synthesis + "\n");
  console.log(c.dim(`  [${r.candidates.length} candidates + synthesizer · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens]`));
  await applySolution(task, r.synthesis);
}

async function councilTurn(task: string): Promise<void> {
  if (!modelReachable()) { console.log(c.yellow("  council needs a model provider (a key, or a configured endpoint via /models)")); return; }
  const models = process.env.OB1_COUNCIL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
  const check = process.env.OB1_COUNCIL_CHECK;
  const arbiterModel = process.env.OB1_COUNCIL_ARBITER_MODEL;
  const maxR = envInt("OB1_COUNCIL_ROUNDS", 3);
  const twoModels = (models?.length ?? 0) > 1;
  // Council workers edit the REAL workspace directly; gate each mutating action with the same approval Solo
  // uses (autopilot → no prompt; ask → prompt). In Plan mode the workers stay read-only (nothing written).
  const workerApprove = cfg.permissionMode === "autopilot" ? undefined : (desc: string) => ui.approve(desc);
  console.log(c.dim(`  budget (declared up front): up to ~${1 + maxR * 2 + 1} model calls (author + ${maxR}×(review + revise) + finalizer), fewer if it converges early`));
  console.log(c.dim(`  Council: author ↔ reviewer${twoModels ? ` (2 models)` : ""}${check ? " · objective-grounded" : ""} over up to ${maxR} round(s) · ${cfg.planMode ? "read-only (plan mode)" : "editing the workspace directly" + (cfg.permissionMode === "autopilot" ? "" : ", each change gated")}…`));
  const r = await runCouncil({ task, cfg, tools, rounds: maxR, models, check, arbiterModel, approve: workerApprove, planMode: cfg.planMode, onEvent: workerProgress, signal: activeAbort?.signal });
  if (activeAbort?.signal.aborted) return; // ESC
  // (token meter already ticked up per-worker via workerProgress — do not accrue the total again)
  for (const rd of r.rounds) {
    const tag = rd.blocking ? c.red("BLOCK") : c.green("OK");
    console.log(c.dim(`  • round ${rd.round}: `) + tag + c.dim(rd.revisedThisRound ? " → revised" : " → no revision needed"));
  }
  const v = r.accepted ? c.green("ACCEPT") : c.yellow("REVISE");
  console.log("\n" + c.bold(modeColor("council")("Council result")) + " " + v + ":\n" + r.final + "\n");
  console.log(c.dim(`  [${r.rounds.length} round(s) · author + reviewer + finalizer · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens]`));
  // No separate apply step: the workers already wrote their changes to the real workspace as they went.
  if (cfg.planMode) console.log(c.dim("  (plan mode — council investigated read-only; nothing written. /act to let it edit the workspace.)"));
  else if (r.accepted) console.log(c.dim("  council edited the workspace directly; changes are in place — review and verify them."));
  else console.log(c.yellow("  ⚠ council returned REVISE (not ready to ship). Any edits it made are already in the workspace — review them and re-run or refine the task."));
}

async function personasTurn(task: string): Promise<void> {
  if (!modelReachable()) { console.log(c.yellow("  personas needs a model provider (a key, or a configured endpoint via /models)")); return; }
  const rounds = envInt("OB1_PERSONAS_ROUNDS", 2);
  const max = envInt("OB1_PERSONAS_MAX", 6);
  console.log(c.dim(`  budget (declared up front): up to ~${1 + max * rounds + 1} model calls (former + ≤${max} personas × ${rounds} dialogue rounds + facilitator), or 1 if it collapses to Solo`));
  console.log(c.dim("  Personas: casting the panel for your goal…"));
  const r = await runPersonas({ task, cfg, tools, rounds, max, onEvent: workerProgress, signal: activeAbort?.signal });
  if (activeAbort?.signal.aborted) return; // ESC
  // (token meter already ticked up per-worker via workerProgress — do not accrue the total again)
  const names = r.personas.map((p) => (p.title ? `${p.name} (${p.title})` : p.name)).join(", ");
  if (r.collapsed) console.log(c.dim(`  panel collapsed to a single solver: ${c.bold(names)} (goal didn't warrant a panel)`));
  else console.log(c.dim(`  panel (${r.personas.length}): `) + c.bold(names) + c.dim(` · ${r.dialogue.turns.length} turns over ${r.rounds} round(s) · facilitator: ${r.personas[0].name}`));
  console.log("\n" + c.bold(modeColor("personas")("Personas result:")) + "\n" + r.final + "\n");
  console.log(c.dim(`  [${r.collapsed ? "collapsed→solo" : `${r.personas.length} personas + facilitator`} · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens]`));
  await applySolution(task, r.final);
}

async function evalTurn(requested: string[]): Promise<void> {
  if (!modelReachable()) { console.log(c.yellow("  eval needs a model provider (a key, or a configured endpoint via /models)")); return; }
  const picked = requested.filter((m) => (SELECTABLE_MODES as readonly string[]).includes(m));
  let modes = picked.length ? picked : [...ALL_MODES];
  if (!modes.includes("solo")) modes = ["solo", ...modes]; // baseline is required for compute-matching
  const trials = envInt("OB1_EVAL_TRIALS", 1);
  const tasks = loadTasks(cfg.cwd);
  console.log(c.yellow(`  ⚠ Eval spends real tokens: ${tasks.length} task(s) × ${modes.join(", ")} × ${trials} trial(s)…`));
  const runners = buildRunners(cfg, tools, modes);
  const outcomes = await runEval({ tasks, runners, cwd: cfg.cwd, trials, onProgress: (m) => console.log(c.dim("  · " + m)) });
  console.log("\n" + c.bold(modeColor("adaptive")("Capability (solve what Solo fails)")) + "\n" + renderCapability(computeCapability(outcomes, { baseline: "solo" })) + "\n");
  console.log(c.bold(modeColor("council")("Compute-matched (efficiency)")) + "\n" + renderReport(computeMatched(outcomes, { baseline: "solo" })) + "\n");
}

async function adaptiveTurn(task: string, hint?: { mode: "fusion" | "council" | "personas"; why: string }): Promise<void> {
  if (!modelReachable()) { console.log(c.yellow("  adaptive needs a model provider (a key, or a configured endpoint via /models)")); return; }
  const check = process.env.OB1_ROUTE_CHECK;
  // Escalation target: env override, else derive from the difficulty signal (risk/design → Council's
  // critique; hard/high-value → Fusion's best-of-N). Council/Fusion are the only escalation topologies.
  const escalateTo = process.env.OB1_ROUTE_ESCALATE === "council" ? "council"
    : hint && hint.mode !== "fusion" ? "council" : "fusion";
  const models = process.env.OB1_FUSION_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
  // If this escalates to Council, its workers edit the REAL tree — gate each mutating action with the
  // SAME approval Solo/council uses (autopilot → no prompt; ask → prompt), and honor Plan mode (read-only).
  const workerApprove = cfg.permissionMode === "autopilot" ? undefined : (desc: string) => ui.approve(desc);
  console.log(c.dim(`  Adaptive${hint ? ` (${hint.why})` : ""}: Solo first; escalate to ${escalateTo} only if the task warrants it AND the objective check fails${check ? "" : c.yellow(" (no OB1_ROUTE_CHECK set → syntax signal only)")}…`));
  const r = await runAdaptive({ task, cfg, tools, check, escalateTo, models, requireDifficultySignal: true, approve: workerApprove, planMode: cfg.planMode, onEvent: workerProgress, signal: activeAbort?.signal });
  if (activeAbort?.signal.aborted) return; // ESC
  // (token meter already ticked up per-worker via workerProgress — do not accrue the total again)
  const tag = r.path === "solo" ? c.gray("solo (Solo passed → no escalation)") : modeColor(r.path)(`${r.path} (Solo failed the check → escalated)`);
  console.log(c.dim("  path: ") + tag);
  console.log("\n" + c.bold(modeColor("adaptive")("Adaptive result:")) + "\n" + r.final + "\n");
  console.log(c.dim(`  [~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens]`));
  await applySolution(task, r.final);
}

// In-session auto-heal for the OB-1-managed Free LLM API proxy. A Node-run proxy is a detached child,
// not a service, so it can die mid-session; the boot-time check (see startup block) only revives it at
// the next launch. This runs before every real prompt: a fast no-op when the proxy is already up, and a
// throttled respawn when it isn't — so a proxy that won't start (bad .env, missing dist/) can't stall
// every message with a respawn+timeout. Best-effort: never blocks or breaks a turn.
let lastProxyHealAt = 0;
async function ensureProxyHealthy(): Promise<void> {
  if (cfg.providerProfile !== "freellmapi") return;
  try {
    const flm = await import("./cli/freellm-manage.ts");
    const st = flm.loadManaged();
    if (!st?.managed) return;
    if (await flm.isUp(st.url)) return; // healthy — the hot path
    const now = Date.now();
    if (now - lastProxyHealAt < 15000) { // crash-loop guard: at most one respawn attempt per 15s
      console.log(c.yellow("  ⚠ Free LLM API proxy is down — retrying shortly · run /freellm to restart"));
      return;
    }
    lastProxyHealAt = now;
    console.log(c.dim("  Free LLM API proxy stopped — restarting it locally…"));
    console.log(await flm.ensureRunning(st)
      ? c.dim("  ✓ proxy back up")
      : c.yellow("  ⚠ couldn't restart the Free LLM API proxy — run /freellm to fix"));
  } catch { /* best-effort — never block a turn on the heal check */ }
}

// ─── per-line dispatch (shared by REPL + TUI) ───────────────────────────────
async function processLine(line: string): Promise<boolean> {
  const t = line.trim();
  if (!t) return false;
  // `!cmd` — run a shell command directly (the user's own command, not the model's). Honors the sandbox
  // setting; never goes through the model and never lands in history.
  if (t.startsWith("!")) {
    const cmd = t.slice(1).trim();
    if (!cmd) { console.log(c.dim("  usage: !<shell command>")); return false; }
    try {
      const r = await shellExec({ cwd: cfg.cwd, sandbox: cfg.sandbox, command: cmd, signal: activeAbort?.signal });
      if (r.output.trim()) console.log(r.output.replace(/\n+$/, ""));
      if (r.code !== 0) console.log(c.dim(`  [exit ${r.code}]`));
    } catch (e) { console.log(c.red(`  ! failed: ${(e as Error).message}`)); }
    return false;
  }
  if (t.startsWith("/")) return handleCommand(t);
  await ensureProxyHealthy(); // revive a crashed OB-1-managed Free LLM API proxy before the turn
  // @path mentions — pull referenced files/dirs into the turn so the model sees them without a read_file
  // round-trip. The original typed line (`t`) is kept for checkpoints/recall/skill-learning; only the text
  // SENT to the model carries the attached contents.
  const mention = expandMentions(t, cfg.cwd);
  const turnText = mention.text;
  if (mention.attached.length) console.log(c.dim(`  📎 attached ${mention.attached.length} @mention(s): ${mention.attached.map((s) => "@" + s).join(", ")}`));
  if (mention.missing.length) console.log(c.dim(`  (no file for ${mention.missing.map((s) => "@" + s).join(", ")} — left as plain text)`));
  // Checkpoint the worktree + conversation position BEFORE running the prompt, so /rewind can return
  // here. Best-effort and only for real prompts (slash commands returned above). [[visible-progress-no-silent-work]]
  if (cfg.checkpoint) { try { checkpoints.snapshot(t, history.length); } catch { /* never block a turn on checkpointing */ } }
  // Heavy modes are sticky (persist until switched). To keep that from silently running every later
  // prompt at multiplied cost, show a visible reminder before each heavy turn — except the very first
  // turn right after selection (the user just chose it). `/solo` exits.
  if (cfg.mode === "fusion" || cfg.mode === "council" || cfg.mode === "personas") {
    if (!modeJustSet) console.log(c.yellow(`  ⚠ still in ${modeColor(cfg.mode)(cfg.mode.toUpperCase())} (${modeCostHint(cfg.mode)}) · ${c.cyan("/solo")} to exit`));
    modeJustSet = false;
  }
  const startLen = history.length;
  if (cfg.mode === "fusion") { await fusionTurn(turnText); rememberTurn(t, startLen, "fusion"); persistSession(); return false; }
  if (cfg.mode === "council") { await councilTurn(turnText); rememberTurn(t, startLen, "council"); persistSession(); return false; }
  if (cfg.mode === "personas") { await personasTurn(turnText); rememberTurn(t, startLen, "personas"); persistSession(); return false; }
  // (no `adaptive` branch — it's retired as a mode; auto-routing is the cfg.autoRoute toggle below)
  // Auto-route OFF: a pure-regex *nudge* (no extra model call) suggesting a heavier mode — purely advisory.
  if (!cfg.autoRoute) {
    const hint = suggestMode(t);
    if (hint) console.log(c.dim(`  💡 looks ${hint.why} — ${c.cyan("/mode " + hint.mode)} for deeper analysis · auto-route is off (${c.cyan("/autoroute on")} to enable). Continuing in Solo…`));
  }
  // Auto-route ON: Solo gets the `escalate` tool (offered via turnDeps.canEscalate) and decides DURING its
  // normal response whether the task needs a heavier mode. No upfront probe call — an easy turn is one Solo
  // call; only a genuinely hard turn pays for the heavier mode. If it escalated, forward the whole task.
  const outcome = await runTurn(turnText, history, turnDeps());
  if (outcome?.escalate) {
    const { mode, reason } = outcome.escalate;
    console.log(c.dim(`  ↗ Solo routed this to ${modeColor(mode)(mode)} — ${reason}`));
    if (mode === "fusion") await fusionTurn(turnText);
    else if (mode === "council") await councilTurn(turnText);
    else await personasTurn(turnText);
  }
  rememberTurn(t, startLen, outcome?.escalate ? `solo→${outcome.escalate.mode}` : "solo");
  persistSession(); // write the conversation so /resume can reopen it
  // Auto skill learning (opt-in, OFF by default): distil this turn into reusable procedural memory.
  // One cheap brain call, only on a substantive non-escalated Solo turn. Never blocks/breaks the turn.
  if (cfg.skillLearn && memBrain && !outcome?.escalate) {
    try {
      const res = await maybeLearnSkill({ cwd: cfg.cwd, slice: history.slice(startLen), existing: listSkills(cfg.cwd, { includeArchived: true }), ask: memBrain.ask });
      if (res.action !== "none" && res.name) console.log(c.dim(`  💾 ${res.action === "create" ? "learned" : "refined"} skill: ${c.cyan(res.name)}`));
    } catch { /* learning must never break a turn */ }
  }
  return false;
}

// ─── readline REPL (piped / non-TTY; also the fallback) ─────────────────────
async function runRepl(startup: string[]): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  let closed = false;
  const queue: string[] = [];
  const waiters: Array<(l: string | null) => void> = [];
  rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()!(null); });
  const nextLine = (): Promise<string | null> =>
    queue.length ? Promise.resolve(queue.shift()!) : closed ? Promise.resolve(null) : new Promise((res) => waiters.push(res));
  ui = {
    log: (s) => console.log(s),
    onText: (d) => stdout.write(d),
    endText: () => stdout.write("\n"),
    approve: async (desc) => { stdout.write(c.yellow(`  ⚠ approve ${desc} ${c.reset}[y/N] `)); const a = (await nextLine() ?? "").trim().toLowerCase(); return a === "y" || a === "yes"; },
    onUsage: () => { /* REPL prints its own per-turn token line */ },
    // Clarification fallback for the non-TTY REPL: print each question + numbered options, read one
    // line each. A number (or comma-separated numbers when multi) picks options; anything else is free text.
    askUser: async (req) => {
      const total = req.questions.length;
      const answers: string[] = [];
      for (let i = 0; i < total; i++) {
        const q = req.questions[i];
        const tag = total > 1 ? ` (${i + 1}/${total})` : "";
        stdout.write("\n" + c.cyan(`  ❓${tag} ${q.header ? `[${q.header}] ` : ""}${q.question}`) + "\n");
        q.options.forEach((o, j) => stdout.write(c.dim(`     ${j + 1}) ${o.label}${o.description ? " — " + o.description : ""}\n`)));
        stdout.write(c.dim(`     ${q.multiSelect ? "numbers (comma-separated)" : "a number"}, or type your own answer › `));
        const line = (await nextLine() ?? "").trim();
        let ans: string;
        if (!line) ans = "(no answer)";
        else {
          const nums = line.split(/[\s,]+/).map((s) => Number.parseInt(s, 10)).filter((n) => n >= 1 && n <= q.options.length);
          ans = (nums.length && /^[\s,\d]+$/.test(line)) ? [...new Set(nums)].map((n) => q.options[n - 1].label).join(", ") : line;
        }
        answers.push(total > 1 ? `${q.question} → ${ans}` : ans);
      }
      if (!answers.length) return "The user gave no answer. Proceed with your best judgment and state the assumption you made.";
      return total > 1 ? `The user answered:\n${answers.map((x) => `- ${x}`).join("\n")}` : `The user answered: ${answers[0]}`;
    },
    // Provider setup, non-TTY: print the blurb + location presets, prompt for the URL (and a model id when
    // the profile collects one), then the key — which is optional when the profile allows it (a keyless
    // local/LAN endpoint). Runs the live connection test before returning. Enter alone keeps the prefilled
    // default.
    providerSetup: async (opts) => {
      for (const l of opts.blurb) console.log(c.dim("  " + l));
      if (opts.presets.length) { console.log(c.dim("  locations:")); opts.presets.forEach((p, i) => console.log(c.dim(`     ${i + 1}) ${p.label} — ${p.hint} (${p.url})`))); }
      stdout.write(c.cyan("  Endpoint URL") + c.dim(` [${opts.initialUrl}] › `));
      const url = ((await nextLine()) ?? "").trim() || opts.initialUrl;
      let model: string | undefined;
      if (opts.collectModel) {
        stdout.write(c.cyan("  Model id") + (opts.initialModel ? c.dim(` [${opts.initialModel}]`) : opts.modelPlaceholder ? c.dim(` (${opts.modelPlaceholder})`) : "") + c.dim(" › "));
        model = ((await nextLine()) ?? "").trim() || opts.initialModel || "";
      }
      stdout.write(c.cyan("  API key") + c.dim(opts.keyOptional ? " (optional — Enter to skip)" : opts.initialKey ? " [keep current — Enter]" : "") + c.dim(" › "));
      const key = ((await nextLine()) ?? "").trim() || opts.initialKey;
      if (!url) { console.log(c.yellow("  setup needs a URL — cancelled")); return null; }
      if (!opts.keyOptional && !key) { console.log(c.yellow("  setup needs an API key — cancelled")); return null; }
      if (opts.collectModel && !model) { console.log(c.yellow("  setup needs a model id — cancelled")); return null; }
      console.log(c.dim("  " + (await opts.onTest(url, key))));
      return { url, key, model };
    },
    // Single-field text prompt, non-TTY: print the question and read one line. (No masking under the
    // plain REPL — the TUI masks; this path is the non-interactive fallback.)
    prompt: async (opts) => {
      stdout.write(c.cyan(`  ${opts.question}`) + c.dim(" › "));
      const line = await nextLine();
      return line === null ? null : line.trim();
    },
  };
  for (const s of startup) console.log(s);
  console.log("");
  while (!closed) {
    stdout.write(promptStr());
    const raw = await nextLine();
    if (raw === null) break;
    if (await processLine(raw)) break;
  }
  rl.close();
}

// ─── Ink TUI (interactive TTY) ──────────────────────────────────────────────
async function runTui(startup: string[]): Promise<void> {
  ctrl = new TuiController({ model: cfg.model, mode: cfg.mode, plan: cfg.planMode, inTok: 0, outTok: 0, cacheTok: 0, autopilot: cfg.permissionMode === "autopilot", effort: cfg.effort }, procs, agentReg, todos);
  // "Get Intelligent Models" footer button — shown only on the OB-1-managed Free LLM API provider (free
  // models only); Enter opens the subscription pricing page in the browser. Read live so switching
  // providers via /models toggles it. [[no-auto-escalation-to-expensive-modes]]
  ctrl.upsellEligible = () => cfg.providerProfile === "freellmapi";
  ctrl.onUpsell = () => { void openPricingPage(); };
  // @path autocomplete: complete against the workspace file list (built once, lazily, from the repo map so
  // it respects ignores). Prefix matches first, then substring; capped at 10.
  let _completeFiles: string[] | null = null;
  ctrl.completeFiles = (q: string): string[] => {
    if (!_completeFiles) { try { _completeFiles = buildRepoMap(cfg.cwd).files.map((f) => f.path).sort(); } catch { _completeFiles = []; } }
    const ql = q.toLowerCase();
    if (!ql) return _completeFiles.slice(0, 10);
    const pref = _completeFiles.filter((f) => f.toLowerCase().startsWith(ql));
    const sub = _completeFiles.filter((f) => !f.toLowerCase().startsWith(ql) && f.toLowerCase().includes(ql));
    return [...pref, ...sub].slice(0, 10);
  };
  // Open the parked error action (e.g. an upgrade link) when the user selects it via ↑ + Enter. If it
  // points at OUR managed server (the 402 upgrade link), go through the AUTHENTICATED handoff so checkout
  // attaches to THIS CLI's account — opening the raw URL would land on an anonymous/other browser session,
  // so the subscription would go to the wrong account and the CLI would never see it. Then watch for the
  // plan to activate and update live. Any other link just opens directly.
  ctrl.onErrorAction = (url) => {
    let onServer = false;
    try { onServer = new URL(url).host === new URL(ob1ServerUrl()).host; } catch { /* unparseable → not ours */ }
    if (onServer) {
      void openPricingPage("/pricing");
      watchForSubscription();
    } else {
      ctrl!.pushLine(c.dim(`  ↗ opening ${url} in your browser…`));
      void import("./cli/login.ts").then(({ openBrowser }) => openBrowser(url)).catch(() => {});
    }
  };
  // Seed the footer's monthly-usage bar (paid plans) / $-cost (free/BYOK). Fire-and-forget — never block
  // the TUI on a network call; the bar populates a moment after boot and refreshes after each turn.
  void refreshSubscriptionFooter();
  const origLog = console.log, origErr = console.error;
  // Route incidental console output (command handlers, mode turns) into the TUI scrollback.
  console.log = (...a: unknown[]) => ctrl!.pushLine(a.map((x) => String(x)).join(" "));
  console.error = (...a: unknown[]) => ctrl!.pushLine(a.map((x) => String(x)).join(" "));
  ui = {
    log: ctrl.pushLine,
    gap: ctrl.gap,
    onText: ctrl.stream,
    endText: ctrl.endStream,
    onReasoning: ctrl.reasoningDelta,
    endReasoning: ctrl.endReasoning,
    approve: ctrl.approve,
    onUsage: (u) => {
      accrue(u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0);
      if (u.estimated) ctrl?.setStatus({ estTok: true }); // sticky: the meter now contains estimated tokens
      // Context occupancy = this request's FULL input (uncached + cached + cache-creation) = current window use.
      ctrl?.setContext(u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    },
    // A router alias resolved to a concrete model — show it in the footer (only when we asked for a router,
    // so a normal concrete-model request doesn't render a redundant "x → x").
    onResolvedModel: (m) => { if (isRouterModel(cfg.model)) { cfg.resolvedModel = m; ctrl?.setStatus({ resolvedModel: m }); } }, // footer + next turn's system-prompt identity
    onErrorAction: (a) => ctrl?.setErrorAction(a), // park the action for ↑-from-the-prompt

    pick: ctrl.pick,
    pickReason: () => ctrl!.pickerDismiss,
    providerSetup: ctrl.providerSetup,
    prompt: ctrl.promptOpen,
    askUser: async (req) => {
      // Present the group one question at a time; combine the answers. A dismissal (←/Esc) stops the
      // batch and reports what was gathered so far.
      const total = req.questions.length;
      const answers: string[] = [];
      for (let i = 0; i < total; i++) {
        const q = req.questions[i];
        const a = await ctrl!.askUser({
          question: q.question, header: q.header, options: q.options, multi: q.multiSelect,
          progress: total > 1 ? { n: i + 1, total } : undefined,
        });
        if (a == null) {
          if (!answers.length) return "The user dismissed the question(s) without answering. Proceed with your best judgment and state the assumption you made.";
          answers.push(`${q.question} → (dismissed)`); break;
        }
        answers.push(total > 1 ? `${q.question} → ${a}` : a);
      }
      return total > 1 ? `The user answered:\n${answers.map((x) => `- ${x}`).join("\n")}` : `The user answered: ${answers[0]}`;
    },
  };
  for (const s of startup) ctrl.pushLine(s);
  // Submitting while a turn runs QUEUES the prompt; one drain loop runs the queue in order so the
  // next prompt fires automatically when the current finishes.
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      for (let t = ctrl!.dequeue(); t !== undefined; t = ctrl!.dequeue()) {
        ctrl!.gap(); // even spacing: a blank line before each user message
        ctrl!.pushUser(t); // submitted prompt → grey bar, white text (distinct from model output)
        ctrl!.recordHistory(t); // remember the dispatched prompt for ↑ recall (slash-commands skipped inside)
        suggestAbort?.abort(); ctrl!.clearSuggestion(); // a new turn supersedes any pending next-step suggestion
        ctrl!.setBusy(true);
        turnMutated = false; // reset the per-turn mutation flag (drives the ESC partial-edit warning)
        // Per-turn cancel handle: ESC aborts the in-flight call(s) AND clears any queued prompts.
        const ac = new AbortController();
        activeAbort = ac;
        ctrl!.cancelTurn = () => { ac.abort(); ctrl!.queue.length = 0; procs.killAll(); }; // ESC also kills any running bash
        try { if (await processLine(t)) { ctrl!.exit(); return; } }
        catch (e) { if (!ac.signal.aborted) { const fe = explainError((e as Error).message); ctrl!.pushLine(renderFriendly(fe, { action: false })); ctrl!.setErrorAction(fe.action); } }
        finally {
          // Single source of the "stopped" notice (loop.ts no longer prints it). If the turn had already
          // run a write/edit/bash, warn that the interrupted work may be only partially applied.
          if (ac.signal.aborted) ctrl!.pushLine(c.yellow("  ⊘ stopped" + (turnMutated ? c.dim(" — edits/commands this turn may be partially applied; review before continuing") : "")));
          activeAbort = null; ctrl!.cancelTurn = null;
          agentReg.clear(); // turn over → drop any spawned-subagent batch from the footer
          // …and if EVERY task in the list is completed, drop the finished list too — the model often
          // forgets the empty-array clear, leaving a stale "✔ tasks (6/6)" above the prompt. Only clear
          // when nothing is pending/in_progress, so a plan that legitimately spans turns still persists.
          if (todos.size > 0 && todos.done === todos.size) todos.clear();
          ctrl!.setStatus({ model: cfg.model, mode: cfg.mode, plan: cfg.planMode, autopilot: cfg.permissionMode === "autopilot" }); ctrl!.setBusy(false);
          // After a real (model) turn that wasn't interrupted, propose a likely next prompt (Tab accepts).
          // Skip slash-commands (no model exchange to base it on) and the queued case (a next prompt is
          // already waiting). Fire-and-forget — it must not block the drain loop.
          if (!ac.signal.aborted && !t.startsWith("/") && ctrl!.queue.length === 0) void generateSuggestion();
          // A model turn just spent credits on the managed plan → refresh the footer's monthly-usage bar.
          if (!t.startsWith("/")) void refreshSubscriptionFooter();
        }
      }
    } finally { draining = false; }
  };
  ctrl.onSubmit = (line) => { const t = line.trim(); if (!t) return; ctrl!.enqueue(t); void drain(); };
  await startTui(ctrl).waitUntilExit();
  console.log = origLog; console.error = origErr;
}

// ─── boot ───────────────────────────────────────────────────────────────────
const startup: string[] = [];
startup.push(banner());
// Access line: show the subscription plan or "Free LLM API" — never the raw wire provider ("openai") or
// the server/localhost URL (users don't need either; the wire protocol is an implementation detail).
{
  const onManaged = !cfg.providerProfile && cfg.provider === "openai" && cfg.baseUrl.startsWith(ob1ServerUrl());
  let accessLine: string;
  if (cfg.providerProfile === "freellmapi") {
    accessLine = "Free LLM API";
  } else if (onManaged) {
    if (!loadAuthToken()) {
      accessLine = "Not signed in — run `ob1 login`";
    } else {
      const plan = await fetchPlan(2500);
      accessLine = !plan ? "Subscription"
        : plan.plan === "free" ? "Subscription — no active plan (run /upgrade)"
        : `${plan.plan.charAt(0).toUpperCase() + plan.plan.slice(1)} plan`;
    }
  } else {
    // BYOK / direct provider (your own key) — name it by host, never the misleading wire "openai".
    const host = (() => { try { return new URL(cfg.baseUrl).host; } catch { return ""; } })();
    const name = host.includes("openrouter") ? "OpenRouter"
      : host.includes("anthropic") || cfg.provider === "anthropic" ? "Anthropic"
      : host.includes("openai.com") ? "OpenAI" : "Direct API";
    accessLine = `${name} · your key`;
  }
  startup.push(c.dim(`  ${accessLine}`));
}
startup.push(c.dim(`  model: ${cfg.model} — ${describeModel(cfg.model)}${cfg.maxTokens ? ` · capped ${cfg.maxTokens}` : " · output governed by model"}`));
if (hasPersistedSettings(cfg.settingsDir)) startup.push(c.dim("  settings restored (global ~/.ob1/settings.json) — change with /models or individual slash commands"));
// Settings health: a hand-edited settings.json with a bad value silently fell back to a default — say
// so, so a typo'd sandbox/mode isn't a silent mystery. Warnings (unknown keys) are shown dimmer.
{
  const health = settingsHealth(cfg.settingsDir);
  if (health.errors.length) startup.push(c.yellow(`  ⚠ ignored invalid settings (using defaults):\n${formatSettingsIssues({ ...health, warnings: [] })}`));
}
// Folder trust: running an UNFAMILIAR project unattended is the classic foot-gun. The downgrade
// (autopilot→ask in an untrusted folder) is OPT-IN via OB1_TRUST_GATE so it never adds friction to
// normal/dev use; when enabled, an untrusted folder downgrades until the user runs `/trust`.
{
  if (/^(1|true|on)$/i.test(process.env.OB1_TRUST_GATE ?? "")) {
    const trusted = isTrusted(cfg.cwd, loadTrust(cfg.settingsDir));
    const eff = effectivePermissionMode(cfg.permissionMode, trusted);
    if (eff.downgraded) { cfg.permissionMode = "ask"; startup.push(c.yellow("  ⚠ untrusted folder — autopilot downgraded to ask. Run /trust to trust this workspace.")); }
  }
  if (policy.rules.length) startup.push(c.dim(`  policy: ${policy.rules.length} rule(s) from .ob1/policy.json`));
  if (policy.errors.length) startup.push(c.yellow(`  ⚠ ${policy.errors.length} invalid policy rule(s) ignored — ${policy.errors[0]}`));
  if (hooks.hooks.length) startup.push(c.dim(`  hooks: ${hooks.hooks.length} from .ob1/hooks.json (${[...new Set(hooks.hooks.map((h) => h.event))].join(", ")})`));
  if (hooks.errors.length) startup.push(c.yellow(`  ⚠ ${hooks.errors.length} invalid hook(s) ignored — ${hooks.errors[0]}`));
}
// Stale base: if the branch is behind/diverged from upstream, the agent would edit a stale base — warn
// up front so the user can rebase first (best-effort; read-only git, short timeout).
try {
  const gs = await readGitState(cfg.cwd, (cmd) => shellExec({ cwd: cfg.cwd, sandbox: cfg.sandbox, command: cmd, timeoutMs: 4000 }));
  const a = analyzeBranch(gs);
  if (a.stale) startup.push(c.yellow(`  ⚠ ${a.recommendation}`));
} catch { /* best-effort — never block boot on git */ }
// One-time migration note: `adaptive` mode is now the Solo auto-route toggle. loadConfig collapsed any
// adaptive workspace to Solo, so this is always accurate; saveSettings rewrites mode:"solo" → shows once.
if (persistedSettings(cfg.settingsDir).mode === "adaptive") {
  startup.push(c.yellow(`  note: 'adaptive' mode is now a Solo auto-route toggle — you're in Solo (auto-route ${cfg.autoRoute ? "on" : "off"}). Change it with /autoroute.`));
  saveSettings(cfg);
}
// If the active provider is an OB-1-managed FreeLLMAPI proxy, make sure it's running (Docker persists
// across restarts; a Node-run proxy died with the last session). Best-effort — fast when already up.
if (cfg.providerProfile === "freellmapi") {
  try {
    const flm = await import("./cli/freellm-manage.ts");
    const st = flm.loadManaged();
    if (st?.managed && !(await flm.isUp(st.url))) {
      startup.push(c.dim("  starting your local Free LLM API proxy…"));
      if (!(await flm.ensureRunning(st))) startup.push(c.yellow("  ⚠ couldn't auto-start the Free LLM API proxy — run /freellm to restart"));
    }
  } catch { /* best-effort */ }
}
// Load tree-sitter grammars before the repo map / AGENTS.md so symbol extraction uses real parsing
// (falls back to the regex extractor if unavailable). Best-effort — never blocks startup on failure.
await initTreeSitter().catch(() => false);
{ const ts = treeSitterStatus(); if (ts.ready) startup.push(c.dim(`  repo map: tree-sitter (${ts.grammars.length} grammars)`)); }
if (store.vectorBackend() === "sqlite-vec") startup.push(c.dim("  memory: sqlite-vec KNN index"));
if (store.recovered) startup.push(c.yellow(`  ⚠ memory.db was corrupt — moved it to ${store.recovered} and started a fresh store.`));
// Don't scaffold AGENTS.md into a workspace that doesn't have one — that would drop an unrequested,
// untracked file into the user's repo. Keep an EXISTING one's managed sections current; when there's none,
// the system prompt falls back to an in-memory project index (see systemPrompt). Create on demand via /agents.
if (existsSync(join(cfg.cwd, "AGENTS.md"))) {
  const r = refreshAgentsMd(cfg.cwd, loadAgentsMemory(cfg.cwd));
  if (r.updated) startup.push(c.dim("  refreshed AGENTS.md (managed sections)"));
}
// Skill curator: age learned skills by inactivity (active→stale→archived; reactivate on use). Cheap,
// file-based, touches only agent-created skills. Surface a note only when something actually changed.
try {
  const cur = runCurator(cfg.cwd);
  const bits = [cur.staled.length && `${cur.staled.length} → stale`, cur.archived.length && `${cur.archived.length} → archived`, cur.reactivated.length && `${cur.reactivated.length} reactivated`].filter(Boolean);
  if (bits.length) startup.push(c.dim(`  skills curated: ${bits.join(", ")}`));
} catch { /* curation is best-effort */ }
mcp = await loadMcpServers(cfg.cwd);
deferredMcp = new Map(mcp.tools.map((t) => [t.def.name, t]));
if (deferredMcp.size) tools.set("load_mcp_tool", makeMcpLoaderTool(tools, deferredMcp));
for (const line of mcp.summary) startup.push(c.dim("  " + line));
if (deferredMcp.size) startup.push(c.dim(`  ${deferredMcp.size} MCP tool(s) deferred — loaded on demand via load_mcp_tool`));
if (!modelReachable()) startup.push(c.yellow("  ⚠ not signed in — model disabled; memory + /commands still work. Run `ob1 login` to sign in to the managed server (free models), or /models to connect another provider, or export a key."));
// Surface the sandbox state at startup so env-configured (OB1_SANDBOX) sessions see a LOUD warning
// when the requested sandbox can't be enforced — not only when /sandbox is run interactively.
if (cfg.sandbox !== "off") {
  const tint = sandboxAvailable() ? c.dim : c.yellow;
  startup.push(tint(`  sandbox: ${cfg.sandbox}${sandboxNote(cfg.sandbox)}`));
}

try {
  if (stdin.isTTY) await runTui(startup); // interactive → Ink; piped/non-TTY → readline REPL
  else await runRepl(startup);
} catch (e) {
  console.error(c.red("fatal: " + (e as Error).message));
}
for (const cl of mcp.clients) cl.close();
store.close();
console.log(c.dim("\n  bye 👋"));
process.exit(0);
