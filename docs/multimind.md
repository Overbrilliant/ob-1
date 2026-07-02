# Multi-Agent Modes

OB-1 can spend more compute when a task justifies it. The default path stays simple, and the heavier
modes are explicit or adaptively triggered.

## Modes

| Mode | Use it for |
|---|---|
| Solo | Normal implementation, review, and debugging. |
| Fusion | Several candidate solutions, then a judge chooses or merges the best result. |
| Council | Review/revise loops for high-risk design or correctness work. |
| Personas | Different expert viewpoints over the same task. |
| Subagents | Read-only decomposition and parallel context gathering. |

## Controls

```text
/mode
/agents
OB1_AUTO_ROUTE=on
OB1_SUBAGENTS=on
```

Fusion and Council can be grounded with objective checks through environment variables such as
`OB1_FUSION_CHECK`, `OB1_COUNCIL_CHECK`, and `OB1_ROUTE_CHECK`. Without a check, OB-1 still uses syntax
and tool results, but a real command is better for meaningful pass/fail decisions.

Parallel write subagents are intentionally opt-in with `OB1_SUBAGENTS_WRITE=1` because parallel edits
need explicit file ownership and merge gating.
