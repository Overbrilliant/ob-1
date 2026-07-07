# Multi-Agent Modes

OB-1 spends more compute only when a task earns it, and only in ways that measurably beat spending
the same tokens on plain Solo. This document describes what the `src/multimind/` mechanisms do, what
they cost, and why the earlier heavy modes were deleted.

## Philosophy

Four rules shape every mechanism here.

- **Single writer, real verification.** One agent edits the tree; extra agents investigate or propose,
  but the workspace only changes through the main gated apply loop. Correctness is decided by running
  the project's own checks, not by an agent's self-assessment.
- **Fan out only with an objective signal.** Best-of-N is worth its tokens only when a real selector
  (test execution, then a check command, then syntax) can tell the candidates apart. Without a signal,
  extra candidates are extra cost with no way to pick the winner.
- **Selection over summarisation.** When several candidates pass, OB-1 *selects* one verbatim rather
  than merging them. Merging a weak member into a strong one measurably degrades the result; a merge is
  the fallback used only when nothing passed.
- **Escalate only on verified failure.** A turn escalates to more compute when the objective check has
  actually failed, not when a model guesses the task is hard. The signal decides, never a router LLM.

## Mechanisms

### Solo and the self-fix loop

Solo is the default: one model, one pass. After the model reports it is done, if the turn changed
files OB-1 runs the project's fast checks and, on failure, feeds the errors back and lets the model
fix them — looping until the checks pass or the round budget (three rounds) is spent. This
execution-feedback loop is the proven core; the heavier modes build on it rather than replace it. It
runs in `src/agent/loop.ts` and needs no configuration.

### Subagents (read-only decomposition)

When a Solo turn hits a big task that splits into independent parts (investigate N areas, audit N
modules, research N options), the model can call `spawn_subagents` to run each part as an isolated,
read-only worker in parallel. Each worker returns a distilled findings summary; Solo synthesises them
and makes any edits itself through the normal gated write path. This is decomposition parallelism —
different sub-tasks — distinct from Fusion's best-of-N, which runs the *same* task N ways.

The design is deliberately constrained: read-only workers only (a single writer avoids conflicting
edits), summary-only return (the lead never inherits a worker's raw transcript), no nesting (subagents
get neither `spawn_subagents` nor escalation), and shallow caps (up to 8 sub-tasks, concurrency 6). A
full reviewable report is saved to `.ob1/subagents/<timestamp>.md`. On by default; toggle with
`/subagents` or `OB1_SUBAGENTS=on|off`.

### Write-subagents (opt-in)

`spawn_write_subagents` lets parallel workers make *edits* in isolated git worktrees, each assigned a
disjoint file lane; the merge back into the tree is approval-gated, and any file overlap aborts the
whole batch. This is high-risk (parallel edits need explicit file ownership) and off by default —
enable it with `OB1_SUBAGENTS_WRITE=1`. Prefer editing yourself for small or interdependent changes.

### Fusion (best-of-N with a real selector)

`/fusion` (sticky) or a verified escalation runs Fusion. It fans the task out to N candidates
(default 3, raised to the ensemble size when more models are supplied) that all get the *same* prompt;
the only intended variance is sampling and, on the free router, one frontier model per worker. Each
candidate works with the full toolset in its own writable copy of the project (a git worktree at HEAD,
or a temp-dir copy), so it can edit, run, and test its way to a working answer before committing to a
final fenced code block.

Fusion then **scores** each candidate against the strongest objective signal available, and **selects**
rather than merges:

1. **Score.** The grading tier, strongest first: *copy checks* (the candidate's real final state,
   including multi-file edits, graded in its own copy) → *worktree tests* → a *check command*
   (`$OB1_FILE`) → *syntax*. The tier used is printed so you know how much to trust the PASS/FAIL.
2. **Select (when ≥1 candidate passes).** A similarity vote first — the largest group of near-identical
   solutions wins; a tie breaks to the smallest diff (least change); a remaining tie is broken by a
   judge that only *rates* the tied candidates 0–5 and picks, never authoring new code. The winner is
   returned verbatim.
3. **Merge (fallback, 0 candidates pass).** Only here does a judge synthesise a merge from the
   candidates and their failure output; the merge is re-scored, and a revert-to-best guard falls back
   to the strongest candidate if the merge regressed. If the final artifact still fails, the result is
   flagged FAILING out loud — never a silent pass.

The **ensemble** is chosen by a diversity gate: an explicit `OB1_FUSION_MODELS` list is used verbatim;
on the free router, up to three distinct healthy Frontier-tier models are used (ranked by reliability
and health), falling back to the single active model when fewer than two are available; any other
provider samples the one active model N times. Medium/Small models are never mixed in — a weak member
poisons selection. Sampling one strong model N times is a correct design, not a fallback.

### Verified escalation

When Solo's self-fix loop still fails the objective check after its budget, and escalation is enabled,
the turn hands itself to Fusion best-of-N once, passing the failure report as context so candidates
*fix* the failure rather than restart. The objective signal triggers this — no LLM router, no regex.
At most one escalation happens per user turn: escalation is forced off on the apply turn inside Fusion
and in Plan mode, and pressing Esc after Solo skips it. On by default; toggle with `/escalation` or
`OB1_ESCALATION=on|off`.

After an *escalated* Fusion apply writes something, OB-1 runs the reviewer once on the resulting diff
automatically and feeds any surviving findings through a single gated fix turn (it never loops).

### /review (the refute-reviewer)

`/review` runs one independent, read-only reviewer over your current diff. It is an adversarial
*refuter*, not a suggestion machine: for each candidate bug it first reads the surrounding code to try
to disprove it, and reports only findings that survive, each backed by a concrete failure scenario
(inputs/state → wrong behaviour) and a `file:line` citation. If nothing survives, it says NONE; it
never emits style or naming nits, and it caps its findings. A different ensemble model reviews when one
is available (decorrelated errors), otherwise the same model reads the diff cold (fresh-context
errors). The diff is your staged and unstaged changes, or the last commit when the tree is clean. On a
TTY, OB-1 then offers an approval-gated fix turn; findings that are false positives must be named as
such rather than silently dropped.

### /deep (adaptive search)

`/deep <task>` runs a small AB-MCTS-lite search — a port of Sakana's Adaptive Branching MCTS. Each step
uses Thompson sampling over a set of arms to decide, grounded in the real verifier signal, whether to
**widen** (generate a fresh candidate) or **deepen** (refine a promising existing node). Each arm has a
Beta posterior over its observed rewards; deepening a strong-but-imperfect node is attractive before it
has children, while a weak node is not — the "deepen the promising frontier" behaviour. The reward is
the real fractional pass ratio, never a model's self-assessment. The search stops early the moment a
node fully passes, applies the best node through the gated apply loop, and prints the whole tree (node,
parent, model, score) so the wider-vs-deeper decisions are visible. Budget defaults to 9 worker calls
(`OB1_DEEP_BUDGET`).

## Costs

Every heavy path declares its budget up front, prints the signal tier it graded on, and reports
PASS/FAIL truthfully (a still-failing result is announced loudly). Multipliers are approximate — the
real cost depends on the task.

| Path | Rough cost |
|---|---|
| Solo | 1× (plus self-fix rounds only when checks fail) |
| Subagents | 1× lead + one read-only worker per sub-task (parallel) |
| Fusion | ~N× a Solo pass for N candidates, +1 only when a judge is needed (default ~3×) |
| Verified escalation | Solo's cost, plus one Fusion run only when the check actually failed |
| /review | ~1× a Solo investigation (one read-only worker) |
| /deep | ~budget× a Solo pass (default ~9×) |

Apply is single-artifact: the final answer is one fenced code block handed to the gated apply loop. A
candidate's multi-file changeset is visible in its diff and informs selection, but what gets applied is
the code block. In Plan mode nothing is written (`/act` to let a result write files), and the reviewer
and deep search never write the tree directly — all writes go through the gated apply loop.

## The deletion policy

Any mode that cannot beat **compute-matched Solo@k** on the eval suite is deleted. Solo@k is how many
independent Solo attempts a mode's token budget would have bought; a mode is justified only if it beats
that baseline at equal tokens (see [Evals](evals.md)). On that test, Council, Personas, the `fanout`
orchestrator, the adaptive router, and the orchestration ledger were removed in 2026-07. Personas in
particular measured **100% → 40% accuracy at 29× tokens** on this repo's own eval — a heterogeneous
panel let a weak member poison the mix. What survived is what measured a real gain: the execution-
feedback loop, best-of-N with a real selector, tree search guided by execution signal, and an
independent refute-reviewer.

## Research grounding

The design follows the coding-agent literature. Snell et al. (2024) show that test-time compute is best
spent compute-optimally — sampling one strong model many times can beat a larger model. Sakana's
AB-MCTS (arXiv:2503.04412) shows an adaptive widen-vs-deepen search, guided by execution signal, beats
both pure best-of-N and pure iterative refinement. CodeMonkeys finds that *selection* quality is the
dominant gap in best-of-N — picking the right candidate is worth far more than generating more of them.
Self-MoA shows that mixing a weak member into a committee degrades the result versus sampling the best
single model. The MAST failure taxonomy catalogues how multi-agent systems fail, most of it avoidable
by keeping a single writer and grounding decisions in an objective signal rather than agent debate.
