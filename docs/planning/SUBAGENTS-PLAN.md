# Parallel Subagents for OB-1 — Research + Implementation Plan

*Drafted 2026-06-21. Research by three parallel agents (Claude Code subagent mechanics ·
OB-1 infra map · 13-product comparative survey). Builds on
[`research/multi-agent-orchestration.md`](research/multi-agent-orchestration.md) (report #5).*

---

## TL;DR — the recommendation

Add an **agent-callable `spawn_subagents` tool** that lets the Solo loop, mid-task, fan out
**independent, read-only sub-tasks in parallel**, get back a distilled summary from each, and
then synthesize + apply the result itself through the existing gated write path.

- **Reuse, don't rebuild.** OB-1 already has the hard parts: isolated read-only workers
  (`runWorker`), a concurrency primitive (`runParallel`), a live progress stream
  (`WorkerEvent` → `workerProgress`), and a gated write-back (`applySolution`). The feature is
  ~1 new tool + ~1 thin helper.
- **Read-only by default.** Subagents research/investigate in parallel; **only Solo writes**
  (single writer, gated by approval). This is the one design choice every surveyed product and
  both canonical essays agree on.
- **Opt-in, never auto-decompose.** Gated behind a default-off toggle (`cfg.subagents`), exactly
  like `autoRoute`/`escalate`. Honors [[no-auto-escalation-to-expensive-modes]].
- **Bring the data back, visibly.** Per-subagent progress streams live; each subagent's findings
  are returned to Solo *and surfaced to the user* (and optionally saved as a report) so the user
  can review what each one found — not just a silently merged blob. Honors
  [[visible-progress-no-silent-work]].
- **Hard, shallow caps.** Concurrency cap; **no nesting** (subagents can't spawn subagents or
  escalate); ESC aborts all; token budget declared up front.

This is complementary to the existing **`escalate` router** (which forwards a *whole turn* to a
heavier *mode*). `spawn_subagents` stays *inside* the Solo turn and fans out *subtasks* — finer
grained, and the better fit for "it's a bigger problem, split it up."

---

## 1. What you asked for

> Look into how subagents work in Claude Code and similar products. Make a plan on how we can
> enable subagents that work in parallel whenever it's a bigger problem, and bring data back to
> the user so they can review it.

This doc answers all three: the research (§2–§4), OB-1's current state and the gap (§5), the
proposed design (§6), and a phased, testable implementation plan (§7) with risks (§8) and the
decisions that are yours to make (§9).

---

## 2. How subagents work in Claude Code

Claude Code spawns subagents via the **Agent tool** (formerly `Task`; `Task(...)` still aliases).
A subagent is a specialized assistant with its **own isolated context window**, custom system
prompt, scoped tool set, and independent permissions.

| Aspect | Behavior |
|---|---|
| **Spawn** | Automatic (Claude matches a subagent's `description` to the task) or explicit (`@agent-name`, `--agent`, natural language). |
| **Parallelism** | Yes — one assistant message with multiple Agent calls dispatches them concurrently. Practical guidance: 2–5 siblings. |
| **Context isolation** | Subagent sees only its delegation message (+ CLAUDE.md/skills), **not** the parent's history or prior file reads. Verbose work stays in the subagent's transcript. |
| **Return contract** | Only the subagent's **final summary** returns to the parent — the key context-saving move. |
| **Definitions** | Markdown files in `.claude/agents/` (project) or `~/.claude/agents/` (user). Frontmatter: `name`, `description` (required), `tools`/`disallowedTools`, `model` (`inherit`/`sonnet`/…), `permissionMode`, `maxTurns`, `skills`, `isolation: worktree`, `background`, etc. |
| **Built-ins** | `Explore` (Haiku, read-only, one-shot), `Plan` (read-only), `general-purpose` (all tools, resumable). |
| **Nesting** | Subagents *can* spawn subagents, capped at **depth 5**; depth-5 can't spawn further. Forks inherit full parent context + prompt cache. |
| **Worktree isolation** | `isolation: worktree` runs a write-capable subagent in a throwaway git worktree so parallel edits don't collide. |

Docs: [sub-agents](https://code.claude.com/docs/en/sub-agents.md) ·
[multi-agent (SDK)](https://platform.claude.com/docs/en/managed-agents/multi-agent.md).

**The takeaways that matter for us:** isolated context + *summary-only* return is the whole
point; write-parallel work needs worktree isolation; nesting is allowed but shallow.

---

## 3. How subagents work in similar products

First, a distinction the survey makes sharp — three things get called "subagents":

1. **Decomposition parallelism** — one task split into independent subtasks, each on an isolated
   subagent (Roo Boomerang, Cline, Goose, Amp, Crush, OpenHands `delegate`, Devin, Copilot
   `/fleet`, Anthropic orchestrator-worker). **This is what we want.**
2. **Best-of-N / redundancy** — N agents attempt the *same* task; a judge/human picks
   (Cursor `/best-of-n`). **OB-1 already has this — it's Fusion.**
3. **Not really subagents** — independent background jobs (Continue per-PR), 2-model pipelines
   (Aider architect/editor), prompt-injected context (OpenHands microagents).

| Product | Real per-task subagents? | Trigger | Concurrency | Isolation / return | Notable limit |
|---|---|---|---|---|---|
| **Devin** | Yes ("Manage Devins") | Automatic hierarchical | Parallel | Full VM each; coordinator compiles PRs | ~10 concurrent; ACU caps |
| **Copilot `/fleet`** | Yes | Automatic, in waves | Parallel | Own context, **shared FS, no locking** ⚠ | "use sparingly"; token blowup |
| **Roo Code (Boomerang)** | Yes | Orchestrator picks mode | **Sequential** (parent pauses) | Full isolation; **summary string** back | parallel = open request |
| **Cline — Subagents** | Yes (**read-only**) | Auto + nudge | Parallel | Own window/budget; focused report back | no nesting |
| **Cline — Agent Teams** | Yes (write) | `--team-name` | Parallel + **git worktrees** | Shared board/mailbox | CLI/SDK only |
| **Goose** | Yes (+ subrecipes) | User-directed | Parallel | Own session; structured return + live dashboard | **10 workers flat, no nesting**; 5-min/25-turn each |
| **Amp** | Yes (Task tool) | Auto in `smart` mode | Parallel | **Fresh window, no parent history**; summary only | nesting unconfirmed |
| **Crush** | Yes (`agent` tool) | Orchestrator-driven | Parallel | Isolated session, deterministic IDs; **child cost rolls up** | **recursion depth 2** |
| **OpenCode** | Yes | Auto / `@mention` | Parallel (default 5) | Isolated child session; `permission.task` | async delegation = open request |
| **OpenHands** | Yes (`delegate`) | Explicit tool | Blocking-parallel | Own context, inherits config | `tool_concurrency_limit` default 1 |
| **Cursor** | Best-of-N only | User-directed | Parallel, ≤8 | Own worktree/VM; human picks diff | 8/prompt |

**Frameworks:** AutoGen teams are turn-taking (Magentic-One adds a planning orchestrator + Task/
Progress ledgers + stall detection); CrewAI runs Sequential/Hierarchical, Flows add parallel
branches (race risk, no reducer); **LangGraph** documents the patterns most explicitly — supervisor,
swarm, and **Send API** map-reduce (needs a reducer to avoid lost writes), plus the
`full_history` vs `last_message` handoff trade-off.

### The central debate (read both)

- **Cognition — "Don't Build Multi-Agents."** *Share full context and full agent traces, not just
  messages; conflicting implicit decisions wreck parallel work.* Prescribes a **single-threaded
  agent** + context compression for long tasks rather than splitting.
- **Anthropic — "How we built our multi-agent research system."** Orchestrator-worker with 3–5
  isolated parallel subagents beat single-agent by **+90.2%** on a *research* eval — but at **~15×
  tokens**, and they say it's poorly suited to **most coding work**.

**They actually agree:** parallel subagents win for **independent, read-heavy breadth** (research,
search, audits) that exceeds one context window and justifies the cost; single-agent wins for
**write-heavy, dependency-dense** edits where subtasks must share context. The shared failure mode
is **broken context-sharing / conflicting decisions.**

---

## 4. Distilled design lessons (the do / don't we'll follow)

**Do**
1. **Optimize for clean orchestrator context first, parallel speed second.** The real win is
   quarantining noisy tool output in the subagent and returning a distilled summary.
2. **Split read from write.** Default = parallel **read-only** research subagents; keep writing on
   a **single thread / single writer**. If you ever write in parallel, give each an **isolated git
   worktree** — never a shared filesystem (Copilot `/fleet`'s documented footgun).
3. **Make the return contract explicit** — summary, not raw transcript. The orchestrator must never
   inherit subagent transcripts.
4. **Cap concurrency hard and shallow** — flat worker cap, **no nesting** (Goose, Cline, Crush all
   forbid deep recursion).
5. **Stop button + idempotency** — first-class interrupt/abort; don't re-run finished work on resume.
6. **Track cost rollup live** — parallel multiplies spend; surface aggregate tokens up front and live.
7. **Human gate at the write boundary** — the gate goes where code lands, not on result-merging.

**Don't**
1. **Don't auto-decompose by default** — opt-in / agent-invoked, warn on cost.
2. **Don't let parallel agents write the same file.**
3. **Don't expect mid-task steering or inter-agent chat** — front-load complete, self-contained
   subtask instructions.
4. **Don't pay 15× tokens for dependency-dense coding** — reserve parallelism for genuinely
   independent, read-heavy work.
5. **Don't allow deep nesting.**

Closest references to study for a CLI agent: **Goose** (flat cap, return modes), **Crush**
(deterministic IDs, depth-2, cost rollup), **OpenCode** (`permission.task`), **Amp's "Agents for
the Agent"** essay, and the **Cline read-only subagents** + **Anthropic orchestrator-worker**
patterns.

---

## 5. What OB-1 already has — and the gap

OB-1's `multimind` layer is already an orchestrator-worker system. The relevant primitives
(`file:line` from the infra map):

| Primitive | Where | What it gives us |
|---|---|---|
| `runWorker(opts)` | `src/multimind/runtime.ts:45` | A full isolated ReAct loop in its own message history; per-worker `model`, `onEvent`, `signal`, `_call` test seam. **= a subagent.** |
| `runParallel(items, fn, concurrency=4)` | `src/multimind/runtime.ts:112` | Order-preserving concurrent pump with a cap. **= our fan-out.** |
| `readOnlyTools(all)` | `src/multimind/runtime.ts:37` | Strips mutating + registry-touching tools. **= read-only enforcement.** |
| `WorkerEvent` + `workerProgress` | `runtime.ts:25`, `src/index.ts:88` | Live `start/text/tool/step/done` stream → TUI lines + token meter. **= visible progress, free.** |
| `fanout()` | `src/multimind/orchestrator.ts:24` | N workers (parallel) + 1 synthesizer (streamed). The exact shape we'd mirror. |
| `escalate` tool + `TurnOutcome` | `src/agent/loop.ts:55,218` | The proven pattern for an agent-callable routing tool, gated by `canEscalate`. **= the template for `spawn_subagents`.** |
| `applySolution()` | `src/multimind/apply.ts:43` | Re-runs a result as inert DATA through the **main gated loop** (write + bash + approval). **= the single write boundary.** |
| Tool registry | `src/agent/tools.ts:78` | `buildTools()`; `list_bash`/`kill_bash` show how to register a stateful tool. |

**The gap:** every existing mode (Fusion/Council/Personas) is **mode-level** — the *user* picks a
mode (or `escalate` forwards a whole turn), all workers attack the *same* task, and a synthesizer
merges. There is **no way for the agent, mid-task, to split *one big task* into *different*
independent subtasks and run them in parallel**, then keep working with the results. That agent-
driven, intra-turn decomposition is exactly what Claude Code's Agent tool and the survey's
"decomposition parallelism" provide — and what's missing here.

---

## 6. Proposed design

### 6.1 The tool: `spawn_subagents`

A Solo-only tool (mirrors `escalate`), advertised only when the opt-in toggle is on.

```jsonc
{
  "name": "spawn_subagents",
  "description": "Split a big task into INDEPENDENT, read-only sub-tasks and run them in parallel; \
returns each subagent's findings. Use ONLY when the work genuinely decomposes into parts that don't \
depend on each other (e.g. investigate N files/areas, research N options, audit N modules). Each \
subagent runs in its own isolated context with read-only tools and reports a concise summary back to \
you; YOU then synthesize and make any edits. Don't use it for small or serial/dependent work.",
  "input_schema": {
    "subtasks": [{ "task": "string", "context": "string (optional framing)" }],
    "model":   "string (optional per-subagent model override)",
    "concurrency": "number (optional, capped)"
  }
}
```

- **`mutating: false`** — subagents are read-only; nothing is written until Solo acts.
- **Gating:** advertised only when `cfg.subagents` is on (default **off**), via a new
  `deps.canSpawn` flag set in `turnDeps()` — identical mechanism to `canEscalate`.
- **No nesting / no escalation:** subagents get `readOnlyTools(tools)` which already excludes
  mutating tools; we *additionally* ensure the subagent tool set contains **neither
  `spawn_subagents` nor `escalate`** (strip by name), enforcing the "no deep nesting" rule.
- **Bounded inputs:** clamp `subtasks.length` (e.g. ≤ 8) and `concurrency` (e.g. ≤ 6); log a clear
  message if we clamp (never silently truncate — [[visible-progress-no-silent-work]]).

### 6.2 The helper: `runSubagents()` (new `src/multimind/subagents.ts`)

Thin wrapper over the existing primitives — *no changes to `runtime.ts`*:

```ts
export async function runSubagents(opts: {
  subtasks: { task: string; context?: string }[];
  cfg: Config; tools: Map<string, Tool>;
  model?: string; concurrency?: number;
  onEvent?: (ev: WorkerEvent) => void; signal?: AbortSignal;
  _run?: typeof runWorker;            // test seam, like the other modes
}): Promise<SubagentsResult> {
  const sub = stripTools(readOnlyTools(opts.tools), ["spawn_subagents", "escalate"]);
  const results = await runParallel(opts.subtasks, (st, i) => (opts._run ?? runWorker)({
    label: `subagent-${i + 1}`,
    task: st.context ? `${st.context}\n\n${st.task}` : st.task,
    system: SUBAGENT_SYS,            // "isolated, read-only; investigate; return a concise findings summary; no preamble"
    cfg: opts.cfg, tools: sub, model: opts.model,
    onEvent: opts.onEvent, signal: opts.signal,
  }), Math.min(opts.concurrency ?? 4, MAX_CONCURRENCY));
  return { results, totalInputTokens: sum(results,'in'), totalOutputTokens: sum(results,'out') };
}
```

### 6.3 Return contract — Solo *is* the orchestrator

The tool returns each subagent's **distilled findings** back into Solo's context (bounded length),
labelled by subtask. **No separate merge worker** — Solo already holds the user's full context, so
it synthesizes and writes itself. This is cheaper, keeps a single writer, and keeps the gated write
boundary intact (Solo's edits go through the normal approval gate). Shape returned to the model:

```
3 subagents finished (read-only). Synthesize, then make any edits yourself.

### subagent-1 — "audit auth middleware"
<concise findings>

### subagent-2 — "audit token refresh"
<concise findings>
...
[~N in / M out tokens across 3 subagents]
```

This matches Claude Code (summary-only return) and the survey's universal "return a summary, never
the transcript" rule.

### 6.4 Bringing data back to the user (the review requirement)

Three layers, reusing what exists:

1. **Live progress** — pass `workerProgress` as `onEvent`. The TUI already renders
   `· subagent-2…`, `→ subagent-2: read_file …`, and ticks the token meter per step. Parallel
   interleaving is already labelled (`index.ts:98`).
2. **Reviewable findings** — the tool result (each subagent's task + findings) is shown in the
   transcript, so the user sees *what each subagent independently found*, not just the merged
   answer. Optionally render a compact **summary panel** (one row per subagent: label · task ·
   tokens · ok/failed).
3. **Saved report (opt-in)** — write `.ob1/subagents/<timestamp>.md` (task, the subtask list, each
   subagent's full findings, token totals) so the user can open and review the raw data later. A
   one-line pointer is logged.

### 6.5 Guardrails

| Guard | How |
|---|---|
| Opt-in only | `cfg.subagents` default off; `/subagents on\|off`, `OB1_SUBAGENTS=1`, settings entry. |
| No auto-decompose | Agent must *choose* the tool; system-prompt nudge says "only when genuinely independent + parallelizable." |
| No nesting | Subagent tool set excludes `spawn_subagents` + `escalate`; read-only enforced. |
| Single writer | Subagents never write; Solo applies via the existing gated loop. |
| Concurrency cap | `MAX_CONCURRENCY` (≈6) + subtask count clamp (≈8), logged if clamped. |
| Cost up front | Declare "~K subagents ≈ Kx a Solo investigation" before running (like the mode banners). |
| Stop button | Thread `activeAbort.signal`; ESC aborts all in-flight subagents (modes already do this). |
| Per-subagent budget | `runWorker maxSteps` (default 12) bounds each subagent; surface failures, don't hide them. |

### 6.6 Relationship to `escalate` and the modes

- **`escalate`** → forwards a *whole turn* to a heavier *mode* (same task, N angles). Best-of-N /
  deliberation. Unchanged.
- **`spawn_subagents`** → *within* a Solo turn, fans out *different* subtasks, returns data, Solo
  continues. Decomposition.
- They compose: an escalated mode does **not** get `spawn_subagents` (no nesting). Both gated,
  both default-off, both surfaced live.

---

## 7. Phased implementation plan

### Phase A — MVP (read-only parallel subagents)
1. `src/multimind/subagents.ts`: `runSubagents()` + `stripTools()` + `SUBAGENT_SYS` + `MAX_*`
   consts. Reuses `runWorker`/`runParallel`/`readOnlyTools`. `_run` test seam.
2. `src/agent/loop.ts`: `SPAWN_TOOL` def; advertise when `deps.canSpawn`; in the tool loop, when
   `spawn_subagents` is called, run `runSubagents` (passing `deps` progress/abort) and return the
   formatted findings as the tool result (Solo keeps going — *not* a `TurnOutcome` like escalate).
   Add `canSpawn?: boolean` to `TurnDeps`; `describe()` label.
3. `src/agent/tools.ts` **or** `loop.ts`: register the tool. (Leaning `loop.ts`, like `escalate`,
   since it needs `cfg`, the live `tools` map, `onEvent`, and `signal` from the turn — not the
   static `buildTools` registry.)
4. `src/index.ts`: `turnDeps()` sets `canSpawn: cfg.subagents`; forced **off** on apply turns
   (no re-spawn during apply, same as `canEscalate:false`). System-prompt nudge (terse, gated).
5. `src/config.ts`: `subagents: boolean` (default false) + env `OB1_SUBAGENTS` + persistence.
6. **Smoke** (`scripts/subagents-smoke.ts`): inject `_run` (fake workers) → assert N run in
   parallel under the cap, read-only tool set excludes `spawn_subagents`/`escalate`, findings are
   formatted + bounded, ESC abort drops in-flight, token totals sum. Add to `ci-smokes.ts`.

### Phase B — UX, control, review
7. `/subagents on|off` command + `/settings` row + footer/help text.
8. TUI per-subagent **summary panel** + the **saved report** file (§6.4).
9. Up-front cost banner + clamp messages.
10. **Smoke**: settings persistence + clamp/log behavior.

### Phase C — (optional, later) write-capable worktree subagents
11. For genuinely independent *edits*, reuse Fusion's worktree infra
    (`OB1_FUSION_WORKTREE` path) to give each writing subagent an **isolated git worktree**, with
    **disjoint file assignment** and an explicit Solo-driven merge + gated apply. **Higher risk**
    (the survey's #1 footgun) — ship only behind its own flag, with conflict detection, and only if
    Phase A/B prove the demand. Default off; documented loudly.

Estimated surface: **Phase A ≈ one focused change** (one new file + edits to `loop.ts`,
`index.ts`, `config.ts`, one smoke) — small because the orchestration substrate already exists.

---

## 8. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Token blowup (parallel × cost) | High if misused | Opt-in, concurrency/subtask caps, up-front budget, live meter, read-only (cheaper than write loops). |
| Conflicting decisions / wrong split | Medium | Read-only default (no writes to conflict); Solo re-checks before applying; nudge to use only for independent work. |
| Parallel writes corrupting files | High **if** we allowed it | Phase A forbids writes entirely; Phase C uses isolated worktrees + disjoint files + merge gate. |
| Silent/over-eager spawning | Medium | Default-off gate + agent-judgment nudge; never auto. Matches [[no-auto-escalation-to-expensive-modes]]. |
| Runaway / un-stoppable subagents | Medium | `maxSteps` per subagent, `AbortSignal` on ESC, flat cap, no nesting. |
| User can't see what happened | Medium | Live progress + reviewable per-subagent findings + optional saved report ([[visible-progress-no-silent-work]]). |
| "Multi-agent always better" illusion | — | It isn't (report #5: single-agent matches multi-agent at equal tokens; ~76% of multi-agent failures are coordination). Keep it narrow + opt-in; measure before trusting. |

---

## 9. Decisions for you to make

1. **Default state** — ~~ship `cfg.subagents` **off** by default?~~ **DECIDED: ON by default**
   (user-directed). Subagents are read-only + agent-judgment-gated, so low-risk; `escalate` and
   write-modes stay off-by-default. A deliberate `/subagents off` is persisted and survives the default.
2. **Scope now** — Phase A+B only (read-only research subagents), and defer write/worktree subagents
   (Phase C)? (Recommended: yes, defer C.)
3. **Saved report** — write `.ob1/subagents/*.md` for later review (recommended), or live UI only?
4. **Naming** — `spawn_subagents`? (alternatives: `dispatch_agents`, `parallel_tasks`, `fanout_tasks`.)
5. **Caps** — defaults of ≤8 subtasks / ≤6 concurrent — good, or different?

Once you pick, Phase A is a small, well-bounded change because OB-1's worker/parallel/progress/
apply substrate is already in place.

---

## Sources

- Claude Code — [sub-agents](https://code.claude.com/docs/en/sub-agents.md),
  [managed agents / multi-agent](https://platform.claude.com/docs/en/managed-agents/multi-agent.md),
  [permission modes](https://code.claude.com/docs/en/permission-modes.md).
- Cognition — *Don't Build Multi-Agents* (cognition.com/blog/dont-build-multi-agents).
- Anthropic — *How we built our multi-agent research system* (anthropic.com/engineering/multi-agent-research-system).
- Product docs/changelogs: cursor.com/changelog · docs.github.com/copilot + github.blog ·
  roocodeinc.github.io · docs.cline.bot · block goose docs · ampcode.com/notes · opencode.ai/docs ·
  charmbracelet/crush · docs.openhands.dev · microsoft.github.io/autogen · docs.crewai.com ·
  langchain-ai (LangGraph).
- OB-1 internal: [`research/multi-agent-orchestration.md`](research/multi-agent-orchestration.md) (#5),
  [`research/README.md`](research/README.md) cross-cutting thesis; infra at
  `src/multimind/runtime.ts`, `orchestrator.ts`, `src/agent/loop.ts`, `src/multimind/apply.ts`.
