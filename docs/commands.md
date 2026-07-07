# Slash Commands

Common OB-1 commands:

| Command | Purpose |
|---|---|
| `/models` | Choose Free models (auto or a pinned model), a custom endpoint, a named provider, or hosted frontier models. |
| `/free` | Manage the free-models pool: keys file, routing strategy, provider health. |
| `/memory` | Inspect stored project memory. |
| `/memory add <text>` | Add a fact to memory. |
| `/memory search <query>` | Search project memory. |
| `/memory export [dot\|html]` | Export the relationship graph. |
| `/mode auto\|act\|plan` | Switch execution mode: no prompts, ask before edits, or read-only. |
| `/fusion` | Switch future turns to Fusion best-of-N; sticky until `/solo`. |
| `/solo` | Exit Fusion back to Solo. |
| `/subagents [on\|off]` | Parallel read-only subagents for a Solo turn. On by default. |
| `/escalation [on\|off]` | On verified failure, escalate the turn to Fusion best-of-N. On by default. |
| `/review` | Independent refute-reviewer over your current diff; reports only correctness bugs it cannot refute, then offers to fix them. |
| `/deep <task>` | Adaptive AB-MCTS search: Thompson-sampled generate-vs-refine across the model ensemble, graded by the real verifier. |
| `/eval [modes…]` | Compute-matched eval: does each mode beat Solo at equal tokens? |
| `/sandbox` | Switch shell sandbox mode. |
| `/permission` | Adjust ask/autopilot approval behavior directly. |
| `/mcp` | List connected MCP servers and tools. |
| `/agents regen` | Refresh the project memory index in `AGENTS.md`. |
| `/usage` | Show local token/cost estimates. |
| `/export` | Export the current session. |
| `/resume` | Resume a previous session. |

Commands are available from the slash menu as well as direct text entry.
