# Contributing to OB-1

OB-1 is the product and `ob1` is the command. Overbrilliant is the company. Keep PRs focused, tested,
and easy to review.

## Setup

```bash
bun install
bun run start
```

Useful checks:

```bash
bun run typecheck
bun run scripts/ci-smokes.ts
bun run lint
```

For focused changes, run the narrow smoke first. Examples:

```bash
bun run scripts/onboarding-smoke.ts
bun run scripts/freellm-smoke.ts
bun run scripts/provider-smoke.ts
bun run scripts/tui-smoke.tsx
```

## Architecture Map

See `docs/ARCHITECTURE.md` for the detailed contributor map. The short version:

- `src/index.ts` owns the CLI entrypoint, boot sequence, slash-command routing, and live mode changes.
- `src/cli/` owns onboarding, login, FreeLLMAPI management, and the Ink TUI.
- `src/agent/` owns the tool loop, file/shell/browser tools, verification, checkpoints, sessions, and recovery.
- `src/providers/` is the OpenAI-compatible model gateway and provider profile metadata.
- `src/memory/` owns the SQLite memory store, graph export, embeddings, ranking, reflection, and evolution.
- `src/multimind/` owns Fusion, Council, Personas, and adaptive routing.
- `src/mcp/` owns stdio/http/sse MCP clients and deferred tool loading.
- `scripts/` contains deterministic smokes; add to `scripts/ci-smokes.ts` when a new smoke is stable.

## Provider Changes

Provider profiles are metadata over the existing OpenAI-compatible wire. Prefer adding a profile in
`src/providers/profiles.ts` over adding a new provider implementation. Runtime env keys must not be
persisted to `~/.ob1/settings.json`.

## UI and Interactive Changes

Interactive changes need a deterministic smoke when possible. For visual/browser behavior, use
`browser_check`; Playwright is optional and loaded lazily, so tests should skip cleanly when Chromium is
not installed.

## Pull Requests

Include:

- What changed and why.
- How it was tested.
- Any migration notes or compatibility risks.
- Screenshots/GIFs for visible TUI or README changes.

Avoid:

- Committing secrets, `.env` files, `.ob1/`, local databases, logs, generated binaries, or
  `node_modules/`.
- Broad formatting-only changes in behavior PRs.
- Rewriting large monoliths without first adding narrow tests around the behavior being moved.

## Good First Issues

Good first issues should be small, reproducible, and have one clear validation command. Good examples:

- Add a provider preset to `src/providers/profiles.ts` plus a smoke assertion.
- Improve a recovery hint in `src/agent/recovery.ts`.
- Add a docs page under `docs/`.
- Add a small slash-command smoke for an existing command.

The launch seed backlog is in `docs/good-first-issues.md`.

## Security

Do not report security issues in public PRs or issues. Follow `SECURITY.md`.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0.
