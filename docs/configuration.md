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
| `OB1_AUTO_ROUTE` | `on`, `off` | Adaptive solo-to-multi-agent routing. |
| `OB1_SUBAGENTS` | `on`, `off` | Read-only subagent planning/reporting. |
| `OB1_REPO_MAP` | `on`, `off` | Automatic repository map context. |
| `OB1_CHECKPOINT` | `on`, `off` | Shadow-git checkpoints and `/rewind`. |
| `OB1_QUALITY` | `off`, `normal`, `strict` | Task-quality reminders and verification pressure. |

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
