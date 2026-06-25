# OB-1

[![CI](https://github.com/Overbrilliant/ob-1/actions/workflows/ci.yml/badge.svg)](https://github.com/Overbrilliant/ob-1/actions/workflows/ci.yml)
[![Fresh install matrix](https://github.com/Overbrilliant/ob-1/actions/workflows/fresh-install.yml/badge.svg)](https://github.com/Overbrilliant/ob-1/actions/workflows/fresh-install.yml)
[![npm](https://img.shields.io/npm/v/%40overbrilliant%2Fob1.svg)](https://www.npmjs.com/package/@overbrilliant/ob1)
[![Homebrew](https://img.shields.io/badge/Homebrew-overbrilliant%2Ftap-orange)](https://github.com/Overbrilliant/homebrew-tap)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**OB-1 is a local-first CLI coding agent for developers.** It understands your repository, keeps
visible project memory, runs gated tools, and can escalate from a normal solo coding agent into
multi-agent review, synthesis, and evaluation workflows when the extra compute is justified.

OB-1 is an Overbrilliant product by Neu Software LLC.

## Why OB-1

- **Local project context:** repository maps, file graph signals, AGENTS.md indexing, and persistent
  memory help the agent start each task with the right project knowledge.
- **Controlled execution:** tool calls are explicit, shell access is gated, destructive actions are
  treated separately, and sandbox modes are available for safer iteration.
- **Quality-focused agent modes:** Solo stays the default; Fusion, Council, Personas, and Adaptive
  modes are designed for harder tasks where review or parallel exploration can improve outcomes.
- **Visible memory:** facts, revisions, relationships, semantic search, and graph inspection are
  available from the CLI instead of hidden inside a black box.
- **Professional distribution:** Homebrew, npm, release binaries, checksum verification, release
  attestations, and fresh-machine install tests are part of the public release path.

## Install

### Homebrew

```sh
brew install overbrilliant/tap/ob-1
```

### Native installer

```sh
curl -fsSL https://github.com/Overbrilliant/ob-1/releases/latest/download/install.sh | sh
```

The installer detects macOS/Linux and arm64/x64, downloads the matching release archive, verifies it
against `checksums.txt`, and installs `ob1` into a directory on your `PATH` when possible.

Pin a version:

```sh
curl -fsSL https://github.com/Overbrilliant/ob-1/releases/latest/download/install.sh | sh -s -- --version v0.1.1
```

### npm

```sh
npm install -g @overbrilliant/ob1
```

The npm package requires Bun at runtime.

### Source checkout

```sh
git clone https://github.com/Overbrilliant/ob-1.git
cd ob-1
./scripts/install.sh
```

Source installs create a small launcher that runs the checked-out repository through Bun, so updates
from `git pull` are picked up immediately. To compile a standalone binary from source instead:

```sh
./scripts/install.sh --binary
```

## Quick Start

```sh
ob1
```

Inside OB-1:

```text
/help           show interactive commands
/models         configure or switch providers
/agents regen   regenerate the project AGENTS.md index
/map            inspect the ranked repository map
/memory         inspect stored project memory
```

OB-1 works best from the root of a Git repository. Without a model key, local commands, memory
inspection, repository mapping, and setup flows still work. To enable model-backed coding:

```sh
export OPENROUTER_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

For any OpenAI-compatible provider:

```sh
export OPENAI_API_KEY=...
export OB1_BASE_URL=https://your-provider.example/v1
export OB1_MODEL=your-model-id
```

You can also run `/models` and configure a provider interactively. OB-1 can connect to
[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), an OpenAI-compatible proxy for routing
across multiple free-tier model providers.

## Core Capabilities

| Area | What OB-1 provides |
| --- | --- |
| Agent loop | ReAct-style coding loop with Plan/Act phases, approvals, tool execution, and context compaction. |
| Repository context | Ranked repository map with symbols, references, centrality signals, and `/map` inspection. |
| Project memory | SQLite-backed facts, revisions, relationships, semantic search, and visible `/memory` commands. |
| AGENTS.md | Project memory index generation through `/agents` and `/agents regen`. |
| Tools | File reads/writes, edits, shell execution, repo map lookup, memory tools, browser checks, MCP tools, and verification helpers. |
| MCP | Stdio/http/sse MCP client support with configured tools exposed inside the agent. |
| Skills | On-demand markdown skills that keep base context small and load detailed instructions only when needed. |
| Multi-mind modes | Fanout, Fusion, Council, Personas, and Adaptive routing for tasks that benefit from extra reasoning. |
| Evaluation | Compute-matched eval harness that compares heavier modes against Solo at equal token budget. |
| Safety | Approval gates, shell validation, macOS Seatbelt and Linux bubblewrap sandbox support, and secret-handling checks. |

## Agent Modes

| Mode | Use it when |
| --- | --- |
| `solo` | You want the fastest normal coding-agent path. |
| `fusion` | You want multiple candidate solutions scored by objective checks before synthesis. |
| `council` | You want author/reviewer revision rounds before a final answer. |
| `personas` | You want a task-specific expert panel to debate tradeoffs before synthesis. |
| `adaptive` | You want Solo first, then escalation only if the configured check fails. |

Switch modes inside OB-1:

```text
/mode solo
/mode fusion
/mode council
/mode personas
/mode adaptive
```

## Common Commands

### CLI

```text
ob1                 start the interactive CLI in the current directory
ob1 onboard         run guided setup
ob1 login           sign in to the managed OB-1 server
ob1 signup          create an account on the managed OB-1 server
ob1 logout          remove the local token
ob1 --help          show help
ob1 --version       print the version
```

### Interactive

```text
/help                 show help
/plan | /act          switch between planning and execution phases
/auto on|off          toggle auto-approval
/sandbox <mode>       switch shell sandbox mode
/memory               inspect memory
/memory add <text>    remember a fact
/memory search <q>    search memory
/map                  show the ranked repository map
/mcp                  list connected MCP servers and tools
/skills               list available skills
/eval [modes…]        run compute-matched evals
/clear                reset conversation context
/exit                 quit
```

## Distribution and Verification

OB-1 publishes through three channels:

- **GitHub releases:** native archives for macOS arm64/x64 and Linux arm64/x64.
- **Homebrew:** `overbrilliant/tap/ob-1`.
- **npm:** `@overbrilliant/ob1`.

Release archives are accompanied by `checksums.txt`. The release workflow also generates GitHub
artifact attestations for release assets.

Verify a downloaded artifact:

```sh
gh release download v0.1.1 --repo Overbrilliant/ob-1 --pattern ob1-darwin-arm64.tar.gz
gh attestation verify ob1-darwin-arm64.tar.gz --repo Overbrilliant/ob-1
```

Distribution, signing, notarization, provenance, and fresh-install testing are documented in
[`docs/distribution.md`](docs/distribution.md).

## Development

Requirements:

- Bun `>=1.3.13`
- Git
- macOS or Linux for the primary CLI paths

Set up the repository:

```sh
bun install
bun run start
```

Useful checks:

```sh
bun run scripts/cli-flags-smoke.ts
bun run scripts/ci-smokes.ts
bun run typecheck
```

Build a standalone binary:

```sh
bun run build:bin
```

## Repository Layout

```text
src/
  index.ts             CLI entrypoint and slash-command routing
  agent/               agent loop, tools, execution, recovery, verification, safety hooks
  cli/                 terminal UI, onboarding, login, and model setup
  context/             repository map, AGENTS.md, git state, LSP, topics
  eval/                task harness, runners, parity checks, reports
  mcp/                 MCP clients and server manager
  memory/              fact store, embeddings, ranking, reflection, export
  multimind/           Fusion, Council, Personas, Adaptive routing, worker orchestration
  providers/           Anthropic and OpenAI-compatible provider gateway
  safety/              shell policy, validation, and OS sandbox integration
  skills/              on-demand markdown skill registry
scripts/               smoke tests, install/build helpers, live probes
docs/                  distribution notes, roadmap, research, and planning material
```

## Project Status

OB-1 is in early public development. The CLI, installer paths, memory engine, repository map,
provider setup, MCP support, multi-mind modes, and smoke-test harness are active. Interfaces may
change before a stable `1.0` release.

Roadmap and implementation notes:

- [`docs/planning/PROGRESS.md`](docs/planning/PROGRESS.md)
- [`docs/planning/ob1-plan.html`](docs/planning/ob1-plan.html)
- [`docs/research/`](docs/research/)

## Security

OB-1 is a local developer tool that can read project files, run shell commands, and interact with
provider credentials. Do not paste secrets into public issues, screenshots, prompts, or logs.

Please report suspected vulnerabilities privately. See [`SECURITY.md`](SECURITY.md).

## Contributing

Contributions are welcome when they are focused, tested, and aligned with the project direction.
Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
