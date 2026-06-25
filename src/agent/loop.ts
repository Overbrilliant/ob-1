// The gated agent loop (Phase 0) — the heart of Solo mode.
// ReAct: the model reasons, calls tools, observes results, repeats until end_turn.
// Plan/Act gate + per-action approval sit before every mutating tool (R6).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { callModel, isRetryable, type Message, type ContentBlock, type ToolDef, type Usage, type SystemBlock } from "../providers/gateway.ts";
import { modelSpec, isRouterModel, supportsEffort } from "../providers/models.ts";
import { isDestructiveCall, normalizeToolOutput, toolCallChangesWorkspace, toolCallMutates, toolResultContent, type Tool, type ReadCache } from "./tools.ts";
import { classifyIntent } from "../safety/bash-validation.ts";
import { recoveryHint } from "./recovery.ts";
import { evaluatePolicy, type PolicyRule } from "../safety/policy.ts";
import type { ApprovalStore } from "./approval-tokens.ts";
import { runHooks, type HookConfig, type HookExec } from "./hooks.ts";
import { isOpenRouterEndpoint, type Config } from "../config.ts";
import type { MemoryStore, Fact } from "../memory/store.ts";
import { loadAgentsMd } from "../context/agents.ts";
import { listTopics } from "../context/topics.ts";
import { repoMapSummary, invalidateRepoMap } from "../context/repomap.ts";
import { listSkills } from "../skills/registry.ts";
import { editContext, compactIfNeeded } from "./context.ts";
import { detectChecks } from "./verify.ts";
import { c, renderDiff, renderFriendly, explainError } from "../cli/ui.ts";
import { runWorker, type WorkerEvent } from "../multimind/runtime.ts";
import { runSubagents, formatSubagentFindings, writeSubagentReport, reportEnabled, MAX_SUBTASKS, type SubagentTask } from "../multimind/subagents.ts";
import { runWriteSubagents, applyMerge, type WriteAssignment } from "../multimind/subagents-write.ts";
import type { AgentRegistry } from "./agent-registry.ts";

export interface TurnDeps {
  cfg: Config;
  tools: Map<string, Tool>;
  store: MemoryStore;
  /** Per-turn read-dedup cache shared with `tools`' read_file. The loop clears it at turn start and
   *  on every context eviction so a dedup pointer can never reference content no longer in history. */
  readCache?: ReadCache;
  approve: (desc: string) => Promise<boolean>;
  log: (s: string) => void;
  /** Emit a single deduped blank line between stream blocks (response · tool call) for even spacing. */
  gap?: () => void;
  /** Stream assistant text live (stdout for the REPL, React state for the TUI). */
  onText?: (delta: string) => void;
  /** Flush/commit the streamed block (REPL: newline; TUI: move it into scrollback). */
  endText?: () => void;
  /** Stream the model's reasoning/thinking live (TUI shows it behind the Ctrl+O toggle). */
  onReasoning?: (delta: string) => void;
  /** Flush any trailing reasoning (turn end / tool-only turn with no answer text). */
  endReasoning?: () => void;
  /** Per-response token usage, for a live cost/token meter. */
  onUsage?: (u: Usage) => void;
  /** The model the provider actually used (for a router request like `auto`) — lets the UI show what it
   *  resolved to instead of the bare alias. Fired only when the response reports a model. */
  onResolvedModel?: (model: string) => void;
  /** A turn ended in an actionable error — carries the action (e.g. an "Upgrade your plan" link) so the
   *  TUI can park it on ↑-from-the-prompt. undefined when the error has no clickable action. */
  onErrorAction?: (action?: { label: string; url: string }) => void;
  /** Fired the first time a MUTATING tool actually runs this turn (a write/edit/bash). Lets the dispatcher
   *  warn, if the turn is then ESC-aborted, that files/commands may be left partially applied. */
  onMutate?: () => void;
  /** Auto-verify hook: when the model finishes a turn that CHANGED files, run the project's fast checks
   *  (typecheck/compile). If it returns ran && !ok, the loop feeds the failures back and the model
   *  self-corrects. Always wired in Act mode; undefined in read-only Plan mode (no command execution). */
  verify?: () => Promise<{ ran: boolean; ok: boolean; report: string } | null>;
  /** Max self-correction rounds before giving up and leaving the changes for the user (default 3). */
  autofixMax?: number;
  /** Declarative policy rules (from .ob1/policy.json) evaluated before the approval gate: a "deny" rule
   *  blocks a tool call, "allow" auto-approves it (no prompt), "warn" tags the prompt. Empty/undefined
   *  ⇒ the normal gate applies. */
  policy?: PolicyRule[];
  /** Session capability tokens (user-granted via /allow): a covering token auto-approves a mutating call
   *  so the gate doesn't re-prompt for, e.g., every git command. Finite tokens decrement per use. */
  approvals?: ApprovalStore;
  /** Programmable hooks (from .ob1/hooks.json) + the executor that runs them. PreToolUse can block a
   *  call; PostToolUse / PostToolUseFailure inject feedback into the tool result. No-op when empty. */
  hooks?: HookConfig[];
  hookExec?: HookExec;
  /** External cancellation (ESC) — stops the turn between/within model calls. */
  signal?: AbortSignal;
  /** When true, Solo is offered the `escalate` tool — it may hand the whole turn to a heavier mode
   *  (set from cfg.autoRoute). Suppressed on apply turns so a mode's own result can't re-escalate. */
  canEscalate?: boolean;
  /** When true, Solo is offered the `spawn_subagents` tool — it may fan out independent read-only
   *  sub-tasks in parallel (set from cfg.subagents). Suppressed on apply turns (no nested spawn). */
  canSpawn?: boolean;
  /** When true, Solo is offered the `spawn_write_subagents` tool — parallel EDITS in isolated worktrees
   *  (set from OB1_SUBAGENTS_WRITE). High-risk, default off; suppressed on apply turns. */
  canSpawnWrite?: boolean;
  /** Live per-worker progress for spawned subagents (the inline meter — the orchestrator's workerProgress). */
  onWorkerEvent?: (ev: WorkerEvent) => void;
  /** Footer progress tracker for spawned subagents (the TUI renders each agent's live status). */
  agentReg?: AgentRegistry;
  /** Injectable model call (tests only) — defaults to the real gateway callModel. */
  _callModel?: typeof callModel;
  /** Injectable worker runner for spawn_subagents (tests only) — defaults to the real runWorker. */
  _runWorker?: typeof runWorker;
}

/** A heavier multi-agent mode Solo can route a hard turn to (the escalation targets). */
export type HeavyMode = "fusion" | "council" | "personas";

/** What a Solo turn yields back to the dispatcher. `escalate` set ⇒ Solo judged the task too
 *  complex for one pass and the caller should re-run it in the named mode. */
export interface TurnOutcome { escalate?: { mode: HeavyMode; reason: string } }

// The LLM router: instead of a brittle regex guessing difficulty up front (and paying a probe call),
// Solo decides DURING the response it was already making. If the task is too hard/high-stakes for a
// single pass, it calls `escalate` and the dispatcher forwards the whole turn — otherwise it just
// answers, so an easy turn costs exactly one Solo call. Only advertised when canEscalate (autoRoute on).
const ESCALATE_TOOL: ToolDef = {
  name: "escalate",
  description:
    "Hand THIS task off to a heavier multi-agent mode when solving it well in a single pass is unlikely. " +
    "Call it BEFORE doing the work (it forwards the whole task; you won't continue). Default to answering " +
    "directly — only escalate when one pass would be wrong or shallow. Pick the mode by failure shape: " +
    "fusion = a hard/tricky algorithm or performance problem (parallel best-of-N, then merge); " +
    "council = a correctness-, security-, or risk-critical change (author ↔ reviewer revise rounds, then a finalizer); " +
    "personas = an open-ended design / architecture / trade-off question (a tailored expert-panel dialogue).",
  input_schema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["fusion", "council", "personas"], description: "the heavier mode to route to" },
      reason: { type: "string", description: "one concise phrase on why a single Solo pass is insufficient" },
    },
    required: ["mode", "reason"],
  },
};

// Decomposition parallelism: Solo splits a big task into INDEPENDENT read-only sub-tasks and runs them
// concurrently, getting each one's findings back to synthesize. Distinct from escalate (which forwards a
// whole turn to a heavier mode). Only advertised when canSpawn (cfg.subagents on).
const SPAWN_TOOL: ToolDef = {
  name: "spawn_subagents",
  description:
    "Run several INDEPENDENT sub-tasks in parallel as isolated, read-only subagents, and get each one's " +
    "findings back. Use ONLY for a big task that genuinely splits into parts that don't depend on each " +
    "other — e.g. investigate N different files/areas, research N options, audit N modules. Each subagent " +
    "works in its own context with read-only tools and returns a concise summary; THEN you synthesize the " +
    "results and make any edits yourself. Don't use it for small, serial, or interdependent work, and don't " +
    `pass more than ${MAX_SUBTASKS} sub-tasks.`,
  input_schema: {
    type: "object",
    properties: {
      subtasks: {
        type: "array",
        description: "the independent sub-tasks to run in parallel",
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: "a complete, self-contained instruction (subagents can't ask follow-ups)" },
            context: { type: "string", description: "optional shared framing prepended to the task" },
          },
          required: ["task"],
        },
      },
      model: { type: "string", description: "optional model override for the subagents" },
    },
    required: ["subtasks"],
  },
};

// Write-capable parallel subagents (item #2). OPT-IN (OB1_SUBAGENTS_WRITE) and high-risk: each agent
// edits an EXPLICIT, DISJOINT file set in its own git worktree; overlap is refused; the merge is gated.
const SPAWN_WRITE_TOOL: ToolDef = {
  name: "spawn_write_subagents",
  description:
    "Run several INDEPENDENT code-EDITING sub-tasks in parallel, each in an isolated git worktree, then " +
    "merge the results through one approval gate. Use ONLY when the work splits into parts that edit " +
    "DISJOINT files (no file may be assigned to two agents — that is refused). Each agent declares the exact " +
    "files it will edit. If any two agents touch the same file the whole batch aborts untouched. Prefer " +
    "editing yourself for small or interdependent changes; this is for genuinely parallel, file-disjoint work.",
  input_schema: {
    type: "object",
    properties: {
      subtasks: {
        type: "array",
        description: "the independent editing sub-tasks; their `files` sets must be disjoint",
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: "a complete, self-contained editing instruction" },
            files: { type: "array", items: { type: "string" }, description: "the exact file paths this agent may edit (its lane)" },
          },
          required: ["task", "files"],
        },
      },
    },
    required: ["subtasks"],
  },
};

/** Run a spawn_subagents tool call: validate, fan out via runSubagents, return formatted findings to Solo.
 *  `parentTask` (the user's turn input) is recorded in the saved review report. */
async function handleSpawn(input: any, deps: TurnDeps, parentTask: string): Promise<string> {
  const raw = Array.isArray(input?.subtasks) ? input.subtasks : [];
  const subtasks: SubagentTask[] = raw
    .map((s: any) => (typeof s === "string" ? { task: s } : { task: String(s?.task ?? "").trim(), context: s?.context ? String(s.context) : undefined }))
    .filter((s: SubagentTask) => s.task.length > 0);
  if (subtasks.length === 0) return "spawn_subagents: no valid sub-tasks provided (need a non-empty `subtasks` array, each with a `task`).";
  deps.log(c.cyan(`  ⇉ spawning ${subtasks.length} parallel subagent${subtasks.length === 1 ? "" : "s"}…`) + c.dim(` (read-only · ~${subtasks.length}× a Solo investigation)`));
  const r = await runSubagents({
    subtasks, cfg: deps.cfg, tools: deps.tools,
    model: typeof input?.model === "string" ? input.model : undefined,
    onEvent: deps.onWorkerEvent, registry: deps.agentReg, signal: deps.signal,
    _run: deps._runWorker,
  });
  const ok = r.results.filter((x) => x.ok).length;
  deps.log(c.dim(`  ⇇ ${ok}/${r.results.length} subagents done · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens`));
  // Durable, reviewable artifact: the full per-subagent findings the user can open later (the bounded
  // tool_result that scrolls away is not enough). Default on; best-effort so a write failure never
  // breaks the turn. [[visible-progress-no-silent-work]]
  if (reportEnabled()) {
    try {
      const path = writeSubagentReport(deps.cfg.dataDir, parentTask, subtasks, r, new Date().toISOString());
      deps.log(c.dim(`  ↳ saved review report → ${path}`));
    } catch { /* report is a bonus; never fail the turn over it */ }
  }
  return formatSubagentFindings(subtasks, r);
}

/** Run a spawn_write_subagents call: parse {task, files} assignments, run the guarded worktree write
 *  path, and on a clean disjoint result apply the merge through the normal approval gate. */
async function handleSpawnWrite(input: any, deps: TurnDeps): Promise<string> {
  const raw = Array.isArray(input?.subtasks) ? input.subtasks : [];
  const assignments: WriteAssignment[] = raw
    .map((s: any, i: number) => ({ label: `writer-${i + 1}`, task: String(s?.task ?? "").trim(), files: Array.isArray(s?.files) ? s.files.map((f: any) => String(f)).filter(Boolean) : [] }))
    .filter((a: WriteAssignment) => a.task && a.files.length);
  if (assignments.length === 0) return "spawn_write_subagents: each sub-task needs a `task` and a non-empty `files` lane.";
  deps.log(c.cyan(`  ⇉ ${assignments.length} write-subagents in isolated worktrees…`) + c.dim(" (disjoint files · merge is gated)"));
  const r = await runWriteSubagents({ assignments, cfg: deps.cfg, tools: deps.tools, onEvent: deps.onWorkerEvent, signal: deps.signal, _run: deps._runWorker });
  if (!r.ok) {
    const where = r.conflicts.map((cf) => `${cf.file} (${cf.labels.join(" + ")})`).join(", ");
    deps.log(c.yellow(`  ⇇ write-subagents aborted: ${r.reason}`));
    return `spawn_write_subagents aborted — ${r.reason}.${where ? ` Conflicting files: ${where}.` : ""} Nothing was written. Re-plan with disjoint file lanes, or make the edits yourself.`;
  }
  deps.onMutate?.(); // a write is about to be offered to the gate
  const written = await applyMerge(deps.cfg.cwd, r.changes, deps.approve);
  if (written.length === 0) return `Write-subagents produced ${r.changes.length} file change(s) but the merge was declined — nothing written.`;
  deps.log(c.dim(`  ⇇ merged ${written.length} file(s) from ${assignments.length} write-subagents · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tokens`));
  return `Applied ${written.length} file change(s) from ${assignments.length} write-subagents (disjoint, conflict-checked): ${written.join(", ")}.`;
}

// Per-turn cap on tool-call rounds. DEFAULT IS UNLIMITED (like Claude Code): a turn runs until the
// model stops calling tools — bounded by the context compaction above (history never grows unbounded)
// and the server-side monthly credit pool (chat 402s when credits run out), not an arbitrary step
// count. A high RUNAWAY backstop still pauses a *pathological* stuck loop CLEANLY (work kept, "continue"
// resumes) so a runaway can't silently drain a whole plan. Override via OB1_MAX_STEPS:
//   unset            → unlimited in practice (paused only at the runaway backstop)
//   a number N (≥1)  → hard cap at N steps
//   0 | unlimited    → truly uncapped, even the backstop removed
const RUNAWAY_STEPS = 1000; // safety net only; effectively unreachable for real agentic tasks
function resolveMaxSteps(): number {
  const raw = (process.env.OB1_MAX_STEPS ?? "").trim().toLowerCase();
  if (raw === "") return RUNAWAY_STEPS;                                  // default: unlimited-in-practice
  if (raw === "0" || raw === "unlimited" || raw === "none") return Infinity; // explicit, no backstop
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : RUNAWAY_STEPS;   // a finite cap, else fall back
}
const MAX_STEPS = resolveMaxSteps();
const UNCAPPED = MAX_STEPS === Infinity || MAX_STEPS === RUNAWAY_STEPS;  // whether the cap is a real limit or just a safety net

/** A small, lean system prompt, split for prompt caching into a STABLE block (cached: session-constant
 *  instructions, skills, the repo map) and a VOLATILE tail (uncached: per-turn semantic memory, the
 *  date, model identity). The split keeps the big static prefix a cross-step / cross-turn cache HIT
 *  while the small per-turn content rides outside the breakpoint — so it never busts the cache.
 *  Injects only a bounded, relevant slice of memory (R3 — semantic top-k for this turn). */
export function systemPrompt(cfg: Config, store: MemoryStore, retrieved?: Fact[]): SystemBlock[] {
  const chosen = retrieved && retrieved.length ? retrieved : store.listFacts().slice(-12);
  const memLabel = retrieved && retrieved.length ? "Relevant project memory (semantic top-k)" : "Known project memory";
  const facts = chosen.map((f) => `- ${f.fact}`).join("\n");
  const rels = store.listRelationships().slice(-8).map((e) => `- ${e.src} --${e.rel}--> ${e.dst}`).join("\n");
  const agents = loadAgentsMd(cfg.cwd);
  const skills = listSkills(cfg.cwd);
  const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const topicList = listTopics(cfg.cwd).map((t) => `- ${t.name}`).join("\n");
  // STABLE block — constant for the whole session (mode/skills/agents/repo map). Cached: re-billed at
  // ~10–25% on every step instead of full price.
  const stable = [
    "You are OB-1, a precise, token-frugal CLI coding agent. Keep responses concise.",
    agents ? `Project index (AGENTS.md):\n${agents}` : "",
    topicList ? `On-demand topic files (call read_topic with the name to load detailed notes):\n${topicList}` : "",
    skillList ? `Available skills (call use_skill with the name to load full instructions when relevant):\n${skillList}` : "",
    "When a non-trivial approach succeeds (or the user corrects you into one that works), you may save it as a reusable skill with manage_skill(create) — capture the general method, not a one-off; prefer updating a related skill over creating a near-duplicate.",
    cfg.planMode
      ? "MODE: PLAN (read-only). Do NOT modify files or run commands — investigate and propose a plan. The user will switch to Act mode to execute."
      : "MODE: ACT. You may edit files and run commands; mutating actions are gated by user approval.",
    "Principles: read before you edit; make the smallest correct change; prefer edit_file (search/replace) over rewriting whole files. Prefer plain CLI tools via run_bash (e.g. `gh`, `git`, `rg`) when they are more token-efficient than reading many files. For a large file, read_file accepts offset/limit (a 1-based line range) — read only the slice you need instead of the whole file. When you learn a durable project fact or a code relationship, persist it with memory_add / relate. When the task hinges on a decision only the user can make (a missing requirement, or a choice between approaches), call ask_user with a few options instead of guessing.",
    "Don't give up early. You have full access to this machine: when a goal needs a capability you don't have, get it" + (cfg.planMode ? " (in Act mode, by installing the package or tool via run_bash)" : " — install whatever package or tool via run_bash") + " instead of declaring it impossible. Only after genuinely exhausting your options, say what's blocking and offer alternatives.",
    "Long-lived commands: never run a server, watcher, or other process that does not exit (e.g. `npm run dev`, `bun serve`, a `localhost`) as a normal run_bash call — it would block the turn. Pass background:true; it returns immediately with a process id and keeps running. Then call the `list_bash` TOOL to read its buffered output (e.g. the served URL), and call the `kill_bash` TOOL to stop it when done. Do NOT type `list_bash` or `kill_bash(id)` inside run_bash; they are tools, not shell commands.",
    "run_bash working directory: each command starts FRESH in the workspace root — the cwd does NOT persist between calls, so a `cd` in one call is forgotten by the next. To act inside a folder you created (e.g. a scaffolded project), pass the `cwd` argument (relative to the workspace) or chain it in ONE command, e.g. `cd overbrilliant && npm install && npm run build`. This applies to background commands too — start a dev server in the project's own directory.",
    cfg.planMode ? "" :
      "Verify your work — don't declare done on untested code. After changing code, decide which checks fit the change and run the `verify` tool: 'auto' for a fast compile/typecheck gate, or name the kinds (e.g. 'typecheck,test' or 'build') for behavioural changes. Read the failures and fix them, then re-verify until it's green. (OB-1 also auto-runs the fast gate after any file-changing turn and feeds failures back to you — so treat a reported failure as work to finish, not noise.) If a failure is genuinely pre-existing or unrelated to your change, say so explicitly rather than ignoring it. " +
      "CRITICAL for UI / visual / interactive work (a toggle, button, form, route, styling, dark mode): a passing build or typecheck does NOT prove the feature works — code that compiles can still do nothing when clicked. You MUST verify behaviour with the `browser_check` tool. For static HTML/CSS/JS pages, pass the workspace file path directly (e.g. `site/index.html`) and avoid starting a server. For framework apps, start the dev server (run_bash background), get its URL by calling the list_bash TOOL, then browser_check it. Drive the actual interaction (click the toggle) and assert the observable result CHANGED (e.g. the body background colour or the html data-theme attribute is different after the click). Never tell the user a visual feature is done until browser_check passes; `curl` and `grep` only confirm the code is PRESENT, not that it WORKS. Verify enough to be sure, then STOP: once the relevant check (or one browser_check that drives the interaction) passes green, the work is done — don't re-run the same verification again and again or keep polishing what already works.",
    "Ground facts in real sources — never fabricate. For anything about current events, external products, libraries, APIs, or install steps, use web_search and then web_fetch to verify before stating it; do not invent commands, URLs, version numbers, prices, or features. If you can't verify something (the right tool is missing, a call failed, or web_search is unavailable), say so plainly instead of guessing — and never write unverified claims into a file.",
    // Auto repo map: a fresh, budgeted view of the codebase structure so the model always knows what
    // it's working with. Lives in the CACHED block (it's session-stable: the deterministic render only
    // changes when the file set / symbols change, so a content-only edit keeps the cache warm). Full
    // detail via the repo_map tool. Toggled by cfg.repoMap (/settings → repo-map; OB1_REPO_MAP). Default on.
    (() => { const m = cfg.repoMap ? repoMapSummary(cfg.cwd) : ""; return m ? `${m}\n(call repo_map for the full, deeper map)` : ""; })(),
  ].filter(Boolean).join("\n\n");
  // VOLATILE tail — changes per turn (semantic memory) or per response (router identity), so it stays
  // OUTSIDE the cache breakpoint. The identity is derived from cfg (set by /models · OB1_MODEL ·
  // persisted settings), never hardcoded. For a router alias (`auto`) the concrete backend varies per
  // request, so we tell the model what the last request resolved to (cfg.resolvedModel) and that it can
  // vary, so it answers "which model are you?" honestly instead of parroting the wire protocol.
  const volatile = [
    facts ? `${memLabel}:\n${facts}` : "",
    rels ? `Known relationships:\n${rels}` : "",
    `Today's date is ${new Date().toISOString().slice(0, 10)}. ${modelIdentity(cfg)}`,
  ].filter(Boolean).join("\n\n");
  return [{ text: stable, cache: true }, { text: volatile, cache: false }];
}

/** The model-identity sentence for the system prompt. A concrete model → its label + id + provider. A
 *  router alias (`auto`) → an honest description: provider-routed, the concrete backend varies per
 *  request, and (when known) the model the last request resolved to — so the model doesn't claim to be
 *  something it isn't. */
function modelIdentity(cfg: Config): string {
  if (!isRouterModel(cfg.model)) {
    return `You are running on ${modelSpec(cfg.model)?.label ?? cfg.model} (model "${cfg.model}", provider ${cfg.provider}).`;
  }
  const resolved = cfg.resolvedModel;
  const base = "You are reached through a model router (an OpenAI-compatible proxy) that selects a model per request, so your exact underlying model can vary between requests and \"openai\" is only the wire protocol, not your vendor.";
  if (resolved) {
    return `${base} The most recent request was routed to ${modelSpec(resolved)?.label ?? resolved} (id "${resolved}"). If asked which model you are, say you're provider-routed and that the last/likely model is this one — don't claim to be a specific vendor's assistant or invent a version.`;
  }
  return `${base} The concrete model isn't known until a response returns. If asked which model you are, say you're provider-routed and the exact model varies per request — don't guess a specific identity.`;
}

function preview(input: any): string {
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

export function describe(name: string, input: any): string {
  if (name === "write_file") return `write_file ${input.path}`;
  if (name === "edit_file") return `edit_file ${input.path}`;
  if (name === "run_bash") return `run_bash${input.background ? " (background)" : ""}: ${input.command}`;
  if (name === "kill_bash") return `kill_bash #${input.id}`;
  if (name === "list_bash") return "list_bash";
  if (name === "escalate") return `escalate → ${input.mode}`;
  if (name === "spawn_subagents") return `spawn_subagents (${Array.isArray(input?.subtasks) ? input.subtasks.length : 0})`;
  if (name === "spawn_write_subagents") return `spawn_write_subagents (${Array.isArray(input?.subtasks) ? input.subtasks.length : 0})`;
  if (name === "update_tasks") { const ts = Array.isArray(input?.tasks) ? input.tasks : []; const done = ts.filter((t: any) => /^(completed|done|complete)$/i.test(String(t?.status ?? ""))).length; return ts.length ? `update_tasks (${done}/${ts.length} done)` : "update_tasks (clear)"; }
  if (name === "manage_skill") return `manage_skill ${input?.action ?? "?"}: ${input?.name ?? "?"}`;
  return `${name} ${preview(input)}`;
}

/** A colored diff preview of a pending file mutation, shown before the approval gate. null if none. */
function previewFileChange(cfg: Config, name: string, input: any): string | null {
  try {
    if (name === "edit_file") return renderDiff(String(input.old_string ?? ""), String(input.new_string ?? ""), input.path) || null;
    if (name === "write_file") {
      let before = "";
      try { before = readFileSync(resolve(cfg.cwd, input.path), "utf8"); } catch { /* new file */ }
      return renderDiff(before, String(input.content ?? ""), input.path) || null;
    }
  } catch { /* ignore preview failures */ }
  return null;
}

// Make bash activity VISIBLE to the user — a run_bash result is otherwise seen only by the model, so a
// long build or a failing command looks like a silent hang. Show a concise outcome: a checkmark on a
// clean exit, and on a non-zero exit / timeout the exit code plus a short tail of the output so failures
// aren't hidden. Routing through `log` (which commits line-by-line to scrollback) also means long error
// text is NOT streamed through the one-line live region — sidestepping the overflow-garble bug.
function surfaceBashOutcome(out: string, log: (s: string) => void): void {
  const first = out.split("\n", 1)[0];
  if (first.startsWith("started background process")) {
    log(c.gray("  ⚙ " + first));
    for (const l of out.split("\n").slice(1)) if (l.startsWith("⚠")) log(c.yellow("  " + l)); // duplicate/port warning
    return;
  }
  const timedOut = out.startsWith("timed out");
  const m = first.match(/^exit (\d+)/);
  const code = m ? Number(m[1]) : null;
  const body = (m ? out.slice(first.length + 1) : out).replace(/\s+$/, ""); // drop the "exit N" header we already show
  if (!timedOut && code === 0) {
    const lines = body ? body.split("\n").length : 0;
    log(c.gray(`  ✓ exit 0${lines ? ` · ${lines} line${lines > 1 ? "s" : ""} of output` : ""}`));
    return;
  }
  log(c.yellow(`  ⚠ ${timedOut ? first : `run_bash exit ${code}`}`));
  for (const l of body.split("\n").slice(-12)) if (l.trim()) log(c.gray("    " + l.slice(0, 200)));
}

function normalizeShellCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+(?:2>&1|1>&2)$/g, "")
    .trim();
}

function isSuccessfulForegroundCommand(output: string): boolean {
  return output === "exit 0" || output.startsWith("exit 0\n");
}

function isKnownCheckCommand(cwd: string, command: string): boolean {
  const norm = normalizeShellCommand(command);
  if (!norm) return false;
  const checks = detectChecks(cwd);
  const candidates = new Set(checks.map((check) => normalizeShellCommand(check.command)));
  if (checks.some((check) => check.kind === "test" || check.name === "test")) {
    for (const testCmd of ["bun test", "bun run test", "npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "yarn run test"]) {
      candidates.add(testCmd);
    }
  }
  return candidates.has(norm);
}

export async function runTurn(userInput: string, history: Message[], deps: TurnDeps): Promise<TurnOutcome> {
  const { cfg, tools, store, approve, log } = deps;
  const call = deps._callModel ?? callModel;
  if (!cfg.apiKey) {
    log(c.yellow("No ANTHROPIC_API_KEY set — set it to enable the model. Memory and /commands still work."));
    return {};
  }

  history.push({ role: "user", content: userInput });
  deps.readCache?.clear(); // start each turn with a clean read-dedup cache (token optimization)

  let mutated = false;           // did a write/edit/bash run since the last verification? → drives auto-verify
  let explicitCheckPassedSinceMutation = false; // the agent already ran a detected check after editing
  let fixRounds = 0;             // self-correction rounds spent this turn
  let unverifiedNudges = 0;      // one-time nudge when a file change matched NO automated check
  const autofixMax = deps.autofixMax ?? 3;
  // Consecutive mid-stream model failures (e.g. the FreeLLMAPI router falling back to another model
  // after we'd already streamed output — which the gateway can't safely retry). Resets on any success;
  // when it trips we re-issue the step instead of killing the whole turn. OB1_STEP_RETRIES overrides.
  let stepRetries = 0;
  const maxStepRetries = Math.max(0, Number(process.env.OB1_STEP_RETRIES) || 6);

  // Just-in-time retrieval: pull the top-k facts relevant to THIS turn into context (R3).
  let retrieved: Fact[] = [];
  try { retrieved = await store.searchSemantic(userInput, 6); } catch { /* ignore */ }
  const system = systemPrompt(cfg, store, retrieved);
  // These toggle instructions are config-stable for the whole session, so they belong in the CACHED
  // stable block (index 0) — not the volatile tail — so they don't break the prompt cache each turn.
  const addStable = (s: string) => { system[0].text += "\n\n" + s; };
  if (deps.canEscalate)
    addStable("Auto-route is ON: you have the `escalate` tool. If this turn is too hard or high-stakes to solve well in a single pass, call escalate FIRST to forward it to a heavier mode; otherwise just answer (don't escalate routine work).");
  if (deps.canSpawn)
    addStable("Subagents are ON: you have the `spawn_subagents` tool. For a big task that splits into INDEPENDENT parts (investigate several files/areas, research several options, audit several modules), call it with one self-contained sub-task per part to run them in parallel and get each one's findings; then synthesize and act yourself. Don't use it for small, serial, or interdependent work.");
  if (deps.canSpawnWrite)
    addStable("Write-subagents are ON: you have the `spawn_write_subagents` tool for editing tasks that split into parts touching DISJOINT files. Assign each agent an explicit, non-overlapping `files` lane; they edit in isolated worktrees and the merge is approval-gated. Any file overlap aborts the batch. Prefer editing yourself for small or interdependent changes.");
  if (tools.has("update_tasks"))
    addStable("For a longer task with several distinct steps, keep a visible task list with `update_tasks`: create it up front with the planned steps (status \"pending\"), mark the step you're starting \"in_progress\" (a single one at a time), and flip each to \"completed\" the moment it's done. Always pass the FULL list (it replaces the previous one); clear it with an empty `tasks` array when the whole task is finished. Skip it for simple one- or two-step tasks.");
  // Delivery surface (PR/CI, DB, secrets, public hosting) — guidance only when the tool is wired, so the
  // prompt that "follows the capability" never advertises a tool this context doesn't have.
  if (tools.has("create_pr"))
    addStable("Shipping a change as a PR: do the work, then commit it with run_bash (`git add -A && git commit -m \"…\"`) on a feature branch — never commit straight to the default branch — then call `create_pr` (title + a real body) to push and open the PR. It does NOT commit for you and refuses an empty PR. After opening, run `pr_checks` (wait:true) and DON'T report the task done until CI is green — fix failures and re-check until it passes (or say plainly why a failure is pre-existing).");
  if (tools.has("execute_sql"))
    addStable("Database work: use `execute_sql` for SQLite (Bun built-in; default file .ob1/app.db). Reads (SELECT) are free; for changes prefer scoped statements (always a WHERE on UPDATE/DELETE) and do schema changes as explicit CREATE/ALTER migrations. A DROP/TRUNCATE or a whole-table DELETE/UPDATE is refused unless you pass allow_destructive:true — only do that when the user clearly wants data wiped.");
  if (tools.has("request_secret"))
    addStable("Secrets: when a command needs an API key/token/password, call `request_secret` (UPPER_SNAKE name) so the USER types it into a masked prompt — never ask them to paste a secret into the chat, and never put a literal key in a command. The value is exposed to run_bash as $NAME (reference it as \"$NAME\"); you never see it. NEVER print, echo, log, or commit a secret value. Use `check_secret` to see if one is already set.");
  if (tools.has("expose_port"))
    addStable("Public preview: only call `expose_port` when the user explicitly asks to share, publish, or open a public preview URL. For normal verification, prefer browser_check against a static file path or localhost. If a public preview is requested, start the dev server with run_bash background, then call `expose_port` with the port to get a temporary public https URL (throwaway tunnel; not production hosting).");

  for (let step = 0; step < MAX_STEPS; step++) {
    if (deps.signal?.aborted) return {}; // ESC between steps — the drain loop prints "⊘ stopped" once
    const edit = editContext(history);
    // Eviction removes older tool-result bodies from history — invalidate the read-dedup cache so a
    // pointer can never reference content that was just evicted (keeps dedup provably quality-neutral).
    if (edit.cleared) deps.readCache?.clear();
    // Only surface an eviction worth mentioning (~200+ tokens) — tiny reclaims are noise.
    if (edit.cleared && edit.savedChars >= 800) log(c.gray(`  [context-edit: evicted ${edit.cleared} stale tool result(s), ~${Math.round(edit.savedChars / 4)} tokens freed]`));
    // LLM-summary compaction: once history blows past a hard cap, summarize the oldest turns (R3). This
    // makes its OWN model call, which can throw (network/5xx/out-of-credits); it runs before the step's
    // try/catch, so guard it here — a failed compaction is best-effort, just proceed with full history.
    let compacted = false;
    try {
      compacted = await compactIfNeeded(history, {
        summarize: async (older) => {
          const r = await callModel({
            provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, model: cfg.model, maxTokens: cfg.maxTokens,
            system: "Summarize the earlier conversation into a compact note: preserve decisions made, file paths touched, and open tasks. Be terse — bullet points, no preamble.",
            messages: [{ role: "user", content: older.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n").slice(0, 120_000) }],
          });
          return r.content.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim() || "(summary unavailable)";
        },
      });
    } catch { /* compaction is best-effort; on failure keep the full history and proceed */ }
    if (compacted) log(c.gray("  [compacted older turns into a summary to free context]"));

    // Recompute each step so tools activated mid-turn (e.g. via load_mcp_tool) become available.
    const toolDefs: ToolDef[] = [...tools.values()].map((t) => t.def);
    if (deps.canEscalate) toolDefs.push(ESCALATE_TOOL); // LLM router: Solo-only, advertised only when autoRoute is on
    if (deps.canSpawn) toolDefs.push(SPAWN_TOOL);        // parallel subagents: Solo-only, advertised only when cfg.subagents on
    if (deps.canSpawnWrite) toolDefs.push(SPAWN_WRITE_TOOL); // parallel write-subagents: opt-in (OB1_SUBAGENTS_WRITE)
    let resp;
    let streamed = false;
    // Even spacing: one blank line before this response block, emitted on the FIRST output (reasoning or
    // text) so a tool-only step doesn't leave a dangling gap.
    let gapped = false;
    const gapOnce = () => { if (!gapped) { gapped = true; deps.gap?.(); } };
    try {
      resp = await call({
        provider: cfg.provider,
        apiKey: cfg.apiKey!,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        // Only attach effort for models that take it (omitted for known non-reasoning models); pick the
        // right wire param via the endpoint (OpenRouter unified vs legacy reasoning_effort).
        effort: supportsEffort(cfg.model) ? cfg.effort : undefined,
        openrouter: isOpenRouterEndpoint(cfg),
        system,
        messages: history,
        tools: toolDefs,
        onText: deps.onText ? (d) => { gapOnce(); deps.onText!(d); streamed = true; } : undefined,
        onReasoning: deps.onReasoning ? (d) => { gapOnce(); deps.onReasoning!(d); } : undefined,
        onRetry: ({ attempt, max, delayMs, error }) =>
          log(c.yellow(`  ⚠ ${explainError(error).title.toLowerCase()} — retrying (${attempt}/${max}) in ${Math.round(delayMs / 1000)}s…`)),
        signal: deps.signal,
      });
    } catch (e) {
      if (streamed) deps.endText?.();
      deps.endReasoning?.();
      const err = e as Error;
      const aborted = deps.signal?.aborted || err.name === "AbortError";
      // Mid-stream failure the gateway couldn't retry (it had already streamed output — typically the
      // proxy's router falling back to a different model). Don't kill the whole turn: re-issue this step.
      // History is unchanged (the assistant message is only pushed on success), so the re-issue is clean.
      // Bounded by maxStepRetries CONSECUTIVE failures; `step--` so a retry doesn't burn the step budget.
      if (!aborted && isRetryable(err) && stepRetries < maxStepRetries) {
        stepRetries++;
        log(c.yellow(`  ⚠ model stream interrupted (likely a proxy model fallback) — retrying step (${stepRetries}/${maxStepRetries})`));
        step--;
        continue;
      }
      // On abort (ESC) the drain loop prints "⊘ stopped" once — don't duplicate it here. Only a real
      // upstream failure (not an abort) gets surfaced as an error.
      if (!aborted) {
        const fe = explainError(err.message);
        // In the TUI the action is a focusable button above the prompt (onErrorAction) — don't ALSO print
        // it inline (it'd appear twice). Under the REPL there's no banner, so keep the inline link.
        log(renderFriendly(fe, { action: !deps.onErrorAction }));
        // Recovery recipe: if this is a recognized failure scenario, surface its known fix so the next
        // step is informed (after the gateway's automatic retries are already exhausted).
        const hint = recoveryHint(err.message);
        if (hint) log(c.dim(`  ↻ ${hint}`));
        deps.onErrorAction?.(fe.action);
      }
      return {};
    }
    stepRetries = 0; // a successful model call clears the consecutive-failure counter
    if (streamed) deps.endText?.();
    deps.endReasoning?.(); // commit any trailing reasoning (e.g. a reasoning-then-tool-only turn)
    if (resp.usage) deps.onUsage?.(resp.usage);
    if (resp.model) deps.onResolvedModel?.(resp.model);

    // Text already streamed live via onText; only re-log if nothing streamed (e.g. tool-only turn).
    if (!streamed) for (const b of resp.content) if (b.type === "text" && b.text.trim()) { gapOnce(); log(b.text.trim()); }
    history.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    // Terminate on the ABSENCE of tool calls, not on stop_reason: the Anthropic path reports the real
    // stop_reason (e.g. "max_tokens"), so a turn that emitted tool_use blocks but didn't finish would
    // otherwise return here WITHOUT answering them — leaving dangling tool_use in `history` that 400s the
    // very next turn (and stays broken until /clear). If tool_use blocks exist, we must answer them.
    if (toolUses.length === 0) {
      // Auto-verify + self-correct: the model thinks it's done, but if it CHANGED files, run the project's
      // fast checks. On failure, feed the errors back and let it fix them — looping until green or the
      // round budget is spent. This is what turns "I edited the file" into "I edited the file and it works".
      if (deps.verify && mutated && !deps.signal?.aborted) {
        log(c.gray("  ⚙ verifying changes…"));
        const v = await deps.verify();
        if (v?.ran && !v.ok) {
          if (fixRounds < autofixMax) {
            fixRounds++;
            log(c.yellow(`  ↻ checks failed — self-correcting (${fixRounds}/${autofixMax})`));
            history.push({ role: "user", content:
              `Automated verification of your changes FAILED. Fix the problems below, then finish. Keep going until the checks pass (or, if a failure is pre-existing / unrelated to your change, say so explicitly).\n\n${v.report}` });
            mutated = false; // a fresh fix attempt re-arms verification
            continue;        // re-enter the model loop with the failures in context
          }
          log(c.yellow(`  ⚠ checks still failing after ${autofixMax} self-correction round(s) — leaving the changes for you to review`));
        } else if (v?.ran && v.ok) {
          log(c.green("  ✓ verified — checks pass"));
        } else if (v && !v.ran && explicitCheckPassedSinceMutation) {
          log(c.green("  ✓ verified — explicit check passed"));
        } else if (v && !v.ran && unverifiedNudges < 1) {
          // No automated check matched this project (e.g. a JS app with no typecheck/test script). That is
          // NOT the same as "verified" — a build-less UI change can compile and still do nothing. Nudge the
          // model ONCE to prove behaviour (browser_check for UI) or explicitly state why no runtime check is
          // needed, then let it finish. Bounded to a single nudge so a genuinely check-less change can't loop.
          unverifiedNudges++;
          log(c.yellow("  ⚠ no automated checks ran — changes are NOT verified yet"));
          history.push({ role: "user", content:
            "Your changes weren't covered by any automated check, so they are NOT verified. If this was a UI / visual / interactive change (a toggle, button, styling, route), VERIFY IT NOW with browser_check. For static HTML/CSS/JS, pass the workspace file path directly (e.g. site/index.html) and avoid a local server. For framework apps, make sure the dev server is running (run_bash background → call the list_bash TOOL for its URL), then browser_check that URL — perform the actual interaction and assert the observable result changed. If the current sandbox blocks local networking and the app cannot be opened as a static file, say that plainly instead of retrying server variants. If it was a change that genuinely has no runtime behaviour to check (docs, config, comments), just say so in one line and finish. Do not claim a visual feature works without a passing browser_check." });
          mutated = false; // re-arm so the follow-up turn's changes get checked too
          continue;
        } else if (v && !v.ran) {
          // No automated check exists for this project and the one-time nudge is already spent. Log a clear
          // OUTCOME so a finished turn never dangles at "⚙ verifying changes…" (which reads as a freeze).
          log(c.yellow("  ⚠ not verified — this project has no automated checks; verify UI behaviour with browser_check"));
        } else if (!v) {
          log(c.yellow("  ⚠ verification could not run — changes left unverified"));
        }
      }
      if (resp.usage) {
        const u = resp.usage;
        log(c.gray(`  [tokens in:${u.input_tokens} out:${u.output_tokens}${u.cache_read_input_tokens ? ` cache-read:${u.cache_read_input_tokens}` : ""}${u.estimated ? " (est)" : ""}]`));
      }
      return {};
    }

    // LLM router: Solo called `escalate` → judge that this turn needs a heavier mode. Stop here and hand
    // the whole task back to the dispatcher (which re-runs it in that mode). We still answer EVERY tool_use
    // in this assistant message with a tool_result so `history` stays valid for the later apply turn.
    const escTU = deps.canEscalate ? toolUses.find((tu) => tu.name === "escalate") : undefined;
    if (escTU) {
      const raw = (escTU.input ?? {}) as { mode?: string; reason?: string };
      const mode: HeavyMode = raw.mode === "council" || raw.mode === "personas" ? raw.mode : "fusion";
      const reason = (raw.reason ?? "needs deeper analysis than a single Solo pass").trim();
      log(c.dim(`  ↗ escalating to ${mode} — ${reason}`));
      history.push({
        role: "user",
        content: toolUses.map((tu) => ({
          type: "tool_result" as const, tool_use_id: tu.id,
          content: tu === escTU ? `Task escalated to ${mode} mode; the heavier mode takes over from here.` : "Skipped — task escalated to a heavier mode.",
        })),
      });
      return { escalate: { mode, reason } };
    }

    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      // ESC mid-batch: once aborted, don't START any further tool in this batch. We still emit a
      // tool_result for every remaining tool_use so the assistant message stays well-formed (the API
      // 400s on a tool_use with no matching tool_result); the step loop then exits at the top via the
      // signal check. The tool that was ALREADY running gets ESC'd via the signal threaded into run().
      if (deps.signal?.aborted) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "Stopped by user (ESC).", is_error: true });
        continue;
      }
      deps.gap?.(); // even spacing: a blank line before each tool call
      // Parallel subagents: a normal tool whose result feeds back into Solo (it keeps working). Handled
      // inline because it needs the turn's cfg/tools/progress/abort from `deps`, not the static registry.
      if (tu.name === "spawn_subagents" && deps.canSpawn) {
        log(c.gray(`  → ${describe(tu.name, tu.input)}`));
        try {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: await handleSpawn(tu.input, deps, userInput) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `error: ${(e as Error).message}`, is_error: true });
        }
        // The finished batch stays in the footer (with done/failed status) so the user can review it
        // while Solo synthesizes; the dispatcher clears the registry when the whole turn ends.
        continue;
      }
      if (tu.name === "spawn_write_subagents" && deps.canSpawnWrite) {
        log(c.gray(`  → ${describe(tu.name, tu.input)}`));
        try {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: await handleSpawnWrite(tu.input, deps) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `error: ${(e as Error).message}`, is_error: true });
        }
        continue;
      }
      const tool = tools.get(tu.name);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `unknown tool: ${tu.name}`, is_error: true });
        continue;
      }
      // Plan-mode gate. Some statically mutating tools have read-only calls (run_bash ls/grep/git log,
      // execute_sql SELECT/PRAGMA), and investigation is the point of Plan mode.
      const mutatingCall = toolCallMutates(tool, tu.name, tu.input);
      if (mutatingCall && cfg.planMode) {
        log(c.yellow(`  ⛔ ${tu.name} blocked (Plan mode is read-only)`));
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "Blocked: Plan mode is read-only. User must /act to allow this.", is_error: true });
        continue;
      }
      // Diff viewer: show what a file mutation will change, before approving it.
      if (tool.mutating) { const diff = previewFileChange(cfg, tu.name, tu.input); if (diff) log(diff); }
      // Decision context for the policy engine + approval tokens (computed once).
      const cmd = tu.name === "run_bash" ? String((tu.input as any)?.command ?? "") : undefined;
      const callCtx = { tool: tu.name, command: cmd, intent: cmd != null ? classifyIntent(cmd) : undefined, path: (tu.input as any)?.path };
      // Policy engine: a declarative rule can pre-decide a mutating call before the interactive gate.
      // deny → block; allow → auto-approve (skip the prompt); warn → tag the prompt. No match → "ask".
      let preApproved = false;
      let policyNote = "";
      if (deps.policy?.length && mutatingCall) {
        const d = evaluatePolicy(deps.policy, callCtx);
        if (d.action === "deny") {
          log(c.yellow(`  ⛔ ${tu.name} denied by policy rule "${d.rule?.name}"`));
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `Blocked by policy rule "${d.rule?.name}". This action is not permitted in this workspace.`, is_error: true });
          continue;
        }
        if (d.action === "allow") preApproved = true;
        else if (d.action === "warn") policyNote = c.yellow(`  [policy: ${d.rule?.name}]`);
      }
      // Capability tokens: a user-granted standing approval (/allow) auto-approves a matching call so the
      // gate doesn't re-prompt for, e.g., every git command. Consumes a finite token's use.
      if (!preApproved && mutatingCall && deps.approvals?.consume(callCtx)) {
        preApproved = true;
        log(c.dim(`  ✓ pre-approved by an active /allow grant`));
      }
      // Approval gate — "autopilot" never prompts; "ask" (default) prompts for every mutating tool. A
      // Read-only calls change nothing, so they are never gated and never mark the turn mutated. A policy
      // "allow" or a token also skips the interactive prompt.
      const destructive = tool.destructive || isDestructiveCall(tu.name, tu.input);
      if (mutatingCall && !preApproved && cfg.permissionMode !== "autopilot") {
        const ok = await approve(describe(tu.name, tu.input) + (destructive ? c.red("  [destructive]") : "") + policyNote);
        if (!ok) {
          log(c.yellow(`  ✗ denied: ${tu.name}`));
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "User denied this action.", is_error: true });
          continue;
        }
      }
      const workspaceChange = toolCallChangesWorkspace(tu.name, tu.input)
        && !(tu.name === "run_bash" && isKnownCheckCommand(cfg.cwd, String((tu.input as any)?.command ?? "")));
      if (workspaceChange) { mutated = true; explicitCheckPassedSinceMutation = false; deps.onMutate?.(); invalidateRepoMap(); } // workspace change → ESC-warning + auto-verify + refresh repo map next turn
      // PreToolUse hooks: a user-defined command runs BEFORE the tool and can block it (exit 2 /
      // {"decision":"block"}) or inject context. No-op when no hooks are configured.
      const hooks = deps.hooks; const hookExec = deps.hookExec;
      if (hooks?.length && hookExec) {
        const pre = await runHooks(hooks, { event: "PreToolUse", tool: tu.name, input: tu.input }, hookExec);
        if (pre.decision === "block") {
          log(c.yellow(`  ⛔ ${tu.name} blocked by a PreToolUse hook`));
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `Blocked by a PreToolUse hook: ${pre.reason ?? "policy"}`, is_error: true });
          continue;
        }
        if (pre.feedback) log(c.dim(`  ⎇ hook: ${pre.feedback.split("\n")[0].slice(0, 160)}`));
      }
      log(c.gray(`  → ${describe(tu.name, tu.input)}`));
      try {
        const { text, images } = normalizeToolOutput(await tool.run(tu.input, { signal: deps.signal }));
        let out = text;
        // PostToolUse hooks: feed the model lint/format/notes from a successful tool result.
        if (hooks?.length && hookExec) {
          const post = await runHooks(hooks, { event: "PostToolUse", tool: tu.name, input: tu.input, output: out }, hookExec);
          if (post.feedback) out += `\n\n[PostToolUse hook]\n${post.feedback}`;
        }
        // Carry images (a browser_check screenshot) as a content-block array so a vision model can SEE
        // them; otherwise a plain string keeps the overwhelmingly-common text-only case on the wire.
        results.push({ type: "tool_result", tool_use_id: tu.id, content: toolResultContent(out, images) });
        if (tu.name === "run_bash") {
          surfaceBashOutcome(out, log); // make bash activity/errors visible to the user
          const command = String((tu.input as any)?.command ?? "");
          if (mutated && isSuccessfulForegroundCommand(out) && isKnownCheckCommand(cfg.cwd, command)) {
            explicitCheckPassedSinceMutation = true;
          }
        } else if (tu.name === "browser_check" && mutated && out.startsWith("✓ browser_check PASSED")) {
          explicitCheckPassedSinceMutation = true;
        }
      } catch (e) {
        const msg = (e as Error).message;
        let content = `error: ${msg}`;
        // PostToolUseFailure hooks: a fix hint injected into the error result (a self-correction trigger).
        if (hooks?.length && hookExec) {
          const fail = await runHooks(hooks, { event: "PostToolUseFailure", tool: tu.name, input: tu.input, error: msg }, hookExec);
          if (fail.feedback) content += `\n\n[PostToolUseFailure hook]\n${fail.feedback}`;
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: true });
        log(c.red(`  ✗ ${tu.name} failed: ${msg.split("\n")[0].slice(0, 200)}`)); // surface tool errors, don't swallow them
      }
    }
    history.push({ role: "user", content: results });
  }
  log(c.yellow(
    UNCAPPED
      // The runaway safety net tripped — almost always a stuck loop, not a real task that needed 1000 rounds.
      ? `  (safety stop after ${MAX_STEPS} steps — likely a stuck loop; the work so far is kept, say "continue" to resume)`
      : `  (paused after ${MAX_STEPS} steps — the work so far is kept; say "continue" to keep going, or raise the limit with OB1_MAX_STEPS)`,
  ));
  return {};
}
