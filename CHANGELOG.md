# Changelog

All notable OB-1 CLI changes are documented here.

## 0.1.4 - Unreleased

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
