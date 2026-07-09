# Core Concepts

OB-1 is a local CLI agent. It keeps project state on your machine, speaks to model providers through
OpenAI-compatible endpoints, and uses optional guardrails around tools.

## Sessions

A session starts when you run `ob1` in a project directory. OB-1 builds a repository map, loads local
project instructions, resolves the active model route, and opens an interactive terminal UI.

Use `/resume` to continue a previous session and `/export` to save the current transcript.

## Execution Modes

Use `/mode` to choose how much autonomy OB-1 has:

| Mode | Behavior |
|---|---|
| `auto` | No questions asked: mutating tools run automatically. |
| `act` | Edits and commands are allowed, but OB-1 asks before mutating tools. |
| `plan` | Read-only investigation; writes and mutating shell commands are blocked. |

## Agent Modes

The default is Solo: one model, one pass, with an automatic self-fix loop that reruns the project's
checks after a file-changing turn and corrects failures until they pass or a small round budget is
spent. OB-1 spends more compute only when it earns its tokens against plain Solo:

- On a *verified* failure (checks still failing after self-fix), the turn escalates once to Fusion
  best-of-N — the objective signal decides this, not a router model.
- `/fusion` runs best-of-N deliberately, scoring candidates against the project's real checks and
  selecting a winner rather than merging.
- `/review` runs an independent refute-reviewer over your diff; `/deep` runs an adaptive search.
- The model can fan out read-only subagents for independent sub-tasks, but a single writer makes all
  edits through the gated apply path.

Any mode that cannot beat Solo at equal tokens on the eval suite is deleted. See
[Multi-Agent Modes](multimind.md).

## Model Routes

OB-1 has three routes:

| Route | Use it when | Account required |
|---|---|---|
| Free models | You want the free default: an embedded router pooling free tiers across 20+ cloud providers, keyless out of the box, with your own provider keys optional for more capacity. | No |
| Your endpoint | You already have OpenRouter, OpenAI, Gemini, Groq, Ollama, LM Studio, llama.cpp, vLLM, or another OpenAI-compatible URL. | No |
| Hosted frontier | You want managed frontier models, web search, usage export, and one bill. | Yes |

Switch routes with `/models`. Runtime env keys such as `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, and
`OB1_BASE_URL` override saved settings for that process only.

## Permissions

`OB1_PERMISSION` controls whether OB-1 asks before tool use:

| Mode | Behavior |
|---|---|
| `autopilot` | Runs approved tool classes without prompting. This is the default for speed. |
| `ask` | Prompts before actions that can mutate files, run commands, or use sensitive tools. |

Inside the CLI, use `/mode auto` for no prompts, `/mode act` to ask before edits, or `/permission` for the lower-level approval setting.

## Sandbox

`OB1_SANDBOX` controls OS-level confinement for shell commands:

| Mode | Behavior |
|---|---|
| `off` | Commands run directly. |
| `workspace-write` | Commands are confined to the project workspace where supported. |
| `read-only` | Commands can inspect but should not write. |

macOS uses Seatbelt. Linux uses bubblewrap when the host supports unprivileged user namespaces.

## Checkpoints and Rewind

Checkpoints are enabled by default. Before each prompt, OB-1 snapshots the worktree into a shadow Git
store that is separate from your real `.git` directory.

Use `/rewind` when a turn needs to be rolled back. Disable checkpoints for a process with:

```sh
OB1_CHECKPOINT=off ob1
```

## Memory

OB-1 stores durable project memory in local files and SQLite. Memory is inspectable through `/memory`,
portable with the project, and separate from provider accounts.

See [Memory](memory.md) for the graph inspector and export flow.
