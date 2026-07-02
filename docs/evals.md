# Evals

The launch eval target is a reproducible Terminal-Bench style report for OB-1 across Solo, Fusion, and
Council with two or three model routes. The existing harness is under `src/eval/` and `scripts/eval.ts`.

Current local deterministic check:

```sh
bun run scripts/eval-smoke.ts
```

Suggested publication flow:

1. Pin the OB-1 version, model ids, provider routes, and machine.
2. Run a fixed task set with Solo and compute-matched multi-agent modes.
3. Publish raw task JSON, command lines, model ids, pass/fail output, and cost estimates.
4. Include failures and flake handling. The thesis is measured tradeoff, not a perfect leaderboard.

Open follow-up: add a CI/manual workflow that runs the public eval suite when provider secrets are set.
That workflow now exists as `.github/workflows/eval.yml`. It self-skips unless either
`OB1_EVAL_BASE_URL` or `OB1_EVAL_TOKEN` is configured.

Manual run:

```sh
gh workflow run eval.yml --repo Overbrilliant/ob-1 \
  -f modes="solo fusion council personas" \
  -f trials=3
```

Use [Public eval report template](eval-report-template.md) for the launch write-up.
