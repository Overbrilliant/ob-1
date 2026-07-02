# Core Concepts

OB-1 is a local CLI agent. It keeps project state on your machine, speaks to model providers through
OpenAI-compatible endpoints, and uses optional guardrails around tools.

## Sessions

A session starts when you run `ob1` in a project directory. OB-1 builds a repository map, loads local
project instructions, resolves the active model route, and opens an interactive terminal UI.

Use `/resume` to continue a previous session and `/export` to save the current transcript.

## Model Routes

OB-1 has three routes:

| Route | Use it when | Account required |
|---|---|---|
| FreeLLMAPI | You want the free default with anonymous models first and your own provider keys later. | No |
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

Inside the CLI, use `/permission` or `/auto` to adjust behavior.

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
