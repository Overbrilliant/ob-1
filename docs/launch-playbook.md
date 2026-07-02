# Launch Playbook

This is the working launch checklist for OB-1. Do not run the external launch until the P0 install,
free-first, docs, pricing, and clean-machine checks are green.

## Pre-Launch

- Finish a fresh release with human-readable `CHANGELOG.md` notes.
- Verify a clean macOS install and a clean Linux install can reach a first model response with
  **Start free** and no user key. The `fresh-install.yml` Linux first-token job should be green before
  launch.
- Re-render `docs/media/start-free.gif` and `docs/media/memory-graph.gif` from `demos/`.
- Seed 10 to 15 genuine good-first-issue tickets.
- Make the docs route, pricing page, comparison pages, and GitHub links live.
- Confirm the free-tier capacity ledger and provider terms before publishing the "~1.7B tokens/month"
  headline outside the repo.

## Show HN

Link the GitHub repo, not the marketing site.

Title:

```text
Show HN: OB-1 - free open-source coding agent with persistent memory
```

Founder first comment:

```text
Agents arrived metered and forgetful. OB-1 is our attempt at the opposite shape: an Apache-2.0 CLI that
starts free through a local FreeLLMAPI gateway, remembers project facts in an inspectable memory graph,
and routes harder tasks through deeper multi-agent modes only when the work needs it.

The hosted service is optional and paid. The CLI works with FreeLLMAPI, OpenRouter, Ollama, LM Studio,
llama.cpp, vLLM, Groq, Gemini, and any OpenAI-compatible endpoint.
```

Reply quickly for the first three hours. Prioritize technical questions and bug reports over praise.

Prepared copy lives in [launch-assets/hn.md](launch-assets/hn.md).

## FAQ Answers

**How is this different from opencode or aider?**

OB-1 starts with a no-key free path, has durable inspectable memory, and includes multimind modes. It
still supports the same provider-neutral BYOK/local-model route those tools rely on.

**What is the business model?**

The CLI is Apache-2.0 and works without the hosted backend. Hosted frontier models are the paid
convenience tier: one account, one balance, managed keys, usage dashboards, and search.

**Can the free tier be taken away?**

The free path runs locally on the user's machine through FreeLLMAPI and the user's provider accounts.
Overbrilliant can stop running a hosted service, but the CLI and local routes keep working.

**Is pooling free tiers allowed?**

The defensible design is local and user-owned: each user runs their own proxy and uses their own provider
accounts. Provider-specific terms still need launch-week review and should be documented honestly.

## r/LocalLLaMA

Use technical posts, not launch copy:

- "A local OpenAI-compatible endpoint for stacking free model providers"
- "A coding agent with an inspectable memory graph and local model routes"
- "Running OB-1 against Ollama, LM Studio, llama.cpp, or a LAN vLLM box"

Draft outlines live in [launch-assets/local-llama.md](launch-assets/local-llama.md).

## Listings

- awesome CLI coding agents
- OpenRouter works-with directory
- MCP client directories
- free-LLM and self-hosted lists for FreeLLMAPI
- package directories for Homebrew, npm, Nix, and later AUR

Submission notes live in [launch-assets/listings.md](launch-assets/listings.md).

## Sustained Cadence

Ship readable releases every 1 to 2 weeks after launch. Each release note should say what changed, what
was tested, and which parts OB-1 helped build.
