# OB-1 Build Progress

Roadmap from [`ob1-plan.html`](ob1-plan.html) §10. Ship the Solo workhorse first; add the
multi-mind modes only once the foundation + eval harness exist (so each mode can be *proven*,
not assumed — R5).

## Phase 0 — Solo core · 🟡 in progress
- [x] Project scaffold (TS + Bun, tsconfig, gitignore)
- [x] CLI/REPL with slash-commands + mode/phase prompt
- [x] Provider gateway — multi-provider: Anthropic + OpenAI-compatible (OpenRouter/OpenAI/local) — R5/R7
- [x] Gated ReAct loop (Plan/Act + approval gate)
- [x] Tool/action system: read/list/write/edit/bash + memory tools
- [x] Diff edit engine (search/replace, uniqueness check) — R4
- [x] **End-to-end verified against a live model** (Qwen 3.6 Plus via OpenRouter): tool-calling,
      approval gate, Plan-mode blocking, and memory persistence all confirmed working
- [x] Streaming output — SSE for both providers, live token output, idle-timeout + retry (see Phase 10)
- [x] Live token/cost meter in the statusline — R1 (Ink TUI `<StatusBar>`: live in/out/cached tokens + ~$cost, see Phase 11)

## Phase 1 — Context & memory engine · 🟡 in progress
- [x] Memory store: fact records + immutable revisions (Memory Bank model) — R8
- [x] Relationship graph: entities + bi-temporal edges (invalidate, not delete) — R8
- [x] `/memory` inspector (list · search · revision-log · graph)
- [x] Bounded k-hop neighbourhood (cost-control rule) — R8
- [x] Semantic vector retrieval — sqlite-vec KNN (pure-TS cosine fallback) + pluggable embedder — R3/R7 †
- [x] Just-in-time top-k retrieval into the system prompt per turn — R3
- [x] Repository map — tree-sitter symbol extraction (regex fallback) + cross-reference PageRank + budgeted render — R4 ‡
- [x] `repo_map` tool + `/map` command
- [x] `AGENTS.md` auto-generation at init + always-loaded index in the prompt — R6
- [x] Context-editing — evict stale tool-result output past a budget (81% reduction in test) — R3
- [x] LLM-summary compaction of older turns — wired into the loop with a model summarizer (see Phase 10) — R3

> **† sqlite-vec / ‡ tree-sitter — now ACTIVE on Bun (2026-06-21).** Both libraries the research
> recommends are wired in and run on Bun (and Node); the pure-TS implementations remain as an
> automatic fallback so a host without the prerequisites never breaks. The earlier "neither loads on
> Bun" note was a version/config problem, not a hard limit (re-probed). ‡ **tree-sitter**:
> `web-tree-sitter@0.20.8` + `tree-sitter-wasms` grammars (the matched 0.20 ABI — newer web-tree-sitter
> broke the wasm ABI/API); `src/context/treesitter.ts` parses each file and falls back to the regex
> extractor when a grammar is missing or a parse fails (`OB1_TREESITTER=0` disables). † **sqlite-vec**:
> Bun's bundled sqlite omits dynamic extension loading, so `Database.setCustomSQLite()` repoints
> bun:sqlite at a capable libsqlite3 (Homebrew on macOS, a system lib on Linux), then sqlite-vec runs a
> vec0 cosine KNN; falls back to the pure-TS brute-force cosine when no capable lib is found
> (`OB1_VEC=0` disables). The embedder is pluggable: set `OPENAI_API_KEY` for real semantic
> embeddings; otherwise a local hashed-subword baseline keeps it fully offline.

## Phase 2 — Tools, skills & safety · 🟡 in progress
- [x] MCP client (stdio + **http (Streamable HTTP)** + **legacy SSE**) JSON-RPC, server manager + namespaced tools — verified — R6/R7
- [x] On-demand Skills — descriptions in prompt, bodies lazy-loaded via `use_skill`; `/skills`, `/skill` — R1
- [x] OS sandbox: Seatbelt (macOS) + **bubblewrap (Linux)** for `run_bash`, `/sandbox` modes — verified — R7

## Phase 3 — Multi-mind runtime · 🟢 core done
- [x] Parallel worker spawner with isolated context windows (read-only tools) — R5
- [x] Result compression back to orchestrator (synthesizer pass)
- [x] `fanout` orchestrator (best-of-N skeleton) + `/fanout` — verified live (3 workers + synthesis)
- [x] Concurrency-capped `runParallel`, ordered results, per-worker token accounting

## Phase 4 — Fusion · 🟢 done
- [x] Best-of-N fan-out with optional **multi-model** routing (`OB1_FUSION_MODELS`) — R5
- [x] **Auto-scoring** of candidates: in-process TS/JS syntax (Bun.Transpiler), Python
      `py_compile`, or a custom objective check (`OB1_FUSION_CHECK`, `$OB1_FILE`)
- [x] Score-grounded synthesis (synthesizer told which candidates PASS/FAIL)
- [x] `/mode fusion` routes every task through Fusion — verified live (single + multi-model)

## Phase 5 — Council · 🟢 done
- [x] Author drafts → **lens-specialized critics** (correctness / safety / simplicity) review in
      parallel, each returning a `VERDICT: BLOCK|OK` — R5
- [x] **Revise rounds**: author revises against blocking critiques; early-stop once a round raises
      no blockers; round budget via `OB1_COUNCIL_ROUNDS` (default 2)
- [x] **Arbiter** ships the final draft with an `ACCEPT|REVISE` verdict, grounded in outstanding critiques
- [x] Configurable lenses via `OB1_COUNCIL_LENSES`; `/mode council` + one-shot `/council <task>`
- [x] Deterministic smoke (`council-smoke.ts`): verdict parsers + full flow via injected runner
      (early-stop, round cap, accept/revise) — no API key

## Phase 6 — Personas · 🟢 done
- [x] **Persona Former** dynamically picks the expert roles a task needs (lead role first); it may
      pick exactly ONE — collapsing to Solo — when a panel isn't warranted (the R5/R6 honesty caveat)
- [x] **Shared blackboard** (durable state, not message-passing — R5): personas post findings /
      constraints / open questions; later rounds read the whole board and refine (`OB1_PERSONAS_ROUNDS`, default 2)
- [x] **Lead synthesis**: the first-formed persona integrates the board into one final plan/answer
- [x] `/mode personas` + one-shot `/personas <task>`; panel size capped via `OB1_PERSONAS_MAX`
- [x] Deterministic smoke (`personas-smoke.ts`): persona parsing + blackboard + full
      former→panel→board→lead flow, collapse-to-Solo, and board-awareness — no API key

> All three opt-in multi-mind modes (Fusion · Council · Personas) now run on the one Phase 3 runtime.

## Phase 7 — Eval harness · 🟢 done
- [x] SWE-bench-shaped tasks with **objective** checks (exit 0 = PASS via `$OB1_FILE`; no model-judge);
      built-in `sum-evens` + `slugify`, extensible from `eval/tasks/*.json` — R5
- [x] `runEval` runs every (task × mode × trial), extracts code, and grades it with the task's check
- [x] **Compute-matched verdict** (`computeMatched`): each mode's pass rate vs **Solo@k**, where
      `k = mode tokens / Solo tokens` and `Solo@k = 1-(1-p_solo)^k` (pass@k) — a mode is "justified"
      ONLY if it beats that equal-token baseline; otherwise default to Solo (the R5 honesty gate)
- [x] `/eval [modes…]` in the REPL + standalone `scripts/eval.ts` (`OB1_EVAL_TRIALS` for real Solo@k)
- [x] Plain-text report with per-mode pass% · tokens · k× · solo@k% · verdict
- [x] Deterministic smoke (`eval-smoke.ts`): the built-in checks really discriminate correct vs wrong
      code through the real grader, and the Solo@k math is exact on hand-computed values — no API key

## Phase 8 — Research-backed mode improvements · 🟢 done
Grounded in a literature review (see commit messages for citations); the consistent finding — and our
own eval's — is that the real levers are **objective verification** and **difficulty-aware allocation**,
not more agents.
- [x] **Fusion selection layer**: pairwise knockout tournament with a position-debiased judge
      (LLM-Blender) · agreement/Universal-Self-Consistency fallback · F4 verify-the-synthesis +
      revert-on-regression · optional Mixture-of-Agents refine layer (`OB1_FUSION_MOA`)
- [x] **Council grounding/debiasing**: objective check feeds the critique/revise/arbiter loop as oracle
      feedback (`OB1_COUNCIL_CHECK` — intrinsic self-correction degrades without it, Huang et al.) ·
      distinct arbiter model (`OB1_COUNCIL_ARBITER_MODEL`) + anti-verbosity (LLM-judge bias) ·
      optional symmetric debate (`OB1_COUNCIL_DEBATE`, Du et al.)
- [x] **Adaptive router** (`/mode adaptive`, `/route`): Solo-first, escalate to Fusion/Council only when
      the objective check fails (Snell et al. — match effort to difficulty)
- [x] Deterministic smokes for every piece (`fusion-smoke`, `council-smoke`, `router-smoke`) — 11/11 green

> Honest note: these are **wired and unit-tested**, not yet proven to beat Solo at equal tokens — that's
> what the eval is for. Run `/eval` with a real `OB1_*_CHECK` to see if any now clears the bar.

## Phase 9 — Capability frame + hard-task suite · 🟢 done
Goal reframe: the question that matters is **"does a mode SOLVE the hard problems Solo fails?"** (raw
capability — token cost is *not* a gate), not just "beat Solo at equal tokens."
- [x] `computeCapability` / `renderCapability`: per-mode raw pass% · pass% on **hard** tasks (those Solo
      doesn't ace) · **lift** vs Solo · **# recovered** · # Solo never solved. `/eval` now prints
      Capability first, then the compute-matched efficiency table.
- [x] **12 adversarially-verified hard tasks** (`eval/tasks/*.json`) generated by a 12-agent fan-out
      workflow — date math, byte humanization, strict roman/base parsing, int→words, interval merge,
      CSV, version compare, glob, RLE, expr eval, duration. Every check was verified to discriminate a
      reference-correct impl from a plausible-wrong one (checks base64-embedded for quote-safety).

## Phase 10 — spec-gap closure · 🟢 done (2026-06-20)
A spec audit (9 subsystem auditors + adversarial verify) found features in `ob1-plan.html` not yet built.
Closed the "missing entirely" set — 12 of 13 (Ink TUI deferred):
- [x] **Prompt caching** — Anthropic `cache_control` breakpoints on the stable prefix (system + last tool) — R1
- [x] **Streaming** — both providers stream SSE (`providers/http.ts`); live token output; **idle-timeout + connect-retry** (fixes the silent-hang risk a plain `fetch` had)
- [x] **Lenient/auto-retry edit-apply** — `applyFlexibleEdit`: exact → whitespace/indentation-flexible fallback
- [x] **LLM-summary compaction** — `compactIfNeeded` wired into the loop with a model summarizer
- [x] **Topic files** — `context/topics.ts` + `read_topic` tool + catalog in the system prompt (debugging.md/conventions.md spill tier)
- [x] **Deferred MCP tool defs** — `load_mcp_tool` activates MCP tools on demand; loop recomputes tool defs per step
- [x] **Diff viewer** — `renderDiff` (LCS line diff) shown before every file mutation
- [x] **Browser/web tool** — `web_fetch` (HTML→text, bounded)
- [x] **Per-mode token budget** — declared up front before each multi-mind run ("cost is never a surprise")
- [x] **Auto-suggest escalation** — `suggestMode` heuristic recommends Fusion/Council/Personas on hard/high-value Solo tasks
- [x] **Preferred-CLI steering** — system-prompt guidance to prefer `gh`/`git`/`rg`
- [x] **Effort-lock + mid-switch warning** — `OB1_EFFORT` → `reasoning_effort`; `/model` warns about cache invalidation mid-session
- [x] **Ink (React) TUI** — done in Phase 11 (below)
- Tests: added `edit-smoke`, `topics-smoke`; extended provider/ctx/mcp/router smokes. Streaming + tool-call assembly + the live loop verified end-to-end on Qwen.

## Phase 11 — Ink (React) TUI · 🟢 done (2026-06-20)
The final spec-gap item: replaced the plan's recommended **Ink** front-end (was a plain readline REPL).
- [x] `src/cli/tui.tsx` — Ink app: `<Static>` scrollback · live streaming region · **`<StatusBar>`** with model · mode · plan/act · **live in/out/cached token meter + ~$cost** (`estimateCost` + per-family pricing in `models.ts`) · `<TextInput>` · keypress **approval modal**
- [x] A `TuiController` bridges the non-React agent loop to React state (pushLine / stream / addTokens / approve); the loop streams + reports usage through new `TurnDeps` callbacks (`onText`/`endText`/`onUsage`)
- [x] **Dual-path** `index.ts`: interactive **TTY → Ink TUI**; piped/non-TTY → the readline REPL (so automation + the smoke/e2e pipes still work). Shared `processLine` dispatch.
- [x] `tui-smoke` (ink-testing-library, no TTY): status bar, live token/cost meter, scrollback, streaming, approval. **14/14 smokes green, 0 tsc.** Non-TTY REPL fallback re-verified live on Qwen.
- [x] **Real-PTY e2e** (`scripts/tui-pty.py`): spawns the actual binary under a pseudo-terminal so
      `stdin.isTTY` is true and Ink enters **raw mode**, then asserts the raw-mode boot (banner + status
      bar + input), keystroke+Enter dispatch (`/help`), live re-render (`/mode fusion`), and clean exit 0.
      Closes the prior "no TTY in this harness" gap — interactive raw-mode is now machine-verified
      (macOS + Linux/CI), not just ink-testing-library.
- [x] **Fixed a real-TTY bug the PTY test surfaced: streamed responses appeared then vanished.**
      `<Static items={ctrl.lines}>` was handed the *same mutated array* every render, so Ink memoized
      its item slice and never flushed lines pushed after the first render; the live region's erase
      then wiped them on the next redraw (`console.log` output survived only via Ink's separate
      `patchConsole`). Fix: pass a fresh array (`[...ctrl.lines]`) + commit streamed lines incrementally
      so the live region stays ~one line tall. `tui-pty.py` now asserts **final-screen** persistence
      (reconstructed with `pyte`) — its earlier cumulative-byte check let appears-then-vanishes slip by.
- [x] **TUI polish** (user-requested): filled block **OB-1** wordmark; the input is now a **bordered**
      box and the footer status line is borderless; a `/settings` command shows every setting + how to
      change it; and typing **`/`** opens a live **command menu** (filter-as-you-type, `↑↓` navigate,
      `Tab` complete) so commands are discoverable without `/help`. `tui-pty.py` guards the border, the
      `/` menu, and `/settings`.
- [x] **Interactive pickers + refreshed model registry** (user-requested): `/models` and `/settings`
      open an in-TUI list picker (`TuiController.pick` + `<TuiApp>` `useInput` — `↑↓` navigate, Enter
      select, Esc cancel); selecting a model sets `cfg.model` to its canonical OpenRouter id. The
      registry (`providers/models.ts`) is curated to the **8 current flagships** (one per major lab) —
      Claude Opus 4.8 · Sonnet 4.6 · GPT-5.5 · Gemini 3.1 Pro · Grok 4.3 · GLM 5.2 · DeepSeek V4 Pro +
      default Qwen 3.6 Plus — with context/output/pricing verified against the live OpenRouter catalog
      (June 2026), and an `id` field for picker selection. The banner is now an **ANSI-Shadow** OB-1
      wordmark. `tui-pty.py` drives the picker (arrow + Enter) and asserts the model changes.
- [x] **Loading state · prompt queue · permission mode** (user-requested): a turn now shows an
      **animated spinner + live token consumption** ABOVE the input (`⠋ working… · generating ~N tok ·
      …k out`), and the input **stays editable while busy** so further prompts **queue** (shown as
      `⋯ queued #n: …`) and **auto-run in order** (a single drain loop in `runTui`). New
      **permission mode** `ask` (default) / `autopilot` (`config.ts`, `loop.ts` approval gate) — set
      via the `/settings` picker, surfaced as a `⚡autopilot` status-bar marker. Guards: `tui-smoke`
      asserts the loader/queue/autopilot rendering; `tui-pty.py` drives `/settings → permission →
      autopilot`; queue auto-drain verified live (two turns ran from one + one queued).
- [x] **Persistent settings** (`config.ts` `saveSettings`/`loadConfig`): model · mode · plan/act ·
      sandbox · permission · auto-approve are written to the **global `~/.ob1/settings.json`** (shared
      across every launch folder; override via `OB1_SETTINGS_DIR`) after each change and restored on
      startup, with precedence **env var > saved > default**. A legacy per-folder `<cwd>/.ob1/settings.json`
      migrates into the global file once. A saved model only re-applies under the same provider; a corrupt
      file falls back to defaults. Startup shows a "settings restored" note. Guarded by `settings-persist-smoke`
      (global round-trip + precedence + fallbacks + legacy→global migration) and verified across two real
      PTY sessions (set in one → restored in next). Per-folder data (memory.db, skills, topics) stays local.
- [x] **Inline Markdown in replies** (`mdToAnsi`): model output renders `**bold**` → bold, `` `code` ``
      → cyan, and `# heading` → bold; applied ONLY to model-streamed lines (an `md` flag on scroll
      items), so tool/command output and code are never reformatted. Verified per-cell with pyte
      (bold attribute set, `**` markers consumed); `tui-smoke` guards it.
- [x] **No-typing selection everywhere** (user-requested): the arrow-key picker (formerly only `/models`
      + `/settings`) now backs the bare **`/mode` · `/sandbox` · `/auto` · `/skill` · `/agents`** commands —
      invoked with no argument on a TTY they open the same `↑↓` · Enter · Esc list (typed forms like
      `/mode fusion` still work; the non-TTY REPL keeps its text behavior). Per-setting pickers were
      refactored into shared helpers (`pickMode`/`pickSandbox`/`pickPermission`/`pickAuto`/`pickSkill`/
      `pickAgents` + `setMode`/`modeNote`) so `/settings` and the standalone commands stay in lockstep.
      **Fixed**: in the slash menu, Enter on a highlighted-but-not-fully-typed command used to autocomplete
      it into the input (`/mode ` written, nothing run) instead of running it — it now **runs the
      highlighted command** (the footer's "Enter run"), except arg-taking commands (`/fanout`/`/council`/
      `/personas`/`/route`) which still complete so the task can be typed; an exact-typed name wins over the
      highlight (`/skill` runs `/skill`, not `/skills`). Guards: `tui-smoke` drives stdin (menu ↓ + Enter →
      dispatches the highlighted command, not the raw text) and the picker controller (render · move · confirm ·
      cancel); `tui-pty.py` drives bare `/mode` + `/sandbox` pickers via real keystrokes (arrow + Enter selects).
- [x] **Multi-mind modes: live worker transparency + actually save files** (user-reported "stuck", "doesn't
      show tool calls / thinking", "save files, not just chat"). The heavy modes run ~N sequential read-only
      workers and used to show a frozen `working… 0.0k` with no feedback until the whole run finished.
      `runWorker` now emits a `WorkerEvent` stream — `start` · `text` (streamed thinking, sequential workers
      only via a `stream` flag) · `tool` (each tool call) · `step` (per-model-call token deltas) · `done` —
      threaded through Fusion/Council/Personas/Adaptive/`fanout` via a `run()` wrapper that injects `onEvent`.
      A `workerProgress` handler renders `· author…` headers, **streams the primary workers' thinking** live,
      prints each `→ author: read_file …` tool call (reusing the loop's `describe`), and **bumps the token
      meter after every model call** (the end-of-run bulk `accrue` was removed to avoid double-counting).
      **Save files**: workers are read-only by design (no parallel-writer races, no bypass of the approval
      gate), so the modes only *printed* a solution. New `src/multimind/apply.ts` (`shouldApply` +
      `applySolution` + `applyPrompt`) hands the synthesized result to the **main gated agent loop**
      (`runTurn` — full `write_file`/`edit_file`/`run_bash` + approval gate) so files are actually created —
      gated on a code block being present, skipped in Plan mode, opt out with `OB1_APPLY=0`. Council only
      applies on an **ACCEPT** verdict (a REVISE result is "not ready to ship" → not written); the solution
      is delimited as inert data in `applyPrompt` (prompt-injection defense-in-depth). **Verified LIVE**
      (Qwen via OpenRouter): `/route` produced a solution, the apply pass ran `mkdir`/`write_file` (with a
      diff)/`cat` and the file landed on disk. Guards: `multimind-smoke` asserts the full
      `start→text→step→tool→step→done` event stream (deltas + per-call tokens), apply gating
      (code/plan/opt-out), and that `applySolution` dispatches the gated turn carrying the solution;
      `council-smoke` Scenario H asserts `onEvent` reaches author + every critic + arbiter.
- [x] **Web tools — `web_search` + `web_fetch`** (user-requested). New `src/tools/web.ts` (pure, injectable
      `fetchFn`): `web_search` queries a **SearXNG JSON API** (`buildSearchUrl` → `&format=json`, supported
      params whitelisted; key sent as the `X-API-Key` header; `formatSearchResults` → ranked title/url/snippet)
      and `web_fetch` reads a page (`htmlToText` strips script/style/tags + decodes entities, truncates).
      Both are **read-only** (no approval gate → available to multi-mind workers). Backend is env-only —
      `OB1_SEARXNG_URL` / `OB1_SEARXNG_KEY` (gitignored `.env`, never persisted/committed); `web_search` is
      registered **only when configured**. Hardening (from an adversarial review): `htmlToText` decodes
      entities in a **single non-cascading pass** (double-escaped `&amp;lt;` stays the literal `&lt;`), and
      `web_fetch` has an **SSRF guard** (`isBlockedHost`) that refuses loopback/private/link-local + the
      `169.254.169.254` metadata IP by default — important since OB-1 runs on servers and the tool is
      read-only/no-approval/worker-exposed; override with `OB1_WEB_FETCH_ALLOW_PRIVATE=1` for a localhost
      dev server. **Verified**: `web-smoke` (deterministic, mock fetch — url/format, result render,
      html→text incl. the double-decode case, `X-API-Key` header, 401/HTTP/non-JSON/network errors, the
      SSRF guard, conditional registration); `web-live` (opt-in, real SearXNG — correct key → results,
      wrong/missing key → 401, query params) green against the live endpoint; and **end-to-end** the agent
      called `web_search` and returned a real result (Qwen via OpenRouter). CI: `web-smoke` in the hermetic
      job; a manual `web-live` job gated on `OB1_SEARXNG_URL`/`OB1_SEARXNG_KEY` secrets.
- [x] **Markdown tables → aligned box-drawn output** (user-requested). `mdToAnsi` is per-line, but a GFM
      table spans lines (header · `|---|` separator · rows) and can't be aligned one row at a time — so the
      TUI controller **buffers consecutive pipe lines** and renders the block once complete via `renderTable`
      (pure, exported): box-drawing borders (dim), **bold header**, per-column width, `:--`/`--:`/`:--:`
      alignment honored, inline Markdown inside cells, wide-cell truncation. Non-tables (no `|---|` on line 2)
      fall back to plain text. Verified: `tui-smoke` (`renderTable` shape/borders/alignment/null + the
      controller buffering a streamed table into a box, keeping surrounding prose, never committing raw pipe
      rows) and **live** through the real TUI (the model's markdown table rendered as a box).
- [x] **Reasoning channel + `Ctrl+O` toggle** (user-requested). Providers now capture the model's
      reasoning/thinking on a SEPARATE channel — `openai.ts` reads `delta.reasoning` / `reasoning_content`
      (via a pure `extractDelta`), `anthropic.ts` reads `thinking_delta` — threaded through
      `CallOpts.onReasoning` → `TurnDeps` → the TUI. **Ctrl+O** toggles `TuiController.showReasoning`: when
      on, reasoning streams to scrollback as dim `▏ …` lines (ephemeral — never stored in history) and the
      status bar shows `💭reasoning`; when off it's dropped (hint `⌃O reasoning` shown). ink-text-input only
      ignores Ctrl+C, so Ctrl+O would append an "o" to the input — stripped back off in the handler.
      Verified: `provider-smoke` (`extractDelta` text vs reasoning vs `reasoning_content`), `tui-smoke`
      (drop-when-off · dim lines · partial in live region · flush on answer start · status indicator),
      `tui-pty.py` (Ctrl+O flips the indicator and does NOT pollute the input), and **live** — Qwen via
      OpenRouter emitted 990 chars of reasoning on the channel, separate from the answer.
- [x] **Header dedup · tool-call label dedup · ESC-to-stop** (user-requested). (1) The startup header
      mentioned the model twice — removed it from the banner, keeping the single richer `model: … — desc`
      line. (2) Multi-mind tool-call lines repeated the worker name (`→ solo: web_search`) even though the
      `· solo…` header already names it — `workerProgress` now tracks the last-started worker and only
      re-labels a tool call when a DIFFERENT worker interleaves (parallel critics/candidates), so a single
      worker shows `→ web_search`. (3) **ESC stops a running turn**: an `AbortSignal` threads from the TUI
      (`TuiController.cancelTurn`) through `TurnDeps`/`CallOpts` → `streamSSE` (aborts the in-flight fetch,
      raises `AbortedError`) and every multi-mind `runWorker`; the loop/workers check it between steps and
      report `⊘ stopped` instead of an error; ESC also clears the prompt queue. The busy loader shows an
      `Esc to stop` hint. Guards: `provider-smoke` (aborted signal → `AbortError` before any fetch),
      `multimind-smoke` (`runWorker` with an aborted signal stops without calling the model), `tui-smoke`
      (`requestCancel` invokes the cancel handle · loader shows the hint).
**Roadmap complete (Phases 0–11).** All "missing entirely" spec features are now built. Opt-in modes run on
the one Phase 3 runtime, gated behind the compute-matched eval.

All former spec "partial" sub-items are now closed: MCP **http/SSE** transports (transport-abstracted
JsonRpcMcpClient + Streamable-HTTP/legacy-SSE clients, factory dispatch) · Linux **bubblewrap** sandbox
(bwrap backend, capability-probed, loud degradation) · Fusion **git-worktree** real-test scoring (per-
candidate worktree at HEAD, real tests under the sandbox, diff fed to the judge). Each is covered by a
deterministic smoke (`sandbox-smoke`, `mcp-http-smoke`, `fusion-worktree-smoke`) — 17/17 smokes green,
typecheck clean. Hardened against a 13-bug adversarial review (string JSON-RPC ids, SSE connect timeout/
leak, bwrap `--unshare-pid`, worktree path-traversal/symlink-escape, shared-`.git` writes, new-file diffs).

**Both verification gaps now closed with LIVE tests (2026-06-20):**
- `scripts/mcp-interop.ts` — drives all three transports (stdio, Streamable HTTP, legacy SSE) against the
  OFFICIAL `@modelcontextprotocol/server-everything` reference server (13 real tools, echo round-trips). ✓
- `scripts/bwrap-enforce.ts` — runs the REAL `wrapCommand()` under bubblewrap on actual Linux (via colima
  Docker) and proves enforcement: network denied + writes confined per mode; also confirmed the probe
  loudly degrades (`sandboxAvailable=false`) when a host blocks unprivileged user namespaces. ✓
These two are opt-in live tests (need npx+network / a Linux+bwrap host), not part of the deterministic glob.

**CI + the remaining verification gaps closed (2026-06-21):**
- `.github/workflows/ci.yml` — three jobs on push/PR: **(1)** `typecheck` + the deterministic suite
  (`scripts/ci-smokes.ts`, 18 smokes) + the **real-PTY TUI** test; **(2)** the two **live** tests —
  `mcp-interop` (npx reference server) and `bwrap-enforce` (apt bubblewrap; re-enables unprivileged user
  namespaces on Ubuntu 24.04 so the sandbox *really* enforces instead of self-skipping); **(3)** opt-in
  `github-mcp` (manual `workflow_dispatch`, gated on a `GH_MCP_TOKEN` secret, self-skips otherwise).
- **Authenticated MCP** verified two ways: `scripts/mcp-auth-smoke.ts` (deterministic — a bearer token +
  arbitrary custom headers are sent on **every** request, a missing token is **401**-rejected, and the
  `Mcp-Session-Id` is captured + replayed — on both Streamable HTTP and legacy SSE) **and**
  `scripts/mcp-github-live.ts` (LIVE — a real authenticated handshake with GitHub's remote MCP server at
  `api.githubcopilot.com/mcp/`: 27 tools listed, `get_me` round-trips). The authenticated-cloud-server gap
  is now closed against a real third-party endpoint, not just a local mock.

The full agent loop is verified live on Qwen via OpenRouter; the Anthropic path is code-complete but
unexercised (streaming + cache_control unit-tested, not live — deferred per user).

## Phase 12 — PLAN-V2 gap-closure · 🟡 in progress
Closing the 12 research-vs-codebase gaps from `PLAN-V2.md` (gitignored). Each item is web-researched
for best practices first, then built read-only/opt-in per the standing conventions. **Phase 1 (quick
wins / foundation):**
- [x] **#13 Persistent usage analytics (`/usage`)** — `src/usage/log.ts` appends one JSON line per
      model call to `<dataDir>/usage.jsonl` (the central `accrue()` chokepoint, so Solo + every
      multi-mind worker step is captured), then rolls it up by **day / model / mode**. Keeps the
      four token counters separate (input · output · cache-read · cache-write) and precomputes
      cache-aware cost (read 0.1× / write 1.25× of input, reusing the `models.ts` price table — no
      second copy of rates). `/usage` prints the report; added to HELP + the slash-menu. Research:
      ccusage field set / dedup / bucket model. Guard: `usage-smoke` (append/reload round-trip,
      corrupt-line tolerance, four-counter aggregation, cache-cost ratios, sum-reconciliation). 31 smokes.
- [x] **#1 Subagents saved report (SUBAGENTS-PLAN Phase B)** — after a `spawn_subagents` batch,
      `writeSubagentReport` saves `.ob1/subagents/<ts>.md`: parent task + run-metadata header (ok/failed
      counts, total tokens, failures called out up front), a one-row-per-subagent summary table whose
      tokens reconcile to the total, then one delimited section per subagent carrying the **exact
      dispatched sub-task + context + full findings** (the durable artifact the bounded tool_result loses)
      — failures kept visible, never dropped. Default ON (env opt-out `OB1_SUBAGENTS_REPORT=0`);
      best-effort so a write failure never breaks the turn; pointer logged to scrollback. Research:
      Claude Code summary-only return + Cline per-subagent cost rollup. Guard: `subagents-smoke`
      (formatter content + reconciling table + failure visibility + sanitized-ts file write + env toggle
      + **end-to-end** report saved through `runTurn`).
- [x] **#8 Memory graph export (`/memory export [dot|html]`)** — `src/memory/export.ts` writes the
      relationship graph to `.ob1/memory-graph.<ext>`: **DOT** (Graphviz, zero-dep, default — quoted/escaped
      ids, labeled edges) and a **fully self-contained HTML** (inline SVG, deterministic circular layout,
      no external `src=` — opens offline). Bi-temporal honesty: invalidated/expired edges render **dashed +
      dimmed**, never dropped (both formats), fed by `listRelationships(true)` + a new `store.listEntities()`.
      Research: DOT vs Cypher vs HTML (skip Cypher — needs a live DB); self-contained-HTML pattern. Guard:
      `memory-export-smoke` (DOT structure/escaping/dashed edges · self-contained HTML · determinism · real
      store path). **32 deterministic smokes, typecheck clean.**

**Phase 2 (memory quality — the largest verified gap):**
- [x] **#5 Weighted retrieval (recency + importance + relevance)** — retrieval ranked by cosine alone;
      now a **two-stage** retrieve: (1) prefilter top-N by cosine, (2) re-rank by the Generative-Agents
      weighted score in `src/memory/rank.ts` — `w_rel·rel + w_rec·recency + w_imp·importance`, each
      **min-max normalized across the candidate pool** (the paper's method; a flat map kills cosine
      discrimination), with a relative-epsilon collapse so ms-apart facts don't get their recency spread
      amplified. New `importance` column (1–10, default 5) + idempotent migration + `setImportance`;
      recency = 0.5^(age/7d). Relevance-led defaults `1/0.5/0.3` (override `OB1_MEM_WEIGHTS`); **`1,0,0`
      reduces exactly to cosine order** (back-compat, pinned). Research: Park et al. Generative Agents
      §4 (formula, weights, decay) + Mem0 production posture. Guard: `memory-rank-smoke` (recency decay ·
      min-max incl. near-constant collapse · recency/importance flips · back-compat · store re-rank);
      existing memory smokes regression-clean. **33 smokes.**
- [x] **#4 LLM-managed memory evolution (consolidate / dedup / contradiction)** — `remember()` no longer
      blindly appends: when ON it retrieves the 10 nearest same-scope facts and asks a cheap LLM
      (`src/memory/evolve.ts`) to pick ONE op — **ADD** (new) · **UPDATE** (merge in place, same id, revision
      recorded) · **DELETE** (supersede a contradicted fact — archived, recoverable) · **NOOP** (drop a
      duplicate) — and to score the fact's importance 1–10 (feeds #5). Two safeguards the published systems
      lack: an **UPDATE/DELETE/NOOP id outside the retrieved set is coerced to ADD** (no hallucinated ids),
      and **any parse failure / model error falls back to ADD** (never lose info; immutable revisions make
      even a wrong op recoverable). Opt-in (`cfg.memEvolve` default OFF, env `OB1_MEM_EVOLVE`, persisted,
      `/memory evolve on|off`, cheap model via `OB1_MEM_MODEL`) since it costs one LLM call per write
      ([[no-auto-escalation-to-expensive-modes]]); every op surfaces a visible `🧠` note
      ([[visible-progress-no-silent-work]]). Research: Mem0 (4 ops, s=10, ids-from-input-only) + Vertex
      Memory Bank. Guard: `memory-evolve-smoke` (parse/validate/safeguards + all four ops through a real
      store with injected LLM + revision preservation + fail-safe + live toggle). **34 smokes.**
- [x] **#6 Reflection / consolidation trees** — once accumulated fact importance crosses a threshold
      (150 on the 1–10 scale, per Park et al.), the agent distils its recent window into higher-level
      **reflection** facts (`src/memory/reflect.ts`), each linked to the sources it generalizes from via a
      `reflection_sources` table (the `derived_from` edges). New `kind` + `reflection_level` columns
      (+migration); a reflection sits one level above its sources and the **depth cap** (MAX 3) bounds
      reflection-of-reflection; the accumulator **resets before** distilling and reflections are created
      off the `remember` path, so they can't re-trigger themselves (loop guard). Ungrounded insights
      (citing no valid source id) are **dropped** (anti-hallucination). Opt-in (`cfg.memReflect` default OFF,
      `OB1_MEM_REFLECT`, persisted, `/memory reflect on|off`); best-effort. Research: Generative Agents
      §4.2 (threshold, citations, recursion). Guard: `memory-reflect-smoke` (threshold trip · grounded
      distillation through a real store · derived_from links · level math · depth cap · reset · OFF). **35 smokes.**
- [x] **#7 Agentic auto-linking (Zettelkasten)** — folded into the #4 evolution call (one LLM round-trip):
      the model also proposes up to **3** related-memory links from a **closed vocabulary**
      (`related_to` / `refines` / `contradicts`), applied as idempotent fact↔fact edges in a `fact_links`
      table (distinct from the named-entity graph — facts are id'd, not named). Validated against the
      retrieved ids (no hallucinated targets), **deduped, capped, and clamp-logged** (requested vs kept),
      no self-links — the gap between the 10-candidate window and the 3-link cap is what stops a
      fully-connected graph (A-Mem finding). Opt-in (`cfg.memAutolink` default OFF, `OB1_MEM_AUTOLINK`,
      `/memory autolink on|off`); rides evolution (warns if evolve is off). Research: A-Mem (retrieve→
      LLM-confirm, K-cap, closed relation set). Guard: `memory-evolve-smoke` extended (link parse/validate/
      dedup/cap + real-store edges + idempotency + no-self-link + visible note). **35 smokes; typecheck clean.**

> **Phase 2 complete.** The memory engine now forgets, merges, prioritizes, reflects, and links — not
> just accretes. All four levers are opt-in/default-OFF (each costs LLM calls) and individually toggled.

**Phase 3 (orchestration depth):**
- [x] **#11 Dual-ledger + re-plan / stall recovery** — the fixed-round modes had no error recovery; added
      the Magentic-One orchestration pattern as an optional controller (`src/multimind/ledger.ts`):
      a **Task Ledger** (facts/guesses/plan) + a **Progress Ledger** (satisfied/progress/inLoop/nextStep)
      assessed each round, a **stall counter** that resets on progress and trips a **bounded re-plan** at
      the threshold (3, matching AutoGen) capped at MAX_REPLANS, hard-stopped at 20 rounds — gives up
      gracefully (`stalledOut`) instead of looping. Adds a **deterministic loop backstop** (identical
      worker output two rounds running → forced `inLoop`, no LLM trust needed). Pure state machine +
      injected assess/replan seams (live model-backed defaults for production). Opt-in: `OB1_ORCH_LEDGER=1`
      routes `/fanout` through the act→assess→re-plan loop instead of single-shot. Research: Magentic-One
      (arxiv 2411.04468) + AutoGen defaults. Guard: `ledger-smoke` (parse · stall transition · replan
      trigger · satisfied-stop · stall-out-at-bound · loop backstop · clean pass-through). **36 smokes.**
- [x] **#2 Worktree write-capable subagents (SUBAGENTS-PLAN Phase C)** — the riskiest feature, built loud
      and refusing-by-default (`src/multimind/subagents-write.ts`). Opt-in `OB1_SUBAGENTS_WRITE` exposes a
      `spawn_write_subagents` tool: each agent declares an **explicit disjoint file lane** and edits in its
      **own git worktree** (reuses `worktree.ts`); the safety model is **(1)** a pre-spawn partition check
      (overlapping declared lanes → refuse before any work), **(2)** post-work **path-overlap detection**
      (an agent that wrote out of lane → conflict even if git could auto-merge — the "clean-but-wrong" case),
      **(3)** abort-on-ANY-conflict leaving the real tree **untouched**, and **(4)** a single **approval-gated**
      sequential merge. Worktrees always cleaned up (try/finally). Forced off on apply turns. Research: Cline
      agent-teams + the git merge-tree/path-set preflight pattern (path-set is primary — the dangerous case
      merges cleanly). Guard: `subagents-write-smoke` — **real temp git repo**: partition refusal · disjoint
      worktree merge · post-work overlap abort (tree untouched) · gated apply (+ denial) · non-git guard ·
      **runTurn e2e** (model → tool → gated apply lands files; inert when gated off). **37 smokes; typecheck clean.**

> **Phase 3 complete.** Orchestration gained bounded error-recovery (dual-ledger) and safe parallel
> writes (worktree-isolated, conflict-refusing, gated) — both opt-in/default-OFF.

**Phase 4 (edit/execution paradigms — ⚠️ benchmark-claim-only, gated on `/eval` before being trusted):**
- [x] **#9 Code-as-action (CodeAct)** — opt-in `/codeact <task>` runs the CodeAct paradigm: the model acts
      by emitting ONE fenced ```python/```bash block (`src/agent/codeact.ts`), which runs in the existing OS
      sandbox (network-off) **approval-gated**, and the `[observation exit_code=N]` (head/tail-clipped) feeds
      back; it loops until the model answers with **no code block** (= done). Refinements from research:
      **last-block-wins** (models narrate then act), exit-code observations, a **repetition/loop guard**
      (identical block re-emitted → steer once, then stop as `looping`), 15-step cap. Pure parse/build/format
      core + injected model/exec/approve seams. Honest ⚠️: an unproven paradigm shift for our setup — kept a
      separate opt-in path (JSON tools stay the default) to be measured on `/eval`. Research: CodeAct
      (arxiv 2402.01030) + OpenHands. Guard: `codeact-smoke` (parse · observation/clip · loop · gate · abort ·
      loop-guard · step cap). **38 smokes.**
- [x] **#10 Architect/Editor two-model edits** — opt-in `OB1_EDIT_ARCHITECT` adds an `architect_edit` tool:
      a strong **architect** model describes the change in **prose** (no diff syntax — frontier models reason
      well but mangle structured diffs) and a cheaper **editor** model emits machine-appliable
      `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks (with a whole-file fallback), applied through OB-1's
      existing flexible edit engine (`src/agent/architect.ts` is the pure prompts+parsing core; the tool
      applies — no import cycle). Pin the pair with `OB1_ARCHITECT_MODEL` / `OB1_EDITOR_MODEL`. Honest ⚠️:
      ~2× model calls, worth it only on complex edits — opt-in and to be measured on `/eval`. Research: Aider
      architect/editor (~85% edit-bench with a strong+cheap pair). Guard: `architect-smoke` (prose/mechanical
      prompts · search-replace + whole-file parse · injected pipeline · real-engine apply · throw-on-empty ·
      conditional registration). **39 smokes; typecheck clean.**

> **Phase 4 complete.** Both edit paradigms shipped behind their own flags as separate opt-in paths (the
> JSON-tool loop stays the default). Per the plan they remain **gated on `/eval`** — wired + unit-tested,
> NOT yet proven to beat the baseline at equal tokens; that's the next validation step, not a claim made here.

### Eval validation pass (2026-06-22) — the gate ran; verdict: default to Solo
Wired **CodeAct as an eval mode** (`runCodeActMode` in `src/eval/runners.ts`: develops+verifies via
sandboxed execution in a throwaway scratch dir, then a final extraction call yields the graded block;
selectable via `bun run scripts/eval.ts solo codeact`). Ran live on the baked `auto`/Qwen model:

| run | tasks | result |
|---|---|---|
| Solo vs **CodeAct** | 6 (2 simple + 4 hard) | both **100% pass**; CodeAct **2.4–5.5× tokens** → ✗ not justified |
| Solo vs **Fusion** vs **Council** | 3 (partial) | all **100% pass**; Fusion ~3.4–5× · Council ~3–3.7× tokens → ✗ not justified |

**Honest verdict:** on the current 16-task suite this model **aces every task as Solo (0 "hard" tasks)**,
so the suite is **saturated** and cannot discriminate any mode — CodeAct/Fusion/Council all match Solo's
correctness at 2.4–5.5× the cost and **none clears the compute-matched bar**. Per R5, **default to Solo**;
the ⚠️ Phase-4 paradigms (and the heavy modes) correctly **stay opt-in/flagged, credited to nobody on
faith** — which is exactly what the gate is for. **#10 Architect/Editor was NOT measured**: the suite is
write-from-scratch, but `architect_edit` is an *edit* tool needing a starting file — a fair eval needs
**edit/fix-shaped tasks** (buggy stub → repair), which the suite doesn't yet have.
**Next to make the eval meaningful: add genuinely hard tasks Solo fails + edit-shaped tasks.**
