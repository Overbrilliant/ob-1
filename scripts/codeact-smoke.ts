// Deterministic test for code-as-action mode (PLAN-V2 #9). No API key — model + exec injected.
// Covers parsing (last-block-wins, python/bash, none=final-answer), command build (python heredoc),
// observation formatting (exit_code + head/tail clip), and the runCodeAct loop: execute→observe→repeat
// until a no-code answer, the approval gate, abort, the step cap, and the repetition/loop guard.
// Usage: bun run scripts/codeact-smoke.ts
import { parseCodeAction, buildCommand, formatObservation, clip, runCodeAct, CODEACT_SYSTEM, MAX_CODEACT_STEPS } from "../src/agent/codeact.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

// ── parsing ──
check("parses a python block", parseCodeAction("here:\n```python\nprint(1)\n```")?.lang === "python");
check("parses a bash/sh block as bash", parseCodeAction("```sh\nls\n```")?.lang === "bash");
check("LAST block wins (narration then real action)", parseCodeAction("illustrative:\n```python\nx=1\n```\nnow really:\n```python\nprint(99)\n```")?.code === "print(99)");
check("no fenced block ⇒ null (final answer)", parseCodeAction("The answer is 42.") === null);
check("empty block ⇒ null", parseCodeAction("```python\n\n```") === null);

// ── command build + observation ──
check("python builds a heredoc", buildCommand({ lang: "python", code: "print(1)" }).startsWith("python3 - <<'"));
check("bash passes the code through", buildCommand({ lang: "bash", code: "echo hi" }) === "echo hi");
check("observation carries the exit code", formatObservation(0, "hello").includes("exit_code=0") && formatObservation(1, "boom").includes("exit_code=1"));
check("observation handles empty output", formatObservation(0, "  ").includes("(no output)"));
check("clip head+tails huge output", (() => { const big = "x".repeat(20000); const c = clip(big); return c.length < big.length && c.includes("elided"); })());
check("clip leaves small output intact", clip("short") === "short");
check("system prompt states the contract (network off + final answer)", /NETWORK IS DISABLED/i.test(CODEACT_SYSTEM) && /FINAL ANSWER/i.test(CODEACT_SYSTEM));

// ── loop: two actions then a final answer ──
{
  const turns = ["```python\nprint('step1')\n```", "```bash\necho step2\n```", "All done — the answer is X."];
  let t = 0;
  const exec = async (cmd: string) => ({ code: 0, output: `ran: ${cmd.slice(0, 20)}` });
  const r = await runCodeAct({ task: "do it", model: async () => ({ text: turns[t++], inputTokens: 5, outputTokens: 3 }), exec });
  check("loop runs each action then stops on the no-code answer", r.stopped === "answered" && r.answer === "All done — the answer is X.");
  check("executed exactly the two code actions", r.steps.length === 2 && r.steps[0].action.lang === "python" && r.steps[1].action.lang === "bash");
  check("accrued tokens across all turns", r.totalInputTokens === 15 && r.totalOutputTokens === 9);
}

// ── approval gate: a denied block stops without executing ──
{
  let execd = false;
  const r = await runCodeAct({
    task: "x", model: async () => ({ text: "```bash\nrm -rf /\n```", inputTokens: 1, outputTokens: 1 }),
    exec: async () => { execd = true; return { code: 0, output: "" }; },
    approve: async () => false,
  });
  check("denied approval stops the loop and never executes", r.stopped === "denied" && !execd && r.steps.length === 0);
}

// ── abort ──
{
  const ac = new AbortController(); ac.abort();
  const r = await runCodeAct({ task: "x", model: async () => ({ text: "```bash\nls\n```", inputTokens: 1, outputTokens: 1 }), exec: async () => ({ code: 0, output: "" }), signal: ac.signal });
  check("aborts before any model call", r.stopped === "aborted" && r.steps.length === 0);
}

// ── repetition guard: an identical block re-emitted terminates as looping ──
{
  let execCount = 0;
  const r = await runCodeAct({
    task: "x", model: async () => ({ text: "```python\nwhile True: pass\n```", inputTokens: 1, outputTokens: 1 }),
    exec: async () => { execCount++; return { code: 1, output: "still failing" }; },
  });
  check("identical repeated block → stops as 'looping' (not endless)", r.stopped === "looping");
  check("the failing action wasn't re-run forever", execCount <= 1, `${execCount}`);
}

// ── step cap: endless distinct actions stop at the cap ──
{
  let n = 0;
  const r = await runCodeAct({ task: "x", maxSteps: 3, model: async () => ({ text: `\`\`\`python\nprint(${n++})\n\`\`\``, inputTokens: 1, outputTokens: 1 }), exec: async () => ({ code: 0, output: "ok" }) });
  check("stops at the step cap", r.stopped === "max-steps" && r.steps.length === 3);
}
check("default step cap is bounded", MAX_CODEACT_STEPS >= 10 && MAX_CODEACT_STEPS <= 30);

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
