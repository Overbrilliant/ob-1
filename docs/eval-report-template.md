# Public Eval Report Template

Use this template for the first published compute-matched eval. Keep failures in the report.

## Run Metadata

| Field | Value |
|---|---|
| OB-1 version | `v0.1.5` |
| Git SHA | `TODO` |
| Date | `TODO` |
| Machine | `TODO` |
| Model route | `TODO` |
| Model id | `TODO` |
| Modes | `solo`, `fusion`, `escalate`, `deep` |
| Trials | `TODO` |
| Task set | Built-in `eval/tasks/*.json` plus any listed additions |

## Commands

```sh
bun install --frozen-lockfile
bun run typecheck
OB1_BASE_URL=... OB1_API_KEY=... OB1_MODEL=... OB1_EVAL_TRIALS=3 \
  bun run scripts/eval.ts solo fusion escalate deep 2>&1 | tee eval-report.txt
```

Or use the manual GitHub Actions workflow:

```sh
gh workflow run eval.yml --repo Overbrilliant/ob-1 \
  -f modes="solo fusion escalate deep" \
  -f trials=3
```

## Results

Paste the two report blocks from `scripts/eval.ts`:

```text
Capability eval...

Compute-matched eval...
```

## Interpretation

- Lead with whether any mode solved hard tasks that Solo did not solve.
- Then state whether that mode beat Solo at equal tokens.
- Call out flakes, skipped checks, and model refusals.
- Do not claim a mode is better if it only wins by spending more tokens.

## Artifact Checklist

- Raw `eval-report.txt`
- `metadata.md` from the workflow artifact
- Task JSON
- OB-1 release tag and Git SHA
- Provider/model route
- Known failures and rerun policy
