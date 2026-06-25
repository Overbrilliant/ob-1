# Claude Code Alternatives: Full Architecture & What Actually Works

> Research compiled 2026-06-19. Topic: open-source GitHub alternatives to Claude Code (CLI &
> IDE coding agents) — their architecture, what design decisions work, and how.
>
> **Method:** Deep-research workflow — 25 sources fetched (mostly primary: tool docs, design
> blogs, arXiv papers), 125 claims extracted, 25 adversarially verified.
> **25/25 confirmed, 0 killed.**
>
> ⚠️ **Confidence split:** the adversarially-verified core covers **Aider, SWE-agent, and
> OpenHands/CodeAct** plus a cross-cutting SWE-bench architecture survey. Detail on **Cline/
> Roo Code, Codex CLI, Gemini CLI, Goose, Continue, OpenCode/Crush** comes from fetched
> primary docs but did **not** pass the 3-vote gate this run — those sections are marked
> *[unverified this run]*. No GitHub star counts or licenses were verified — treat any as
> approximate.

---

## TL;DR — what the evidence says actually works

1. **The edit format is a top lever.** How the model is asked to express a change (whole-file
   vs diff vs unified-diff vs search/replace) measurably changes correctness *and* tokens.
   Aider tripled GPT-4 Turbo's refactor pass rate (20%→61%) just by switching to a
   machine-readable unified diff.
2. **Separate "reasoning" from "editing."** Aider's Architect/Editor split (one model plans,
   another formats the edit) hit 85% on Aider's edit benchmark by letting each specialize.
3. **Give the agent a purpose-built interface (ACI).** SWE-agent's core thesis — LM agents are
   a distinct "end user" needing custom tools — was worth ~10.7 points over raw shell.
4. **Code-as-action beats rigid JSON.** OpenHands' CodeAct executes Python/bash as its action
   space; reached 53% on SWE-bench Verified (with Claude 3.5 Sonnet) after moving to function
   calling.
5. **No single architecture wins.** A 2025–26 survey of SWE-bench leaderboards found fixed
   pipelines, scaffolded single agents, multi-agent, and autonomous emergent agents all reach
   competitive scores — and as base models get smarter, heavy scaffolding matters *less*.

---

## Part 1 — The verified core (high confidence)

### Aider — the best-documented architecture in open source

**Edit formats (the headline finding).** Aider supports four ways for the model to return changes:
| Format | Mechanism | Tradeoff |
|---|---|---|
| **whole** | LLM returns the entire file | Simplest; **slow & costly** — returns whole file for a 1-line change |
| **diff** | Search/replace blocks (git merge-conflict-style markers) | Token-efficient; only changed parts returned |
| **udiff** (unified diff) | Machine-readable unified diff | Most "rigorous" for some models; reduced laziness |
| **diff-fenced** | Diff inside a fenced block | Variant for certain models |
| **editor-diff / editor-whole** | Streamlined formats for Architect mode | Used with `--editor-edit-format` |

- **Why it matters:** "Models which can use one of the diff formats are much more efficient,
  using far fewer tokens." (Aider leaderboard docs.)
- **The unified-diff result:** GPT-4 Turbo went **20% → 61%** (~3×) on Aider's 89-task
  refactor suite just by switching from search/replace to unified diff, and **"lazy"
  placeholder coding dropped 3×** (12 tasks → 4). Proposed mechanism: emitting data "intended
  to be read by a program" *encourages rigor*.
- **Two more edit-application choices that move reliability:**
  - **High-level diffs** (rewrite whole functions, not minimal surgical lines): removing this
    raised editing errors **30–50%** (larger hunks are less likely to mis-match unrelated code).
  - **Flexible/lenient patch application:** disabling it caused a **9× increase** in editing errors.

> ⚠️ **Flag:** these are Aider's *own* benchmarks, mostly **GPT-4-Turbo-specific and dated
> 2023–24**. Modern models handle search/replace far better and Aider has since changed
> defaults. The 30–50% and 9× ablations have no published raw data. Also: diffs' *token*
> efficiency is uncontested, but their *apply/correctness reliability on small files* is
> disputed (Cursor's internal findings; arXiv 2510.13859) — efficiency ≠ correctness.

**Architect/Editor two-model pattern.**
- An **Architect** model describes *how* to solve the problem; a separate **Editor** model
  turns that into correctly-formatted edits.
- **Rationale:** a single model otherwise splits attention between *solving* and *conforming
  to the edit format*; some reasoning models (e.g. o1) can't do both in one response.
- **Result:** o1-preview (Architect) + DeepSeek or o1-mini (Editor) = **85%**, SOTA on Aider's
  edit benchmark at the time (Sept 2024). *Flag: slow/impractical for interactive use; vendor
  benchmark.*

**Repository map (codebase navigation in a bounded window).**
- Parse source into ASTs with **tree-sitter** → identify definitions (functions, classes,
  variables, types).
- Build a graph (files = nodes, dependencies = edges) and rank with a **PageRank-style**
  algorithm (networkx), surfacing only the **most-referenced identifiers** — codebase context
  *without* dumping whole files. SQLite-cached, 130+ languages.

**Benchmark methodology (so the numbers mean something):** 133 small Exercism exercises; to
pass, the LLM must **both solve the task AND apply all edits with no human intervention** —
which is exactly what makes edit-format reliability measurable.

### SWE-agent — the Agent-Computer Interface (ACI) thesis
- **Central idea:** LM agents are "a new category of end user" that benefit from
  **specially-built interfaces** — a custom ACI "significantly enhances an agent's ability to
  create/edit files, navigate entire repositories, and execute tests."
- **Ablation:** the ACI adds **~10.7 points** over a default-shell baseline on SWE-bench Lite.
- **Result:** **12.5% pass@1 on SWE-bench (full)** — SOTA-at-publication (May 2024), far above
  non-interactive RAG pipelines. The architectural lesson (*interactive ACI > retrieval-only*)
  outlives the now-superseded number.

### OpenHands / CodeAct — executable code as a unified action space
- **CodeAct** is a **single-agent** design that acts by generating and **executing Python &
  bash** (the "code-as-action" paradigm, ICML 2024 / arXiv 2402.01030).
- **Key v2.1 change:** switched from text-based action specification to **LLM function
  calling** to specify tools precisely.
- **Result:** **53% on SWE-bench Verified** (265/500) and **41.7% on SWE-bench Lite** — *with
  Claude 3.5 Sonnet*. ⚠️ Model-coupled and now stale; one community reproduction got only
  26.2% under a non-eval-harness config.

### The cross-cutting verdict: no architecture consistently wins
From an academic profiling of SWE-bench leaderboards (arXiv 2506.17208):
- **"No single architecture consistently achieves state-of-the-art."** High performers span
  fixed pipelines, scaffolded single agents, multi-agent, and autonomous agents.
- Differences between architecture groups were **not statistically significant on Lite**
  (Kruskal-Wallis p=0.058) and only **modestly significant on Verified** (p=0.007).
- **Autonomous single-agents (emergent workflow)** are now the **largest** group on Verified
  (31 approaches, up to 73.2%, median 54.2%). Multi-agent still tops out highest (max 75.2%,
  median 63.4%), so autonomous is "competitive," not best.
- **Interpretation (the authors' hedged one):** better LLM reasoning (Claude 4 Opus/Sonnet)
  **reduces the need for explicit complex scaffolding**. A real trend away from heavy hand-built
  scaffolds as base models improve. *Caveat: observational, not controlled ablation.*

---

## Part 2 — The other tools *[unverified this run — from fetched primary docs only]*

These didn't pass the 3-vote gate, but their primary docs were fetched. Treat as orienting,
not established:

- **Cline** (VS Code agent) — **Plan/Act modes**, `.clinerules` memory files, granular
  **auto-approve** controls (per-action allowlists for read/edit/command/browser/MCP), MCP
  support. Source: docs.cline.bot/features/auto-approve.
- **Roo Code** (Cline fork) — similar **auto-approving-actions** model with finer-grained
  permission toggles. Source: docs.roocode.com.
- **OpenAI Codex CLI** — **approval modes** + OS-level **sandboxing** (macOS Seatbelt / Linux
  containers), network-disabled-by-default execution. Source: developers.openai.com/codex/agent-approvals-security.
- **OpenHands provider abstraction** — multi-LLM via LiteLLM-style config (many providers,
  local models). Source: deepwiki All-Hands-AI/OpenHands.
- **Claude Code sandboxing** — OS-level sandbox + permission prompts. Source: code.claude.com/docs/en/sandboxing.
- **Goose (Block), Continue, Gemini CLI, OpenCode/Crush, mini-SWE-agent** — named in scope but
  **no verified claims surfaced**; their architectures (Goose's MCP-centric extensions,
  Continue's @-mention/RAG context, Gemini CLI's loop) remain an **open follow-up**.

---

## Part 3 — The full architecture anatomy (synthesized)

The six subsystems every one of these agents implements, with the verified design lessons:

1. **Agentic loop** — ReAct-style reason→act→observe; many now offer **Plan/Act** modes
   (plan first, then execute). Loop terminates on task-complete signal, error budget, or user
   stop. *Lesson: as models improve, simpler emergent loops rival heavy scaffolding.*
2. **Tool/action system** — shell exec, file read/edit/write, search, sometimes browser.
   *Lesson: code-as-action (CodeAct) and purpose-built ACIs (SWE-agent) beat rigid JSON tools.*
3. **Edit application** — whole-file vs diff vs unified-diff vs search/replace. *Lesson: the
   single highest-leverage, most-measurable design choice; pick a format your model emits
   reliably, prefer diffs for tokens, and apply leniently.*
4. **Context & navigation** — repo maps (Aider tree-sitter+PageRank), RAG, @-mentions, memory
   files (CLAUDE.md / AGENTS.md / .clinerules). *Lesson: rank-and-inject the most-referenced
   symbols rather than dumping files.*
5. **Permissions & sandboxing** — approval prompts, auto-approve allowlists, OS sandboxes
   (Seatbelt/containers), Docker isolation. *Lesson: the autonomy↔safety dial; granular
   per-action approval is the converging UX.*
6. **Model/provider abstraction + MCP** — multi-LLM (LiteLLM-style), local models, MCP for
   tools. *Lesson: provider-agnosticism is now table stakes.*

---

## What works, and the tradeoffs

| Design choice | Evidence it works | Tradeoff / caveat |
|---|---|---|
| **Diff edit formats** | 3× token efficiency; 20%→61% w/ unified diff | Apply-correctness on small files is disputed; model-specific |
| **Architect/Editor split** | 85% on Aider edit bench | Slow, 2× model calls; impractical interactively |
| **Custom ACI** | +10.7 pts (SWE-agent ablation) | Engineering cost to build the interface |
| **Code-as-action** | 53% SWE-bench Verified (CodeAct) | Needs sandboxed exec; model-coupled score |
| **Repo map (tree-sitter+PageRank)** | Context without whole files | Build/caching complexity |
| **Lenient patch application** | Disabling it = 9× more errors | No published raw data |
| **Heavy scaffolding** | Multi-agent tops leaderboards | Diminishing returns as base models improve |

---

## Caveats & coverage gaps

- **Skewed coverage:** verified detail is Aider + SWE-bench literature heavy. Cline/Roo,
  Continue, Goose, Codex CLI, Gemini CLI, OpenCode/Crush, mini-SWE-agent, Devin-style tools
  yielded **no verified claims** — their specifics here are unverified.
- **No verified stars/licenses** — any popularity figures are approximate.
- **Vendor self-report:** Aider's 85%, 20%→61%, 3× laziness, 30–50%/9× ablations are on
  Aider's *own* benchmarks, often GPT-4-Turbo-specific and 2023–24 dated.
- **SWE-bench scores are model+agent-coupled and point-in-time** — SOTA claims go stale fast.
- **The architecture survey is observational**, not controlled — causal claims are the
  authors' hedged interpretation.
- **Efficiency ≠ correctness** — diffs save tokens but their apply-reliability on small files
  is actively disputed.

## Open follow-ups
- Verified star counts + licenses for all tools in scope.
- Concrete architectures of the uncovered tools (Cline plan/act + .clinerules, Continue
  @-mention/RAG, Goose MCP extensions, Codex CLI seatbelt, Gemini CLI loop, OpenCode/Crush).
- Do edit-format findings hold on **current** frontier models (Claude 4 / GPT-5-class) vs GPT-4 Turbo?
- Controlled (not observational) ablations isolating sandboxing, reviewer/critic sub-agents,
  and memory files.

---

## Sources

**Primary — Aider:**
- Edit formats — https://aider.chat/docs/more/edit-formats.html
- Unified diffs — https://aider.chat/docs/unified-diffs.html
- Architect/Editor — https://aider.chat/2024/09/26/architect.html
- Repo map — https://aider.chat/2023/10/22/repomap.html
- Modes — https://aider.chat/docs/usage/modes.html
- Edit leaderboard — https://aider.chat/docs/leaderboards/edit.html
- Repo-map internals (secondary) — https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system

**Primary — papers & agents:**
- SWE-agent — https://arxiv.org/abs/2405.15793
- CodeAct paradigm — https://arxiv.org/abs/2402.01030
- OpenHands CodeAct 2.1 — https://www.openhands.dev/blog/openhands-codeact-21-an-open-state-of-the-art-software-development-agent
- SWE-bench architecture survey — https://arxiv.org/pdf/2506.17208
- Devin field report (skeptical) — https://www.answer.ai/posts/2025-01-08-devin.html
- Benchmark critiques — https://arxiv.org/pdf/2410.06992 · https://arxiv.org/pdf/2509.16941

**Primary — implementation docs *(unverified this run)*:**
- Codex CLI approvals/sandbox — https://developers.openai.com/codex/agent-approvals-security
- Cline auto-approve — https://docs.cline.bot/features/auto-approve
- Roo Code auto-approve — https://docs.roocode.com/features/auto-approving-actions
- Claude Code sandboxing — https://code.claude.com/docs/en/sandboxing
- OpenHands providers (secondary) — https://deepwiki.com/All-Hands-AI/OpenHands/5.1-llm-configuration-and-provider-support
