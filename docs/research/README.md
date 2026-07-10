# Research: Efficient, High-Quality AI Coding Agents

A series of deep-research reports on how to make AI coding agents (like Claude Code) more
**token-efficient** and **higher-quality** — covering efficiency techniques, agent quality,
memory systems, competitor architectures, and multi-agent orchestration.

Each report was produced by a deep-research workflow: fan-out web search → fetch primary
sources → **adversarial 3-vote verification** of every claim → cited synthesis. Vendor
marketing numbers are flagged throughout; refuted claims are recorded, not hidden.

---

## The reports

| # | File | What it answers | Verification |
|---|---|---|---|
| 1 | [claude-code-efficiency.md](claude-code-efficiency.md) | How to cut Claude Code token/cost while keeping quality — native levers, config discipline, tools | 23/25 confirmed; 2 vendor claims refuted |
| 2 | [coding-agent-quality.md](coding-agent-quality.md) | What makes coding *agents* produce better code — techniques + open-source repos | 16 confirmed; 8 rate-limited (not refuted) |
| 3 | [agent-memory-systems.md](agent-memory-systems.md) | Token-efficient agent memory — frameworks, patterns, what's measurable | 25/25 confirmed (clean) |
| 4 | [claude-code-alternatives-architecture.md](claude-code-alternatives-architecture.md) | Full architecture of Claude Code alternatives + what works | 25/25 confirmed (clean) |
| 5 | [multi-agent-orchestration.md](multi-agent-orchestration.md) | Multi-agent benefits, tradeoffs, patterns, how to implement | 24/25 confirmed; 1 killed |
| 6 | [agent-tooling-landscape.md](agent-tooling-landscape.md) | Verified architecture + adoption for the coding agents (Cline, Codex CLI, Goose, Gemini CLI, Crush, mini-SWE-agent) + MetaGPT; what's converging | 25/25 confirmed (clean) |
| 7 | [tech-stack.md](tech-stack.md) | Verified tech stack to **build** OB-1 — language, TUI, MCP, repo map, memory, sandbox, orchestration, packaging | 25/25 confirmed (clean) |
| 8 | [visible-memory-systems.md](visible-memory-systems.md) | Advanced **"very visible"** memory — Google Memory Bank, knowledge graphs (Zep/Graphiti, Cognee), user-editable memory; visibility vs graph-cost | 25/25 confirmed (clean) |
| — | [clarification-questions.md](clarification-questions.md) | How coding agents ask the user a **structured clarifying question** (Claude Code `AskUserQuestion`, Cline `ask_followup_question`, …) + OB-1's `ask_user` design | design/landscape note (not vote-verified) |

> **Build plan:** [`../ob1-plan.html`](../ob1-plan.html) synthesizes reports #1–#6 into the OB-1 architecture (Solo + Fusion/Council/Personas modes). Report #7 above grounds its tech-stack section.

---

## The cross-cutting thesis (what all five reports agree on)

> **Context is the scarce resource. The scaffold around the model — not the model alone —
> decides quality and cost. Spend tokens only where they buy verified value.**

### 1. The model is not the main lever — the harness is
The most robust finding across reports #2 and #4: the same base model swings **10–20
percentage points** of correctness purely from a better *agent-computer interface*, action
representation, and **edit format** (Aider: 20%→61% just by switching to a machine-readable
diff). Invest in tooling before swapping models.

### 2. Less context is more — "context rot" is real
Reports #1 and #3 converge: every token spent depletes a finite "attention budget," and recall
*degrades* as the window fills (confirmed across 18 frontier models). The winning move is
**just-in-time + tiered memory**: a tiny always-loaded index, the bulk stored *outside*
context, and only the **top-k relevant** items pulled in on demand. Claude Code's
`CLAUDE.md` (<200 lines) + `MEMORY.md` index + on-demand topic files is the reference
implementation.

### 3. Efficiency numbers are trustworthy; quality/superiority numbers are not
A recurring honesty pattern (#1, #3, #5): **token/latency savings are structurally robust**
(selective retrieval mechanically beats reprocessing full history — 90%+ savings hold up).
But **"best system" / accuracy benchmarks are mostly vendor self-reported on contested
benchmarks** (Mem0 on LOCOMO; Anthropic's 90.2% multi-agent eval; the refuted 60–90% "token
optimizer" claims in #1). **Always compute-match before crediting an architecture.**

### 4. Sub-agents / workflows trade *total tokens* for *quality and context headroom*
Reports #1, #2, #5 all flag the same caveat: subagent and multi-agent patterns reduce the
**main/orchestrator context** but **increase total token use** (~4–7× multi-agent, ~15×
agent teams). They're worth it when context capacity or verified quality is the constraint —
**not** to save money.

### 5. Multi-agent is narrow; coding is a poor fit
Report #5's sharpest result: at **equal token budgets, single agents match or beat
multi-agent** on reasoning, and **~76% of multi-agent failures are coordination/design
problems**, not model capability. Anthropic itself says coding is a poor fit (few
parallelizable subtasks, weak real-time coordination). Use multi-agent only for
parallelizable, high-value work — and isolate sub-agent context.

### 6. Verification beats generation
Across #2 and #5: self-repair is bottlenecked by **critique quality, not patch generation**
(human feedback still beats self-critique ~1.58×); adversarial review panels and a strong
critic stage are where reliability comes from — but only if the critic is genuinely better
than the generator.

### 7. The field is converging on simpler harnesses + standard protocols
Report #6's survey of competitor tools (Cline, Codex CLI, Goose, Gemini CLI, Crush) shows four
choices becoming standard — **MCP** as the universal tool protocol, **plan/act + approval +
sandboxing** as gated autonomy, **`AGENTS.md`-style plain-text memory files**, and an
orchestration *spectrum* rather than one winner. The counter-trend confirms the thesis:
mini-SWE-agent's **~100-line bash-only loop scores >74% on SWE-bench Verified**, so as base
models improve, **simpler harnesses + standard protocols beat heavy custom scaffolding.**

---

## The practical playbook (distilled across all reports)

1. **Default to Sonnet**; escalate to Opus deliberately; `model: haiku` for trivial subagents.
2. **Lock model/effort at session start**, `/clear` between unrelated tasks — protect the cache.
3. **Keep `CLAUDE.md` < 200 lines**; push specifics into Skills / on-demand memory files.
4. **Design the edit format and tools** as carefully as a human UI; prefer diffs, apply leniently.
5. **Retrieve top-k, externalize the rest**; prune at runtime (compaction, context editing).
6. **Reach for multi-agent only when work is parallelizable + high-value**; isolate context.
7. **Add a critic/verifier stage** — and compute-match your single-agent baseline before
   believing any "multi-agent win."
8. **Measure first** (`ccusage`) before optimizing.

---

## Recurring caveats (apply to every report)
- **Vendor self-report bias** dominates quality/superiority numbers — treat percentages from
  tool-makers as unproven until independently replicated.
- **Time-sensitivity** — pricing, versions, star counts, and SOTA scores are mid-2026 values
  and move fast; feature availability is version-gated.
- **Coverage gap** — report #6 verified the major CLI coding agents (Cline, Codex CLI, Goose,
  Gemini CLI, Crush, mini-SWE-agent) + MetaGPT. **Still unverified:** Roo Code, Continue,
  OpenCode, and the orchestration frameworks **LangGraph, CrewAI, AutoGen, Google ADK, ChatDev,
  OpenHands** (their primary docs were fetched but claims didn't clear the verification gate).
  Also open across tools: the concrete *edit-application* technique and *dynamic* (in-session)
  context/memory model.

---

*Generated via deep-research workflows, 2026-06-18 → 2026-06-19. Every claim carries its
adversarial vote and primary-source citation in the individual reports.*
