# Configuration Reference

OB-1 reads explicit runtime endpoint overrides first, then saved settings in `~/.ob1/settings.json`,
then hosted auth, then named provider env keys, then built-in defaults. Runtime secrets are not written
back to disk.

## Model Route

| Setting | Purpose |
|---|---|
| `OB1_BASE_URL` | OpenAI-compatible `/v1` endpoint. Wins over saved provider settings. |
| `OB1_API_KEY` | Bearer key for `OB1_BASE_URL`; optional for local endpoints with no auth. |
| `OB1_MODEL` | Model id for this process. |
| `OPENROUTER_API_KEY` | Route through OpenRouter when no saved provider or hosted subscription is configured. |
| `OPENAI_API_KEY` | Route through OpenAI's OpenAI-compatible API when no saved provider or hosted subscription is configured. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Route through Gemini's OpenAI-compatible API when no saved provider or hosted subscription is configured. |
| `GROQ_API_KEY` | Route through Groq when no saved provider or hosted subscription is configured. |
| `OB1_TOKEN` | Hosted OB-1 CLI token; overrides `~/.ob1/auth.json`. |
| `OB1_SERVER` | Hosted OB-1 server origin. Defaults to production. |

## Agent Behavior

| Setting | Values | Purpose |
|---|---|---|
| `OB1_PERMISSION` | `autopilot`, `ask` | Tool approval mode. |
| `OB1_SANDBOX` | `off`, `workspace-write`, `read-only` | OS sandbox mode. |
| `OB1_EFFORT` | `low`, `medium`, `high` | Reasoning effort hint. |
| `OB1_SUBAGENTS` | `on`, `off` | Read-only subagent planning/reporting. On by default. |
| `OB1_ESCALATION` | `on`, `off` | On verified failure (checks still failing after Solo's self-fix rounds), escalate the turn to Fusion best-of-N. On by default. |
| `OB1_REPO_MAP` | `on`, `off` | Automatic repository map context. |
| `OB1_CHECKPOINT` | `on`, `off` | Shadow-git checkpoints and `/rewind`. |
| `OB1_QUALITY` | `off`, `normal`, `strict` | Task-quality reminders and verification pressure. |

## Multi-Agent Modes

These refine the multi-agent paths; none is required for a good result. Fusion and Deep auto-detect
the strongest objective signal for the project (a test suite, else fast compile gates, else syntax)
with no configuration — these variables only override that default, never gate quality. See
[Multi-Agent Modes](multimind.md).

| Setting | Values | Purpose |
|---|---|---|
| `OB1_SUBAGENTS_WRITE` | `1` | Enable parallel *write*-subagents (disjoint file lanes, gated merge). High-risk; off by default. |
| `OB1_SUBAGENTS_REPORT` | `0`, `off` | Disable the saved `.ob1/subagents/*.md` report. On by default. |
| `OB1_FUSION_MODELS` | comma list | Explicit ensemble, used verbatim (otherwise the diversity gate chooses). |
| `OB1_FUSION_N` | integer | Candidate count (default 3). |
| `OB1_FUSION_CHECK` | command | Objective check command; `$OB1_FILE` is the candidate's code. |
| `OB1_FUSION_TEST_CMD` | command | Force a test-tier signal with this command. |
| `OB1_FUSION_TARGET` | path | Default file path to apply/score a candidate against. |
| `OB1_FUSION_WORKTREE` | `1` | Score each candidate in a git worktree at HEAD by running real tests. |
| `OB1_FUSION_MOA` | `1` | Add one Mixture-of-Agents refine layer (candidates see peers). |
| `OB1_FUSION_JUDGE_MODEL` | model id | Model for the selector/synthesizer. |
| `OB1_DEEP_BUDGET` | integer | `/deep` worker-call budget (default 9). |
| `OB1_DEEP_EVAL_BUDGET` | integer | `deep`'s budget under `/eval` (default 4, compute-matched to Fusion). |

## Memory and Tools

| Setting | Purpose |
|---|---|
| `OB1_MEM_EVOLVE` | Let OB-1 update project memory after substantive turns. |
| `OB1_MEM_REFLECT` | Let OB-1 write reflection notes. |
| `OB1_MEM_AUTOLINK` | Let OB-1 infer memory graph links. |
| `OB1_SKILL_LEARN` | Let OB-1 write learned markdown skills. |
| `OB1_SEARXNG_URL` / `OB1_SEARXNG_KEY` | Direct web-search endpoint. |
| `OB1_WEB_FETCH_ALLOW_PRIVATE` | Allow `web_fetch` to private/internal hosts. Default is blocked. |
| `OB1_FORCE_VISION` | Force screenshot/image payloads for a custom vision-capable endpoint. |

Saved settings are intentionally plain JSON. Delete `~/.ob1/settings.json` to reset provider choice and
behavior toggles; delete `~/.ob1/auth.json` to remove the hosted CLI token.
