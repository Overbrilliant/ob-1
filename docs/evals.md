# Evals

The eval harness answers one question honestly: does a multi-agent mode beat plain Solo *at equal
tokens*? It is the gate behind [the deletion policy](multimind.md#the-deletion-policy). The harness
lives under `src/eval/`; run it with `scripts/eval.ts`.

Current local deterministic check:

```sh
bun run scripts/eval-smoke.ts
```

## Task suite

The suite is 42 tasks: 2 built-in (`src/eval/tasks.ts`) plus 40 loaded from `eval/tasks/*.json`. Each
task is a self-contained TypeScript function or class graded by an OBJECTIVE check command — `bash -lc`
with `OB1_FILE` pointing at the candidate's extracted code, exit 0 = PASS. There is no model-as-judge;
deterministic grading is what keeps every mode honest.

Authorship rule (non-negotiable): before a task ships, prove **both** that a correct reference solution
makes the check exit 0, and that a plausible-but-wrong solution (an off-by-one or missed edge case, not
a syntax error) makes it exit nonzero. Edge cases go in the check, not just the happy path, and no two
tasks may be near-duplicates. See [`eval/tasks/README.md`](../eval/tasks/README.md) to add a task.

## Modes

The two interactive modes are `solo` and `fusion`. The harness can additionally measure `escalate`
(the verified-escalation policy: one Solo pass, then Fusion only when the check fails), `deep`
(AB-MCTS-lite, budget compute-matched to Fusion), and `codeact`. Solo is always included as the
baseline, since compute-matching is measured against it.

A `ModeRunner` has the signature `(prompt, task?) => Promise<RunOutput>`. The optional second argument
lets a mode consult the per-task objective check while solving — Fusion grounds its best-of-N selection
in it, and `escalate` uses it to decide whether to escalate. This is symmetric across modes, and it
cannot let a mode grade itself green: the harness always re-grades every returned artifact with the
same check independently afterward.

## Compute-matched framing

`computeMatched()` compares each mode's pass rate against **Solo@k**, where k = (mode's average tokens)
/ (Solo's average tokens) — how many independent Solo attempts the mode's budget would have bought,
scored with the standard `1 - (1 - p_solo)^k` estimator. A mode is only justified if it beats that
compute-matched baseline. A separate capability view asks the complementary question — does the mode
*solve* hard tasks Solo fails, ignoring token cost — but the compute-matched frame is the one that gates
whether a mode stays.

## Publishing a report

1. Pin the OB-1 version, model ids, provider route, and machine.
2. Run the fixed task set with Solo and the compute-matched modes.
3. Publish raw task JSON, command lines, model ids, pass/fail output, and cost estimates.
4. Include failures and flake handling. The thesis is measured tradeoff, not a perfect leaderboard.

A manual GitHub Actions workflow exists at `.github/workflows/eval.yml`. It self-skips unless either
`OB1_EVAL_BASE_URL` or `OB1_EVAL_TOKEN` is configured.

```sh
gh workflow run eval.yml --repo Overbrilliant/ob-1 \
  -f modes="solo fusion escalate deep" \
  -f trials=3
```

Use the [public eval report template](eval-report-template.md) for the launch write-up.
