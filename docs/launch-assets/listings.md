# Listings Checklist

Prepare these after the first release artifacts and docs are live.

## awesome-cli-coding-agents

Pitch:

```text
OB-1 is an Apache-2.0 terminal coding agent with an embedded free-models router (150+ free models
across 20+ providers, keyless out of the box), provider-neutral OpenAI-compatible routing, an
inspectable project memory graph, MCP, checkpoints, and multi-agent modes.
```

Required links:

- GitHub repo
- README demo GIF
- Install command
- License

## OpenRouter Works-With

Pitch:

```text
OB-1 can use OpenRouter through OPENROUTER_API_KEY or the OpenRouter provider preset in /models.
```

Validation:

```sh
OPENROUTER_API_KEY=... OB1_MODEL=qwen/qwen3.6-plus ob1
```

## MCP Directories

Pitch:

```text
OB-1 is an MCP client for stdio, Streamable HTTP, and legacy SSE servers. MCP tools still pass through
OB-1's approval, sandbox, and secret-redaction layers.
```

Validation:

```sh
bun run scripts/mcp-interop.ts
```

## Package Directories

- Homebrew tap: published with release.
- npm: `@overbrilliant/ob1`.
- AUR: publish `ob1-bin` first after replacing release hashes.
- winget/Scoop: blocked until Windows release artifacts exist.
