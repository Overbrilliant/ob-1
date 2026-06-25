# Agent Tooling Landscape: Architecture & Adoption (Gap-Fill)

> Research compiled 2026-06-19. Topic: verified architecture + adoption data for the
> open-source coding agents and orchestration frameworks that reports #4 and #5 left thin.
>
> **Method:** Deep-research workflow — 24 sources fetched (GitHub repos/READMEs, official
> docs, GitHub API for star counts, arXiv), 115 claims extracted, 25 adversarially verified.
> **25/25 confirmed, 0 killed.**
>
> ⚠️ This run had to be **resumed once** after a synthesis stall (the scope — 14 tools — was
> heavy). Verified detail landed for the **coding agents + MetaGPT**; several **orchestration
> frameworks remain uncovered** (see gaps).

---

## TL;DR — what's converging across the field

Four architectural choices have clearly become standard, plus one counter-trend:

1. **MCP (Model Context Protocol) is the de facto tool-integration standard.** Cline, Goose,
   Gemini CLI, and Crush all support MCP natively — **Goose's entire extension model is MCP**.
2. **Plan/Act separation + human-in-the-loop approval + sandboxing** is widespread. Cline
   pioneered explicit read-only **Plan** + execution **Act** modes; Codex CLI codifies
   graduated approval modes over OS-level sandboxing.
3. **Plain-text memory files standardize on `AGENTS.md`** (and `GEMINI.md`, `CRUSH.md`,
   `CLAUDE.md`) — Crush reads all of them interchangeably.
4. **Multi-agent orchestration spans a spectrum** — from lightweight coordinator/sub-agent
   delegation (Cline) to rigid SOP role pipelines (MetaGPT).
5. **Counter-trend — minimalism works.** mini-SWE-agent's ~100-line bash-only loop scores
   **>74% on SWE-bench Verified**, implying much agent complexity is optional and **model
   capability drives much of the performance.**

---

## Per-tool architecture (verified)

### Cline — Apache-2.0 · ~63.5k★ (Jun 2026)
- **Plan/Act two-mode system** (pioneered the pattern): **Plan** is read-only (reads, searches,
  discusses strategy — *cannot* modify files or run commands); **Act** executes; planning
  context carries over intact on switch.
- **Per-action approval:** every file edit and terminal command needs approval, with an
  optional **auto-approve** toggle that *still* gates destructive commands (`rm -rf`,
  `DROP TABLE`, force push) via a `requires_approval` flag.
- **MCP** servers + Marketplace.
- **Multi-agent:** opt-in SDK feature — a coordinator decomposes work and delegates to
  specialist agents (each with own tools/context) via `team_spawn_teammate` /
  `team_delegate_task`. *Docs caution teams add overhead.*

### OpenAI Codex CLI — graduated approval + OS sandbox
- **Named approval modes:** `untrusted` (auto-runs only known-safe reads, asks for
  state-mutating commands), `on-request` (asks before escalating sandbox — network, edits
  outside workspace), `never` (no prompts, sandbox still enforced).
- **OS-level sandboxing:** macOS via `sandbox-exec` + Seatbelt (SBPL) policies; Linux via
  `bwrap` + seccomp (Landlock supplementary). **Network OFF by default** — explicit opt-in
  required. ⚠️ Documented enforcement bugs (#10390, #13373) can *silently ignore* the network
  setting.

### Goose (Block) — Apache-2.0 · ~49.8k★ · Rust
- **MCP-centric architecture:** 70+ extensions, **each one an MCP server** (stdio/SSE). Runs
  as desktop app, CLI, and API.
- ⚠️ **Governance change:** repo moved to the **Linux Foundation Agentic AI Foundation**
  (`aaif-goose/goose`, redirects from `block/goose`).

### Google Gemini CLI — Apache-2.0 · ~105k★ (most-starred here)
- **MCP** for custom tools (`mcpServers` in `~/.gemini/settings.json`, Stdio/SSE/HTTP).
- **Hierarchical `GEMINI.md` context files** as persistent project memory.
- ⚠️ **Major governance change (2026-06-18):** Google **ceased serving backend requests**,
  shifting to a closed-source **Antigravity CLI** (Go rewrite); the Apache-2.0 repo reportedly
  stays public (donated to the Linux Foundation). Verify before adopting.

### Charmbracelet Crush — FSL-1.1-MIT · provider-agnostic
- **Provider-agnostic:** wide LLM range + custom providers via OpenAI/Anthropic-compatible
  APIs; **switch LLMs mid-session with context preserved**.
- **MCP** via three transports (stdio, http, sse).
- **Permission model:** prompts before tool calls; `--yolo` skips all; `allowed_tools`
  allowlist; serialized permission queue; desktop notifications.
- **Memory files:** reads `AGENTS.md`, `CRUSH.md`, `CLAUDE.md`, *and* `GEMINI.md`
  interchangeably; `AGENTS.md` (created at init) holds build commands, code patterns,
  conventions.

### mini-SWE-agent — the minimalist counter-example
- **~100-line Python agent class**, completely **linear** message history.
- **Bash-only actions, NO tool-calling interface**; each action runs independently via
  `subprocess.run` (**no stateful shell**).
- **>74% on SWE-bench Verified** with strongest frontier models. ⚠️ Model-dependent
  (~70.6% with Claude 4.5 Sonnet) — the score reflects the *model*, not scaffold magic.

### MetaGPT — SOP-driven multi-agent (the rigid end of the spectrum)
- Simulates a software company with **five role agents** (Product Manager, Architect, Project
  Manager, Engineer, QA) working **sequentially/waterfall** (PRD → design → task distribution
  → implementation → tests).
- **Shared message pool** with **publish-subscribe** + role-based subscription; agents
  communicate via **structured outputs (documents/diagrams)**, not free-form dialogue.
  Formula: `Code = SOP(Team)`.

---

## What the convergence implies about "what works"

| Converging choice | What it signals |
|---|---|
| **MCP everywhere** | Tool integration is now a solved, shared standard — build *to* MCP, don't reinvent |
| **Plan/Act + approval + sandbox** | The field agrees autonomy must be *gated*; safety is a first-class design axis, not an afterthought |
| **`AGENTS.md`-style memory** | Plain-text, human-readable, on-demand project memory beat fancy alternatives (matches report #3's index-file lesson) |
| **Orchestration spectrum** | No single multi-agent topology won; pick rigidity to match task structure (matches report #5) |
| **Minimalism (mini-SWE-agent)** | Much scaffolding is optional; as base models improve, simpler loops compete (matches report #4's "autonomous emergent agents" trend) |

> The big cross-report takeaway this reinforces: **as models get stronger, the winning
> direction is simpler harnesses + standard protocols (MCP) + gated autonomy** — not
> ever-heavier custom scaffolding.

---

## Gaps & caveats

- **Still unverified (no surviving claims this run):** **Roo Code, Continue, OpenCode**, and
  the orchestration frameworks **LangGraph, CrewAI, AutoGen, Google ADK, ChatDev, OpenHands**.
  Primary docs for several (LangGraph persistence, CrewAI processes, AutoGen AgentChat, ADK
  workflow agents, ChatDev arXiv 2307.07924) were *fetched* but their claims didn't reach the
  verified top-25. Treat their architectures as not-yet-confirmed here.
- **Edit-application technique not captured** — approval gating is verified, but *how* Cline /
  Codex / Crush / Goose apply edits (diff vs search-replace vs full rewrite) wasn't.
- **Dynamic context/memory model not captured** — only the *static* context-file mechanisms
  (`GEMINI.md`, `AGENTS.md`, `CRUSH.md`) are verified, not in-session token budgeting /
  summarization / RAG.
- **`AGENTS.md` standardization is informal** — Crush reading multiple variants shows
  convergence, but whether it's a *formal* cross-tool spec wasn't established.
- **Time-sensitive:** star counts are approximate Jun-2026 snapshots (Cline ~63.5k, Goose
  ~49.8k, Gemini CLI ~105k); two governance shifts in flight (Goose→LF; Gemini CLI→Antigravity).
- **Convergence finding is medium-confidence synthesis** (inference over individually-verified
  per-tool facts), not a single-source claim.

---

## Sources

**Primary — coding agents:**
- Cline — https://github.com/cline/cline · https://docs.cline.bot/core-workflows/plan-and-act · https://docs.cline.bot/mcp/mcp-overview · https://docs.cline.bot/sdk/guides/multi-agent-teams
- Codex CLI — https://developers.openai.com/codex/agent-approvals-security · https://developers.openai.com/codex/concepts/sandboxing · https://developers.openai.com/codex/config-basic
- Goose — https://github.com/block/goose · https://api.github.com/repos/block/goose
- Gemini CLI — https://github.com/google-gemini/gemini-cli · https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html
- Crush — https://github.com/charmbracelet/crush · https://deepwiki.com/charmbracelet/crush/3.6-file-system-integration
- mini-SWE-agent — https://github.com/SWE-agent/mini-swe-agent · https://mini-swe-agent.com/latest/

**Primary — frameworks (fetched; mostly unverified this run):**
- MetaGPT — https://arxiv.org/abs/2308.00352 · https://github.com/FoundationAgents/MetaGPT
- ChatDev — https://arxiv.org/abs/2307.07924
- LangGraph persistence — https://docs.langchain.com/oss/python/langgraph/persistence
- CrewAI processes — https://docs.crewai.com/en/concepts/processes
- AutoGen AgentChat — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html
- Google ADK workflow agents — https://google.github.io/adk-docs/agents/workflow-agents/
- OpenHands — https://arxiv.org/abs/2407.16741

**Governance:**
- Linux Foundation Agentic AI Foundation — https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
