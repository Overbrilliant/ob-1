```text
   ██████╗ ██████╗      ██╗
  ██╔═══██╗██╔══██╗    ███║
  ██║   ██║██████╔╝═══ ╚██║
  ██║   ██║██╔══██╗     ██║
  ╚██████╔╝██████╔╝     ██║
   ╚═════╝ ╚═════╝      ╚═╝
```

[![CI](https://github.com/Overbrilliant/ob-1/actions/workflows/ci.yml/badge.svg)](https://github.com/Overbrilliant/ob-1/actions/workflows/ci.yml)
[![Fresh install matrix](https://github.com/Overbrilliant/ob-1/actions/workflows/fresh-install.yml/badge.svg)](https://github.com/Overbrilliant/ob-1/actions/workflows/fresh-install.yml)
[![npm](https://img.shields.io/npm/v/%40overbrilliant%2Fob1.svg)](https://www.npmjs.com/package/@overbrilliant/ob1)
[![Homebrew](https://img.shields.io/badge/Homebrew-overbrilliant%2Ftap-orange)](https://github.com/Overbrilliant/homebrew-tap)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Overbrilliant/ob-1)

![OB-1 start-free demo](docs/media/start-free.gif)

*Start free: `ob1` sets up FreeLLMAPI locally — no account or card. Anonymous bootstrap routes can start you; add your own free provider keys for reliable capacity.*

![OB-1 completing a task](docs/media/first-task.gif)

*A real session: OB-1 writes `primes.py`, runs it, and shows the output — on free models.*

![OB-1 memory inspector](docs/media/memory-graph.gif)

*`/memory` shows the facts and relationship graph OB-1 built from real work.*

OB-1 is a free, open-source CLI coding agent with persistent project memory. Run `ob1` in a
repository and it can read the codebase, build a repo map, edit files, run checks, inspect memory, and
coordinate deeper multi-agent passes when the task deserves more compute.

The default path is free out of the box: OB-1 sets up
[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), a local OpenAI-compatible gateway, and can
use anonymous bootstrap routes before you add keys. No API key, card, or account is required to start;
add your own free provider keys for predictable capacity.

## What You Get

- **Repository context before answers.** OB-1 ranks important files, tracks symbols, reads AGENTS.md,
  and keeps project notes it can reuse later.
- **A visible memory system.** You can inspect facts, revisions, relationships, search results, and
  the memory graph from the CLI.
- **Tool use with opt-in guardrails.** File edits, shell commands, MCP tools, browser checks, and
  verification helpers run through the agent loop. By default OB-1 runs in **autopilot** (it executes
  tools without prompting) with the **OS sandbox off** — fast, but it acts on its own. Turn on per-action
  approvals with `OB1_PERMISSION=ask`, and confine writes/network with `OB1_SANDBOX=workspace-write` or
  `read-only` (or set `permissionMode` / `sandbox` in `settings.json`). Even in autopilot, catastrophic
  commands (e.g. `rm -rf /`) are hard-blocked and destructive actions are flagged.
- **Free out of the box.** Start with FreeLLMAPI's anonymous bootstrap routes when public pools have
  capacity, then add free provider keys for better models and predictable monthly capacity.
- **Provider-neutral routing.** Use your own OpenAI-compatible endpoint, OpenRouter, OpenAI, Gemini,
  Groq, Ollama, LM Studio, llama.cpp, vLLM, or a LAN GPU box.
- **Release paths people can test.** Homebrew, npm, native archives, checksums, attestations, and
  fresh-machine install checks are part of the project.

## Install

### Homebrew

```sh
brew install overbrilliant/tap/ob1
```

### Native Installer

```sh
curl -fsSL https://github.com/Overbrilliant/ob-1/releases/latest/download/install.sh | sh
```

The installer picks the right macOS/Linux archive for arm64 or x64, verifies it with
`checksums.txt`, and installs `ob1` into a bin directory when it can.

Pin a release:

```sh
curl -fsSL https://github.com/Overbrilliant/ob-1/releases/latest/download/install.sh | sh -s -- --version v0.1.5
```

### npm

```sh
npm install -g @overbrilliant/ob1
```

The npm package needs Bun at runtime.

### Source Checkout

```sh
git clone https://github.com/Overbrilliant/ob-1.git
cd ob-1
./scripts/install.sh
```

Source installs create a small launcher that runs this checkout through Bun. Pull the repo to update
it. To build a standalone binary instead:

```sh
./scripts/install.sh --binary
```

## Quick Start

Run OB-1 from a Git repository:

```sh
ob1
```

On first run, choose a model route. Pressing Esc at the first picker starts the free path.

| Tier | What you do | Cost | Account? |
| --- | --- | --- | --- |
| **Free (default)** | `ob1` -> **Start free** | $0 | No |
| **Your endpoint** | Export `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, or set `OB1_BASE_URL` / `OB1_API_KEY`; or use `/models` | Your key or local model | No |
| **Hosted frontier** | `ob1 login` or choose **Hosted frontier** | Paid subscription | Yes |

Free setup downloads, runs, and wires [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) for
you. Anonymous providers are a bootstrap path with variable quality and shared limits. Add provider
keys in the local dashboard for stronger free-tier coverage; OB-1 keeps using the single local `/v1`
endpoint.

BYOK env routes are runtime-only and are never persisted. For Gemini:

```sh
GEMINI_API_KEY=... OB1_MODEL=gemini-2.5-pro ob1
```

Hosted frontier is the convenience tier: no provider keys, one bill, Claude/GPT/Gemini/Qwen-class
models through the managed OB-1 server.

If onboarding does not start, run:

```text
ob1 onboard
```

You can change the route later:

```text
/models       choose FreeLLMAPI or a subscription-backed model
/freellm      set up or manage the local FreeLLMAPI proxy
/upgrade      subscribe or manage your plan
```

Full launch docs are in [docs/](docs/): quickstart, install, FreeLLMAPI, providers, core concepts,
commands, troubleshooting, architecture, distribution, extensions, privacy, and eval notes.

Useful commands:

```text
/help           show interactive commands
/agents regen   refresh the project AGENTS.md index
/map            inspect the ranked repository map
/memory         inspect stored project memory
```

Without a model connection, setup, repository mapping, and memory inspection still work. Coding
tasks need a model.

Update checks are non-blocking and skip CI. Set `OB1_NO_UPDATE_CHECK=1` to disable the version nudge.

## Comparison

| Capability | OB-1 | Claude Code | opencode | aider |
| --- | --- | --- | --- | --- |
| License | Apache-2.0 | Proprietary | Open source | Open source |
| Works with no API key | Yes, via FreeLLMAPI | No | No | No |
| Local/LAN models | Yes | Limited | Yes | Yes |
| Persistent visible memory | SQLite + graph inspector | No | No | No |
| Multi-agent modes | Fusion, Council, Personas | No | No | No |
| Sandbox/permissions | macOS Seatbelt, Linux bubblewrap, approvals | Yes | Varies | Limited |
| Hosted convenience tier | Optional paid | Required account | Bring your own | Bring your own |

## How It Works

| Area | What happens |
| --- | --- |
| Agent loop | OB-1 plans, calls tools, reads results, and continues until the task is done or blocked. |
| Repository map | It ranks files by references and symbols so the agent starts with likely-relevant context. |
| Memory | It stores facts, revisions, relationships, embeddings, and graph edges in SQLite. |
| AGENTS.md | `/agents regen` refreshes the project memory index while keeping human-owned notes intact. |
| Tools | It can read files, edit files, run shell commands, inspect the repo map, search memory, use MCP tools, and run checks. |
| MCP | It connects to stdio, HTTP, and SSE MCP servers and exposes their tools inside the agent. |
| Skills | Markdown skills stay discoverable without loading the full instructions into every prompt. |
| Safety | Approval gates, shell validation, macOS Seatbelt, Linux bubblewrap, and secret checks reduce accidental damage. |

## Agent Modes

Start with `solo`. Switch modes only when the task benefits from extra work.

| Mode | Use it for |
| --- | --- |
| `solo` | Normal coding tasks. Fastest and cheapest path. |
| `fusion` | Several candidate solutions, checked and merged into one result. |
| `council` | Author and reviewer rounds before the final answer. |
| `personas` | A small expert panel for product, design, architecture, or strategy tradeoffs. |

```text
/mode solo
/mode fusion
/mode council
/mode personas
/autoroute on    let Solo route hard turns to a heavier mode
```

## Commands

### Shell

```text
ob1                 start the interactive CLI in the current directory
ob1 onboard         run guided setup
ob1 login           sign in to the managed OB-1 server
ob1 signup          create an account on the managed OB-1 server
ob1 logout          remove the local token
ob1 --help          show help
ob1 --version       print the version
```

### Inside OB-1

```text
/help                 show help
/plan | /act          switch between planning and execution
/permission ask|autopilot  toggle per-action approvals
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

## Releases and Verification

OB-1 publishes through:

- GitHub releases with native macOS arm64/x64 and Linux arm64/x64 archives
- Homebrew: `overbrilliant/tap/ob1`
- npm: `@overbrilliant/ob1`

Release archives include `checksums.txt`. GitHub artifact attestations are generated for release
assets.

Verify an artifact:

```sh
gh release download v0.1.5 --repo Overbrilliant/ob-1 --pattern ob1-darwin-arm64.tar.gz
gh attestation verify ob1-darwin-arm64.tar.gz --repo Overbrilliant/ob-1
```

Release signing, notarization, provenance, and install testing are documented in
[`docs/distribution.md`](docs/distribution.md).

## Development

You need Bun `>=1.3.13`, Git, and macOS or Linux.

```sh
bun install
bun run start
```

Checks worth running before a PR:

```sh
bun run scripts/cli-flags-smoke.ts
bun run scripts/ci-smokes.ts
bun run typecheck
bun run lint
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
  providers/           OpenAI-compatible model gateway
  safety/              shell policy, validation, and OS sandbox integration
  skills/              on-demand markdown skill registry
scripts/               smoke tests, install/build helpers, live probes
docs/                  distribution notes, roadmap, research, and planning material
```

## Status

OB-1 is early public software. The CLI, install paths, memory engine, repo map, provider setup, MCP
support, multi-agent modes, and smoke-test harness are active. Interfaces may change before `1.0`.

Roadmap and design notes:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/package-managers.md`](docs/package-managers.md)
- [`docs/extensions.md`](docs/extensions.md)
- [`docs/privacy.md`](docs/privacy.md)
- [`docs/sharing.md`](docs/sharing.md)
- [`docs/evals.md`](docs/evals.md)
- [`docs/planning/PROGRESS.md`](docs/planning/PROGRESS.md)
- [`docs/planning/ob1-plan.html`](docs/planning/ob1-plan.html)
- [`docs/research/`](docs/research/)

## Security

OB-1 can read project files, run shell commands, and interact with provider credentials. Do not put
secrets in public issues, screenshots, prompts, or logs.

Report suspected vulnerabilities privately. See [`SECURITY.md`](SECURITY.md).

## Contributing

Focused, tested PRs are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and follow
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Community entry points are in [`COMMUNITY.md`](COMMUNITY.md).

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
