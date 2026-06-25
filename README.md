# OB-1

A multi-mind, token-frugal CLI coding agent — everything Claude Code does, plus three
collaborative reasoning modes (Fusion · Council · Personas) that are only recommended over plain
Solo when a **compute-matched eval** proves they beat it at equal tokens.

Full design: **[`docs/planning/ob1-plan.html`](docs/planning/ob1-plan.html)** · evidence base: **[`docs/research/`](docs/research/)**
(eight adversarially-verified research reports).

## Install — type `ob1` anywhere

Homebrew:

```
brew install overbrilliant/tap/ob-1
```

Native install script:

```
curl -fsSL https://github.com/overbrilliant/ob-1/releases/latest/download/install.sh | sh
```

npm (requires Bun at runtime):

```
npm install -g @overbrilliant/ob1
```

The release installer detects macOS/Linux + arm64/x64, downloads the matching binary, verifies it
against `checksums.txt`, and drops `ob1` into a bin dir already on your PATH (prefers
`~/.local/bin`). Pin a version with:

```
curl -fsSL https://github.com/overbrilliant/ob-1/releases/latest/download/install.sh | sh -s -- --version v0.1.1
```

For source installs:

```
git clone https://github.com/overbrilliant/ob-1.git && cd ob-1
./scripts/install.sh          # installs `ob1` onto your PATH — then just run: ob1
```

- **`./scripts/install.sh`** (default) installs a tiny **launcher** that runs through Bun from the
  repo, so you get the full native experience (tree-sitter repo map, sqlite-vec KNN) and `git pull`
  updates apply automatically.
- **`./scripts/install.sh --binary`** instead compiles a **self-contained executable** (`bun run
  build:bin`) — no Bun needed to *run* it; copy the single `ob1` file to any machine. (Native extras
  fall back to OB-1's pure-TS implementations in this mode.)

To run without installing: `bun run src/index.ts` (or `bun start`).

Distribution details, release provenance, and Apple signing setup are documented in
[`docs/distribution.md`](docs/distribution.md).

## Status — Phase 0/1 (skeleton that runs)

```
bun run src/index.ts          # start the REPL
bun run scripts/smoke.ts      # memory-engine self-test (no API key needed)
```

Enable the model with a provider key (auto-detected):

```
export OPENROUTER_API_KEY=...   # OpenAI-compatible; default model qwen/qwen3.6-plus
export ANTHROPIC_API_KEY=...    # default model claude-sonnet-4-6
# or any OpenAI-compatible endpoint:
export OPENAI_API_KEY=...  OB1_BASE_URL=https://your-endpoint/v1
```

…or just run **`/models`** in the app — no env vars needed. Models and providers live in **one**
place: if nothing is configured yet, `/models` first opens a setup tab to connect
**[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)** — a self-hosted, OpenAI-compatible
proxy that stacks the **free tiers of ~16 LLM providers** (Gemini, Groq, Cerebras, Mistral,
OpenRouter, GitHub Models, Cohere, …) behind one endpoint (~1.7B tokens/month). You run the
server (Docker / Node) **locally or on a remote host**; the setup tab explains what it is, takes the
proxy **URL + token**, and **tests the connection live**. The default model is **`auto`** (the proxy's
router picks the best free model); `/models` then lists the proxy's catalog so you can pick a specific
one any time (or re-enter the URL/key). It saves to the global `~/.ob1/settings.json` so it survives
restarts **and is identical no matter which folder you launch from** (override the location with
`OB1_SETTINGS_DIR`); an explicit env key always takes precedence. Run `bun run scripts/freellm-live.ts` with
`OB1_FREELLM_URL` / `OB1_FREELLM_KEY` to test against a real server.

Override the model with `OB1_MODEL=...`. Without a key, the memory engine and all
slash-commands still work. **Verified live** end-to-end with Qwen 3.6 Plus via OpenRouter
(tool-calling, approval gate, Plan-mode blocking, memory persistence) and with FreeLLMAPI's
`auto` router (85-model catalog, streamed chat completion).

### What works today
- **CLI REPL** with mode/phase-aware prompt and slash-commands.
- **Gated agent loop** (Solo): ReAct loop with Plan/Act modes and a per-action approval gate;
  destructive shell commands always prompt (`src/agent/loop.ts`).
- **Tools**: `read_file`, `list_dir`, `write_file`, `edit_file` (search/replace diff),
  `run_bash`, plus memory tools `memory_add` / `memory_search` / `relate` (`src/agent/tools.ts`).
- **Memory engine** (`src/memory/store.ts`) — the "very visible" design:
  - plain-text **fact records** with an immutable **revision trail** (Google Memory Bank model),
  - a **relationship graph** of entities + typed, **bi-temporal** edges (invalidated, not deleted),
  - **semantic vector search** (pure-TS cosine + pluggable embedder) + **bounded neighbourhood** traversal,
  - all in one SQLite file (Bun's built-in driver — zero install).
- **Just-in-time retrieval** — each turn injects the top-k facts relevant to your input (R3).
- **Repository map** (`src/context/repomap.ts`) — ranks files by reference centrality
  (cross-reference graph + PageRank) and lists their key symbols; `repo_map` tool + `/map`.
- **`/memory` inspector** — list / search / revision-log / graph: memory you can actually see.
- **MCP client** (`src/mcp/`) — connects to MCP servers over stdio (JSON-RPC), exposes their
  tools as `mcp__<server>__<tool>` (read-only tools auto-run, rest gated). Configure via
  `mcp.json` / `.ob1/mcp.json`; `/mcp` lists them.
- **Multi-mind runtime** (`src/multimind/`) — spawns N **isolated** read-only workers in parallel,
  then a synthesizer compresses their drafts into one answer (`/fanout <task>`). ⚠️ ~Nx tokens.
- **Fusion mode** (`src/multimind/fusion.ts`) — `/mode fusion` routes each task to best-of-N
  candidates (optionally across **different models** via `OB1_FUSION_MODELS`), **auto-scores** each
  (in-process TS/JS syntax check, Python `py_compile`, or a custom `OB1_FUSION_CHECK` command with
  `$OB1_FILE`), then synthesizes grounded in which candidates actually passed (R5, plan Diagram 5).
- **Council mode** (`src/multimind/council.ts`) — `/mode council` (or one-shot `/council <task>`)
  drafts a solution, then a **reviewer** openly critiques the whole draft (correctness · completeness ·
  safety · simplicity, no fixed lens) and votes `BLOCK`/`OK`; the author revises against the review over
  up to `OB1_COUNCIL_ROUNDS` rounds (early-stop when a round is clean), and a **finalizer** ships one
  comprehensive answer with an `ACCEPT`/`REVISE` verdict. Run **two models back and forth** with
  `OB1_COUNCIL_MODELS` (first authors/revises, second reviews) for genuinely independent eyes (R5, plan Diagram 6).
- **Personas mode** (`src/multimind/personas.ts`) — `/mode personas` (or one-shot `/personas <task>`)
  reads your goal and **casts the expert panel it needs** (each with a name, title, and bio — up to
  `OB1_PERSONAS_MAX`), who then hold a **turn-based dialogue** (building on and pushing back against
  each other) over `OB1_PERSONAS_ROUNDS` rounds; a **facilitator** turns the discussion into one
  comprehensive final solution. The Former may cast a single expert — **collapsing to Solo** when a
  panel isn't warranted (R5/R6, plan Diagram 7). (Personas is single-model by design: a heterogeneous
  panel measurably hurt it in the eval — weak members poisoned the synthesis — so multi-model routing
  is left to Fusion/Council.)
- **Compute-matched eval** (`src/eval/`) — the R5 honesty gate. `/eval [modes…]` (or
  `bun run scripts/eval.ts`) runs SWE-bench-shaped tasks with **objective** checks (exit 0 = PASS,
  no model-judge) across the modes, then scores each against **Solo@k** — where `k` is how many
  Solo attempts the mode's token budget would buy and `Solo@k = 1-(1-p_solo)^k` (pass@k). A mode is
  reported "justified" only when it beats Solo *at equal tokens*; otherwise the answer is: just use
  Solo. Tasks extend from `eval/tasks/*.json`; `OB1_EVAL_TRIALS` raises the Solo@k estimate's fidelity.
- **Adaptive router** (`src/multimind/router.ts`) — `/mode adaptive` (or `/route <task>`). Runs Solo
  first, scores it against the objective check, and **escalates to Fusion/Council only when Solo
  fails** — matching effort to difficulty so the heavy modes aren't spent on tasks Solo already nails
  (Snell et al. 2024). Signal via `OB1_ROUTE_CHECK`; target via `OB1_ROUTE_ESCALATE=fusion|council`.
- **On-demand Skills** (`src/skills/`) — markdown skills (frontmatter `name`/`description`) whose
  descriptions are always visible but whose bodies load only when the agent calls `use_skill`
  (keeps base context small). `/skills`, `/skill <name>`; example in `skills/code-review.md`.
- **Context-editing** (`src/agent/context.ts`) — evicts stale tool output as the window fills.
- **OS sandbox** (`src/safety/sandbox.ts`) — macOS Seatbelt + Linux bubblewrap for `run_bash`; `/sandbox` modes.
- **Provider gateway** (`src/providers/`) — multi-provider: Anthropic + OpenAI-compatible
  (OpenRouter / OpenAI / local), auto-detected from env, behind one internal format. Named
  **provider profiles** (`profiles.ts`, e.g. FreeLLMAPI) fold provider setup into `/models`: when
  nothing is configured it prompts for a URL + key, tests the connection, and persists it (no env
  vars required); a configured proxy lists its live catalog with `auto` as the default.

> **sqlite-vec & tree-sitter note:** the research recommends both, but neither loads under Bun
> (extension loading disabled; native/WASM dlopen fails). OB-1 ships equivalent pure-TS
> implementations that work today, with the native libs as drop-in upgrades on Node. Set
> `OPENAI_API_KEY` for real embeddings; otherwise a local offline embedder is used. See
> `docs/planning/PROGRESS.md`.

### Commands
```
/help                 show help
/mode <m>             solo | fusion | council | personas | adaptive
/plan | /act          read-only Plan vs Act
/model <id>           set model (default claude-sonnet-4-6)
/auto on|off          auto-approve (destructive cmds still ask)
/sandbox <m>          shell sandbox: off | read-only | workspace-write
/memory               list facts + relationships
/memory add <text>    remember a fact
/memory search <q>    keyword search
/memory log <id>      revision history of a fact
/memory graph         print the relationship graph
/map                  ranked repository map (symbols by centrality)
/fanout <task>        multi-mind: N isolated workers + synthesis (~Nx tokens)
/council <task>       author ↔ reviewer revise rounds → comprehensive finalizer
/personas <task>      goal → tailored expert-panel dialogue → facilitator finalizes
/route <task>         adaptive — Solo first, escalate to Fusion/Council only if the check fails
/eval [modes…]        compute-matched eval — does each mode beat Solo at equal tokens?
/mcp                  list connected MCP servers + their tools
/skills               list available skills
/skill <name>         show a skill's full instructions
/agents [regen]       show/regenerate the AGENTS.md project index
/clear                reset conversation context
/exit | /quit         leave
```

## Stack
TypeScript on **Bun** (single-binary path via `bun build --compile`), SQLite via `bun:sqlite`,
zero runtime dependencies so far. See [`docs/research/tech-stack.md`](docs/research/tech-stack.md) for the
full verified rationale.

## Layout
```
src/
  index.ts            REPL + slash-commands + /memory inspector
  config.ts           session config (model, mode, plan/act, approval)
  cli/ui.ts           ANSI helpers + banner
  agent/loop.ts       gated ReAct loop (Solo) + JIT memory retrieval
  agent/tools.ts      tool/action system + diff edit engine + repo_map
  providers/          gateway + anthropic + openai-compatible (OpenRouter/OpenAI)
  mcp/                MCP client (stdio + http + sse JSON-RPC) + server manager
  skills/             on-demand skills registry
  multimind/          parallel worker runtime + fan-out/Fusion/Council/Personas orchestrators
  eval/               compute-matched eval harness — tasks · runners · Solo@k math · report
  safety/sandbox.ts   macOS Seatbelt + Linux bubblewrap sandbox for run_bash
  memory/store.ts     fact store + revisions + relationship graph + vector index (SQLite)
  memory/embed.ts     pluggable embedder (local offline / OpenAI API)
  context/repomap.ts  symbol extraction + cross-ref PageRank repository map
scripts/smoke.ts      memory + semantic-search self-test
```

See [`docs/planning/PROGRESS.md`](docs/planning/PROGRESS.md) for the phased roadmap and what's next.
