# Changelog

All notable OB-1 CLI changes are documented here.

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
