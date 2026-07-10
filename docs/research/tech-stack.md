# Tech Stack for OB-1: Verified Recommendations

> Research compiled 2026-06-19. Topic: the best technology stack to build OB-1 — a
> production-grade, multi-mind CLI coding agent (Fusion/Council/Personas modes, MCP tools,
> tree-sitter repo map, tiered memory, OS sandboxing).
>
> **Method:** Deep-research workflow — 27 sources fetched (vendor repos, official docs,
> package registries — mostly primary), 133 claims extracted, 25 adversarially verified.
> **25/25 confirmed, 0 killed.**

---

## TL;DR — the recommended stack

| Layer | Primary recommendation | Why (verified) |
|---|---|---|
| **Core language** | **TypeScript + Bun** *(co-primary: Go)* | Richest LLM/MCP ecosystem; fan-out is I/O-bound so the event loop suffices; `bun build --compile` → single binary. Go (Crush) is the strongest *production-validated agent-TUI* precedent. |
| **TUI** | **Ink** (if TS) / **Charm: Bubble Tea+Lipgloss+Glamour** (if Go) | Charm stack is first-party validated by Crush (a real shipping coding agent). |
| **LLM/provider layer** | **Vercel AI SDK** (TS) or **LiteLLM** (Py sidecar) ⚠️*not verified this round* | Multi-provider routing/streaming/tool-calling for the multi-model modes. |
| **MCP** | **Official SDK for your language** | MCP is mature everywhere; Rust `rmcp` hit stable **1.7.0** (May 2026); Crush ships Go MCP over stdio/http/sse. |
| **Repo map** | **tree-sitter** + `tree-sitter-language-pack` | The proven Aider design — AST symbol extraction. |
| **Memory/retrieval** | **SQLite + sqlite-vec** | Pure C, zero-dep, `vec0` KNN with metadata/partition filtering — ideal at single-dev scale. |
| **Sandboxing** | **macOS Seatbelt (`sandbox-exec`) + Linux bubblewrap (`bwrap`)** | The *exact* primitives both Claude Code and Codex CLI ship — language-agnostic (shell out). |
| **Orchestration** | **Own your control flow** (in-process async fan-out) | Both Claude Code workflows and OpenAI Agents SDK do this; frameworks only get you ~70–80%. |
| **Packaging** | **Single binary** (`bun build --compile`, or Go/Rust native) | Cross-compiles to Linux/macOS/Windows × x64/arm64. |

---

## The core decision: language & runtime

What the leading shipping agents actually use (verified):
- **Crush (Charmbracelet)** → **Go** (98.4% of repo) — a real, 23k★ TUI coding agent.
- **OpenAI Codex CLI** → **Rust** (`codex-rs`) — the Rust rewrite; best sandbox + official `rmcp`.
- **Cline** → **TypeScript**; **Aider / mini-SWE-agent** → **Python**.
- **Bun** → `bun build --compile` bundles runtime + all imports into one executable and
  cross-compiles for Linux (glibc/musl), Windows, macOS on x64/arm64.

### The key insight that drives the recommendation
**Multi-agent fan-out is I/O-bound, not CPU-bound.** Fusion/Council/Personas spend their time
*waiting on LLM API calls*, not burning CPU. The proof: the **OpenAI Agents SDK fans out with
plain Python `asyncio.gather`** — no systems-language threads needed. So Go/Rust's native
concurrency advantage is **less decisive than it looks** for this workload, which frees the
decision to optimize for *ecosystem* instead.

### Recommendation
- **Primary — TypeScript + Bun.** Best LLM/MCP/agent-SDK ecosystem (critical because OB-1 is a
  *multi-model* agent — the provider-abstraction layer is the hot path for Fusion/Council).
  Single binary via `bun build --compile`. Precedent: Cline, original Codex CLI.
- **Co-primary / strong alternative — Go + Charm.** If a fast single static binary and native
  goroutine concurrency matter more than SDK breadth, Go is the most *production-validated*
  choice for an agent TUI specifically (Crush). Weaker LLM-SDK ecosystem is the tradeoff.
- **Honorable mention — Rust.** Best performance and sandbox story (Codex), official `rmcp` MCP
  SDK at 1.x, but the slowest iteration velocity — pick it only if perf/safety dominate.

> ⚠️ This slightly revises `ob1-plan.html`'s stack section (which led with TypeScript and named
> Rust as the alt). The verified evidence elevates **Go/Crush** as the strongest agent-TUI
> precedent, so the honest framing is **TS+Bun and Go+Charm as co-primaries**, Rust third.

---

## Per-layer findings (all 3-0 verified unless noted)

### Terminal UI
- **Charm stack (Bubble Tea / Lipgloss / Glamour / Bubbles)** is first-party validated — Crush
  is built by Charmbracelet on these exact deps, handling streaming output, diffs, prompts,
  mid-session model switching, MCP, and LSP. → **Use Charm if Go.**
- **Ink** (React/Node), **Ratatui** (Rust), **Textual** (Python) are viable alternatives but
  were **not independently verified** this round. (Ink is the natural pick if core = TS.)

### MCP (tool protocol)
- **Mature across languages.** Official Rust **`rmcp`** (modelcontextprotocol org, on tokio) hit
  stable **1.7.0 (2026-05-13)**. Crush ships production Go MCP over **stdio / http / sse** with
  secret resolution and per-server tool disabling. → Use the official SDK for whatever core you pick.

### Repo map
- **tree-sitter AST symbol extraction** — parse to AST, extract functions/classes/vars/types
  (the Aider design). ⚠️ **`py-tree-sitter-languages` is unmaintained**; Aider migrated to
  **`tree-sitter-language-pack`** — use the maintained successor.

### Memory / retrieval
- **SQLite + sqlite-vec** — pure C, no dependencies, runs anywhere SQLite runs (incl. WASM).
  Stores float/int8/binary vectors in `vec0` virtual tables; KNN `ORDER BY distance LIMIT k`
  with metadata/partition columns for filtered top-k. **Lowest-friction choice at single-dev
  scale.** ⚠️ LanceDB/Qdrant/Chroma/libSQL/DuckDB and specific local-embedding models were
  **not assessed** — "not verified," not "rejected."

### Sandboxing (the strongest-evidence section)
**Both Claude Code AND Codex CLI converge on the same OS-level primitives — not gVisor/microVMs/containers:**
- **macOS:** built-in **Seatbelt** via `sandbox-exec` with dynamically generated profiles
  (nothing to install).
- **Linux/WSL2:** **bubblewrap (`bwrap`)** for filesystem isolation; Claude Code adds **`socat`**
  to relay network + optional **seccomp**; Codex prefers `bwrap` on PATH with a bundled fallback
  needing unprivileged user namespaces.
- **Anthropic ships `sandbox-runtime`** (a reusable research-preview lib doing exactly this) —
  you can build on or mirror it.
- **Tiered approval model (mirror Codex):** `read-only` → `workspace-write` → `full-access`.
- ✅ **Language-agnostic:** you shell out to these primitives, so the sandbox is identical
  whether OB-1 is TS, Go, or Rust. ⚠️ **Native Windows (non-WSL2) has no first-class primitive
  here** — WSL2 is effectively required.

### Multi-agent orchestration
- **Own your control flow in code.** Claude Code "dynamic workflows" = a JS script in an
  **isolated background runtime** holding the loop/branching/intermediate results in script
  variables (not model context), with bounded fan-out (**≤16 concurrent, 1,000 agents/run**),
  subagents as the worker primitive. OpenAI Agents SDK = `asyncio.gather` + mix of LLM-driven
  and code-driven orchestration.
- **Skepticism toward frameworks (12-factor-agents):** most "agents" are "mostly deterministic
  code with LLM steps sprinkled in"; adopting LangGraph/AutoGen/CrewAI **gets you ~70–80%**,
  then you "reverse-engineer the framework... or start over." **Factor 8: Own your control
  flow.** → For OB-1's deterministic Fusion/Council/Personas fan-out, **build the orchestrator
  yourself**; don't take a hard framework dependency. *(Caveat: this is authoritative expert
  opinion, not a measured survey; LangGraph was explicitly designed low-abstraction in response.)*

---

## The recommended build, concretely

**Primary stack (TypeScript + Bun):**
- **Runtime/lang:** TypeScript on Bun → `bun build --compile` single binary
- **TUI:** Ink
- **LLM layer:** Vercel AI SDK (multi-provider, streaming, tool-calling, cache-aware) *(verify)*
- **MCP:** official TypeScript MCP SDK
- **Repo map:** tree-sitter (Node bindings) + `tree-sitter-language-pack` grammars
- **Memory:** SQLite + sqlite-vec
- **Sandbox:** shell out to Seatbelt (`sandbox-exec`) / bubblewrap (`bwrap`) + socat/seccomp
- **Orchestration:** in-process async fan-out (`Promise.all`-style), bounded concurrency, your own loop
- **Distribution:** single compiled binary + npm fallback

**Alternative stack (Go + Charm):**
- **Runtime/lang:** Go → native static binary
- **TUI:** Bubble Tea + Lipgloss + Glamour + Bubbles (Charm)
- **LLM layer:** official Anthropic/OpenAI Go SDKs + thin provider abstraction *(narrower ecosystem)*
- **MCP:** Go MCP SDK (Crush-proven over stdio/http/sse)
- **Repo map / Memory / Sandbox / Orchestration:** tree-sitter (Go) · sqlite-vec · same OS sandbox · goroutine fan-out

---

## Caveats & what's still open

- **Not verified this round (treat as "not assessed," not rejected):** the **LLM provider
  abstraction layer** (Vercel AI SDK vs LiteLLM vs LangChain vs raw SDKs) — *the most important
  unverified piece for the multi-model modes*; the TUI alternatives (Ink/Ratatui/Textual);
  vector-DB alternatives (LanceDB/Qdrant/Chroma/libSQL/DuckDB) and the default local-embedding
  model.
- **Time-sensitive:** Codex CLI is a recent Rust rewrite; Claude Code workflows need v2.1.154+;
  `rmcp` 1.7.0 is ~1 month old; the 16-concurrent/1,000-agent caps can change.
- **One stale source:** `py-tree-sitter-languages` is unmaintained → use `tree-sitter-language-pack`.
- **One 2-1 nuance:** Bun's "`--compile` bundles *everything*" has an edge case — runtime-dynamic
  `require()` resolution isn't always traceable, narrowing "all."
- **"Own your control flow"** is a strong *default* for coding agents, not an absolute.

## Recommended follow-up
- A focused run on the **provider-abstraction layer** (Vercel AI SDK vs LiteLLM vs raw SDKs) for
  multi-provider routing, prompt-cache awareness, and streaming under parallel fan-out — the one
  hot-path layer this round left unverified.

---

## Sources

**Primary — repos / docs / registries:**
- Crush (Go + Charm + MCP) — https://github.com/charmbracelet/crush
- Bun compile — https://bun.com/docs/bundler/executables
- Codex CLI sandbox — https://developers.openai.com/codex/concepts/sandboxing · https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
- Claude Code sandbox — https://code.claude.com/docs/en/sandboxing
- Anthropic sandbox-runtime — https://github.com/anthropic-experimental/sandbox-runtime
- Rust MCP SDK (rmcp) — https://github.com/modelcontextprotocol/rust-sdk · https://crates.io/api/v1/crates/rmcp
- sqlite-vec — https://github.com/asg017/sqlite-vec
- tree-sitter repo map (Aider) — https://aider.chat/2023/10/22/repomap.html
- Claude Code workflows — https://code.claude.com/docs/en/workflows
- OpenAI Agents SDK orchestration — https://openai.github.io/openai-agents-python/multi_agent/ · https://developers.openai.com/cookbook/examples/agents_sdk/parallel_agents
- 12-factor-agents — https://github.com/humanlayer/12-factor-agents
- Building Effective Agents — https://www.anthropic.com/research/building-effective-agents

**Secondary / context:** Codex Rust rewrite (InfoQ); "How Codex is built" (Pragmatic Engineer);
MCP SDK comparison (Stainless); durable-execution critique (Diagrid).
