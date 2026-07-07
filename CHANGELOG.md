# Changelog

All notable OB-1 CLI changes are documented here.

## [0.3.3] - 2026-07-07

- Changed `/mode` to the user-facing execution picker: `auto`, `act`, and `plan`.
- Added Auto mode as the no-questions-asked path: mutating tools run without prompts.
- Kept Plan and Act as compatibility shortcuts, but removed them from the primary slash menu.
- Moved forced best-of-N orchestration to `/fusion`; `/solo` exits it.

## [0.3.2] - 2026-07-07

- Fixed installed `/login` being hijacked by a stale `OB1_SERVER=http://localhost:8787` shell export.
  Localhost server overrides now require `OB1_ALLOW_LOCAL_SERVER=1`; remote self-hosted `OB1_SERVER`
  overrides still work normally.

## [0.3.1] - 2026-07-07

- Added in-session `/login` and `/logout` browser auth commands.
- Added `/subscribe` as a visible alias for opening the signed-in subscription page.
- Changed `/plan` into a Plan/Act toggle; `/plan on`, `/plan off`, and `/act` remain explicit paths.

## [0.3.0] - 2026-07-07

Verified multi-agent rework. OB-1 now spends extra compute only when it can prove the extra compute was
needed, and it grounds every multi-agent decision in your project's own checks instead of a model's
self-opinion.

- Fusion v2 is selection-first best-of-N: it generates N candidate attempts and picks the winner by an
  objective verifier signal auto-detected from your project (build, typecheck, tests, linters — whatever
  the repo actually has), with zero configuration. When no signal exists it falls back to synthesis rather
  than guessing.
- Verified escalation is ON by default: a turn runs a single agent first, and only escalates to best-of-N
  after automated checks prove that single-agent attempt failed. Easy work stays 1× — the extra agents are
  spent when, and only when, a check says the first attempt did not pass.
- Added `/review`: an independent reviewer that reviews the working diff and tries to REFUTE each of its own
  findings before reporting them, so you get the surviving issues instead of a wall of speculation. It also
  runs automatically after an escalated apply.
- Added `/deep`: adaptive generate-vs-refine search for hard problems, using AB-MCTS-style Thompson sampling
  to decide at each step whether to widen (try a new approach) or deepen (refine an existing one), with
  verified early-stop.
- Removed the modes our own compute-matched evaluations showed did not beat a single agent given the same
  budget: personas, council, fanout, ledger, and the adaptive router. `/review` and `/deep` remain because
  they earned their place.
- Added a 42-task evaluation suite (every check proven to actually discriminate) and adopted the policy that
  a mode which cannot beat compute-matched Solo gets deleted.
- Added the first unit-test suite: 83 tests across the multi-agent core (fusion, reviewer, deep, evaluate)
  and the agent loop.
- Fusion now handles honest prose answers (a candidate that correctly says "nothing to change" is no longer
  penalized against candidates that edited files).
- Free-models router now fails a fusion candidate over to the next provider on a 429 instead of aborting the
  candidate.
- Fixed keyless custom endpoints: an env/custom OpenAI-compatible endpoint with no API key is now treated as
  reachable instead of being skipped.

## [0.2.0] - 2026-07-06

- Free models: replaced the external FreeLLMAPI service with an embedded free-models router that runs
  in-process inside the CLI — no second process, no local server, no git clone, no Docker/Node
  dependency, and no dashboard to run or sign into.
- Free models: added one editable keys file at `~/.ob1/keys.env` (owner-only, auto-generated template).
  Adding or removing a provider key activates or deactivates it on your next message, no restart.
- Free models: keyless providers (Kilo, Pollinations, OVH, LLM7) work with zero setup, so OB-1 answers
  the first message with no keys and no account.
- Added `/free` (status, keys, strategy, health) to manage the free-models pool, and a "Free models ▸"
  entry under `/models` to pick `auto` or pin a specific model.
- Added routing strategies for the free-models router: `priority`, `balanced` (default), `smartest`,
  `fastest`, `reliable` — with automatic failover, rate-limit window tracking, escalating cooldowns after
  429s, and a reliability score.
- Migration: existing "freellmapi" setups are automatically migrated to the embedded "free" router
  (model `auto`) on next launch. No action needed. The external FreeLLMAPI service is no longer needed.
- Removed `/freellm`.

## 0.1.5 - 2026-07-05

- Safety: the trust gate is now ON BY DEFAULT — a first run in a new/untrusted folder starts in `ask`
  (prompt before each edit/command) instead of autopilot. An explicit choice (`OB1_PERMISSION` or a saved
  preference) and trusted folders are unaffected; `/trust` enables autopilot for the current folder.
- Safety: friendly crash handling — an unhandled rejection/exception now renders a readable message and
  reaps child processes instead of dumping a raw stack trace.
- Onboarding: the free path no longer dead-ends when Docker/Node are missing (it falls through to endpoint
  and hosted options), and Esc at the first picker starts the free path (matching the README).
- npm: added a `files` allowlist and a `bin/ob1.mjs` Node shim so `npm i -g @overbrilliant/ob1` works
  without a global Bun (the shim locates Bun or prints an actionable install message).
- Attribution: browser-opened auth/checkout URLs now carry a `source=cli*` tag so signups and checkouts can
  be attributed to the CLI.
- Process hygiene: foreground shell commands spawn detached and group-kill their children on cancel.

## 0.1.4 - 2026-07-02

- Made the first-run contract explicit: FreeLLMAPI is the default free path, BYOK/env endpoints are
  first-class, and hosted frontier models are the optional paid convenience tier.
- Added runtime env routing for `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `GROQ_API_KEY`, and `OB1_BASE_URL` / `OB1_API_KEY`.
- Added named OpenAI-compatible provider presets for OpenRouter, Ollama, LM Studio, llama.cpp, vLLM,
  Groq, and Custom endpoint.
- Kept FreeLLMAPI references on the existing public repository while making it the default free path.
- Added update-check plumbing, Biome config, demo assets, contributor templates, and architecture docs.

OB-1-written share: record this per release once the release branch is cut. Suggested command:

```sh
git diff --shortstat "$(git describe --tags --abbrev=0)..HEAD"
```
