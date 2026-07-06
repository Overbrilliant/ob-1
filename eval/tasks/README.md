# Eval tasks

Small, SWE-bench-shaped coding problems used by the OB-1 eval harness (`src/eval/`). Each is a
self-contained TypeScript function/class graded by an OBJECTIVE check — no model-as-judge — which
is what lets the harness keep every mode honest (does a multi-mind mode beat compute-matched Solo?).

## Shape

Each file is one JSON object or an array of `{ id, lang: "ts", prompt, check }` (see
`src/eval/tasks.ts`, `EvalTask`). `loadTasks(cwd)` reads every `*.json` here (this README is ignored).

- `prompt` — a precise spec given verbatim to each mode; it ends with the "single fenced TypeScript
  code block, named export" contract. It must NOT leak the check's specific test vectors.
- `check` — a shell command run as `bash -lc <check>` with env `OB1_FILE` pointing at the
  candidate's extracted code (a `.ts` file). Exit 0 = PASS, any nonzero = FAIL. Written as
  `bun -e '...'` that imports `process.env.OB1_FILE` and asserts edge cases (use double quotes
  inside — the single quotes wrap the `bun -e` body; escaping goes through JSON then bash).

Every mode may CONSULT this per-task `check` while solving (e.g. `fusion` grounds its best-of-N
selection in it, `escalate` uses it to decide whether to escalate) — but the harness always re-grades
each mode's returned artifact with the same `check` independently afterward, so a mode reading its own
check can never grade itself green.

## Authorship rule (non-negotiable)

Before a task ships, prove BOTH: (1) a correct reference solution makes the check exit 0, and
(2) a plausible-but-wrong solution (an off-by-one / missed edge case a lazy impl would produce —
not a syntax error) makes it exit nonzero. Put edge cases in the check, not just the happy path,
and keep every behavior in the prompt decidable by the check. No two tasks may be near-duplicates.

`easy.json` / `medium.json` / `hard.json` here were authored this way (24 tasks; ref-PASS +
wrong-FAIL verified for each).
