---
name: code-review
description: Review the current git diff for correctness bugs and simplification/efficiency cleanups
---

# Code Review

Review the **current changes** (not the whole codebase) at the requested effort level.

## Steps
1. Run `git diff` (or `git diff --staged`) via `run_bash` to see what changed.
2. For each changed hunk, look for, in priority order:
   - **Correctness bugs** — logic errors, off-by-one, wrong conditions, unhandled errors,
     race conditions, resource leaks, incorrect types.
   - **Reuse & simplification** — duplicated logic, code that an existing helper already does,
     unnecessary complexity.
   - **Efficiency** — needless work in hot paths, repeated I/O, O(n²) where O(n) is easy.
3. Only report findings you are confident are real. Prefer fewer, high-signal findings over
   a long speculative list.
4. For each finding give: `file:line`, a one-line description, and a concrete fix.

## Output
A short bulleted list grouped by file. If the diff is clean, say so plainly — do not invent
problems. Persist any durable architectural insight with `memory_add`.
