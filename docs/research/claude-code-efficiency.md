# Making Claude Code More Efficient: Tools & Techniques

> Research compiled 2026-06-18. Topic: GitHub repos, open-source tools, and techniques
> that reduce Claude Code token usage / cost while improving or maintaining output quality.
>
> **Method:** Deep-research workflow — 25 sources fetched, 124 claims extracted,
> 25 adversarially verified (23 confirmed, 2 refuted via 3-vote panel).

---

## TL;DR

The biggest, most reliable wins come from **Anthropic's own built-in features and
configuration discipline** — not from third-party "token optimizer" repos. Several
popular GitHub projects advertise dramatic savings (60–90%), but those specific numbers
**failed verification** and trace only to the projects' own marketing. Their *mechanisms*
are real; their *headline numbers* are not.

---

## 1. Native levers (official, high-confidence — start here)

Documented by Anthropic; little or no setup required.

| Technique | What it does | Why it matters |
|---|---|---|
| **Prompt caching (default-on)** | Reuses the unchanged request prefix instead of reprocessing full history | Cache-read tokens bill at **~10% (0.1×) of the input rate**. Leave it enabled (`DISABLE_PROMPT_CACHING` exists but don't). |
| **Auto-compaction** | Summarizes conversation history when nearing the context limit | Automatic; keeps long sessions from blowing up |
| **Model selection** | Sonnet for most coding, Opus only for hard architectural/multi-step reasoning, **`model: haiku` for simple subagents** | Sonnet ~40% cheaper than Opus with near-equal coding benchmark scores (79.6 vs 80.8 SWE-bench) |
| **Preserve cache hits** | Pick model + effort **at the start** of a session; avoid mid-session model switches | Switching models (incl. `opusplan` toggling plan/execute) **invalidates the entire cache** and forces a full reprocess. Each model has its own cache. |
| **`/clear` between tasks** | Resets the context window between unrelated work | Avoids the "kitchen sink session" where stale context degrades quality |

**Cache economics detail:** Cache *writes* carry a premium (1.25× for 5-min TTL, 2× for
1-hour TTL), so caching pays off after one read (5-min) or two reads (1-hour). A high
read-to-creation ratio means caching is working.

---

## 2. Configuration discipline (high-confidence)

- **Keep `CLAUDE.md` under ~200 lines** — essentials only, prune ruthlessly. Bloated files
  cause Claude to *ignore* your actual instructions (official guidance + Chroma "context
  rot" research both confirm).
- **Move specialized instructions into Skills** — Skills load on-demand only when invoked,
  keeping base context small.
- **Prefer CLI tools (`gh`, `aws`, `gcloud`, `sentry-cli`) over MCP servers** where possible —
  they add no per-tool listing to context. Note: MCP tool definitions are now *deferred by
  default* (only tool names enter context until a tool is used via Tool Search), so this gap
  is smaller than it used to be. Exceptions: Tool Search disabled on Vertex AI / non-first-party
  proxies, unsupported on Haiku.

---

## 3. Workflow patterns (real, but with a crucial caveat)

- **Subagents** run research/investigation in separate context windows and report back only
  summaries — keeping your *main* conversation clean.
- **Dynamic workflows** (Claude Code v2.1.154+) run orchestration in an isolated runtime so
  intermediate results stay in script variables, not your context.
- **Adversarial review patterns** (independent agents cross-checking each other's findings)
  produce more trustworthy results than a single pass.

> ⚠️ **Critical distinction the marketing glosses over:** these patterns reduce your
> **main-context load** but generally **increase *total* token consumption** — Anthropic
> cites roughly **4–7× for multi-agent and ~15× for Agent Teams**. They buy *quality and
> context headroom*, not necessarily lower total cost. Choose them when context capacity or
> quality is the constraint, not when raw token spend is.

---

## 4. Measurement / observability

- **`ccusage`** (`github.com/ryoppippi/ccusage`, MIT, by ryoppippi) — the dominant tool.
  Run `npx ccusage@latest` (no install); reads local JSONL files in `~/.claude/projects/`
  and reports **daily / monthly / session / 5-hour-block** token-and-cost breakdowns,
  tracking cache-creation and cache-read tokens separately. Estimates USD via the LiteLLM
  pricing database. Actively maintained. (Minor known issue #899: ~19% cache-write
  underreporting — may be fixed.)
- **Others:** `Maciek-roboblog/Claude-Code-Usage-Monitor`, `phuryn/claude-usage`, plus
  Claude Code's own `/usage` and `/cost` commands.

---

## 5. Spec-driven / workflow repos — verified vs. refuted

| Repo | Verified | NOT verified |
|---|---|---|
| **Pimzino/claude-code-spec-workflow** (npm `@pimzino/claude-code-spec-workflow`) | Real Requirements→Design→Tasks→Implementation phases; session caching with file-change detection; passes only relevant context to sub-agents | ❌ "60–80% token reduction" — **refuted (0-3) as unverified marketing** |
| **marcusgoll/Spec-Flow** (~89★, MIT, v11.9.1 Apr 2026) | "Ultra-lightweight Orchestrator Pattern," worker isolation (zero shared context), "Domain Memory v2" full phase isolation, auto-compaction | Token savings are *design rationale*, not independently measured. Low popularity. |
| **ooples/token-optimizer-mcp** | A real 7-phase hooks system exists (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, etc.) | ❌ "60–90% context reduction across 38,000+ operations" — **refuted (0-3)** |

**Bottom line:** treat any vendor percentage from these tools as unproven.

Other ecosystem lists surfaced (curated, secondary): `VoltAgent/awesome-claude-code-subagents`,
`rohitg00/awesome-claude-code-toolkit`.

---

## Practical recommendation (do these in order — all native, all free)

1. **Default to Sonnet**, escalate to Opus only deliberately; set `model: haiku` for trivial subagents.
2. **Lock model/effort at session start**, `/clear` between unrelated tasks — protects your cache.
3. **Trim `CLAUDE.md` to <200 lines**, push specifics into Skills.
4. **Install `ccusage`** to actually *see* where tokens go before optimizing.
5. **Use subagents/workflows for hard or context-heavy work** — knowing they trade total
   tokens for quality and context headroom.

---

## Caveats & open questions

- **Refuted figures (do not repeat):** token-optimizer-mcp's "60–90% / 38,000+ operations"
  and claude-code-spec-workflow's "60–80% token reduction."
- **Time-sensitive:** pricing (cache-read 0.1×, Opus $5/MTok input), Spec-Flow ~89★ / v11.9.1,
  ccusage v20.0.14 — all live as of June 2026. Dynamic workflows require v2.1.154+.
- **Popularity data thin:** only Spec-Flow's star count (~89) was confirmed; ccusage and
  token-optimizer-mcp star counts weren't captured. 89★ does not make Spec-Flow "popular."
- **Unanswered:** independent third-party benchmarks of these workflow tools' real token
  reduction; the measured break-even point where main-context savings justify the 4–7×/15×
  aggregate token increase.

---

## Sources

**Primary (official Anthropic):**
- https://code.claude.com/docs/en/prompt-caching
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/best-practices
- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/mcp
- https://platform.claude.com/docs/en/about-claude/pricing
- https://docs.claude.com/en/docs/claude-code/sub-agents
- https://www.anthropic.com/engineering/claude-code-best-practices
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk

**Tools / repos:**
- https://github.com/ryoppippi/ccusage  •  https://ccusage.com/
- https://github.com/Pimzino/claude-code-spec-workflow
- https://github.com/marcusgoll/Spec-Flow
- https://github.com/ooples/token-optimizer-mcp
- https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
- https://github.com/phuryn/claude-usage
- https://github.com/VoltAgent/awesome-claude-code-subagents
- https://github.com/rohitg00/awesome-claude-code-toolkit
