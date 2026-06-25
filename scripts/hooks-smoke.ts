// Deterministic test for programmable hooks (injected executor — no real shell).
// Usage: bun run scripts/hooks-smoke.ts
import { matchHooks, runHooks, parseHooks, type HookConfig, type HookExec } from "../src/agent/hooks.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── matching ────────────────────────────────────────────────────────────────
const hooks: HookConfig[] = [
  { event: "PreToolUse", matcher: "run_bash", command: "guard.sh" },
  { event: "PreToolUse", command: "always.sh" },           // no matcher → all tools
  { event: "PostToolUse", matcher: "write_file|edit_file", command: "fmt.sh" },
  { event: "PostToolUseFailure", command: "hint.sh" },
];
check("matchHooks: PreToolUse for run_bash → both the run_bash hook and the unmatched-all hook", matchHooks(hooks, "PreToolUse", "run_bash").length === 2);
check("matchHooks: PreToolUse for write_file → only the no-matcher hook", matchHooks(hooks, "PreToolUse", "write_file").length === 1);
check("matchHooks: PostToolUse for write_file matches fmt", matchHooks(hooks, "PostToolUse", "write_file")[0].command === "fmt.sh");
check("matchHooks: PostToolUse for read_file → none", matchHooks(hooks, "PostToolUse", "read_file").length === 0);

// ── runHooks: block / allow / feedback ────────────────────────────────────────
// exit-2 PreToolUse hook blocks
const blockExec: HookExec = async (cmd) => cmd === "guard.sh" ? { code: 2, stdout: "", stderr: "secrets not allowed" } : { code: 0, stdout: "", stderr: "" };
const r1 = await runHooks(hooks, { event: "PreToolUse", tool: "run_bash", input: { command: "cat .env" } }, blockExec);
check("PreToolUse exit-2 BLOCKS with the stderr reason", r1.decision === "block" && /secrets not allowed/.test(r1.reason ?? ""));

// JSON {"decision":"block"} also blocks, with reason+feedback from the JSON
const jsonExec: HookExec = async () => ({ code: 0, stdout: JSON.stringify({ decision: "block", reason: "needs review", feedback: "run the linter first" }), stderr: "" });
const r2 = await runHooks([{ event: "PreToolUse", command: "x.sh" }], { event: "PreToolUse", tool: "write_file" }, jsonExec);
check("PreToolUse JSON decision:block → blocked", r2.decision === "block" && r2.reason === "needs review" && /linter/.test(r2.feedback));

// allow + stdout feedback
const okExec: HookExec = async () => ({ code: 0, stdout: "formatted 1 file", stderr: "" });
const r3 = await runHooks([{ event: "PostToolUse", command: "fmt.sh" }], { event: "PostToolUse", tool: "write_file", output: "ok" }, okExec);
check("PostToolUse allow + feedback collected", r3.decision === "allow" && r3.feedback === "formatted 1 file" && r3.ran === 1);

// non-blocking non-zero (code 1) → feedback, not a block
const warnExec: HookExec = async () => ({ code: 1, stdout: "lint warning: unused var", stderr: "" });
const r4 = await runHooks([{ event: "PostToolUse", command: "lint.sh" }], { event: "PostToolUse", tool: "edit_file", output: "x" }, warnExec);
check("PostToolUse code-1 is feedback, NOT a block", r4.decision === "allow" && /lint warning/.test(r4.feedback));

// PostToolUseFailure feeds a fix hint
const hintExec: HookExec = async () => ({ code: 0, stdout: "did you forget to import X?", stderr: "" });
const r5 = await runHooks([{ event: "PostToolUseFailure", command: "hint.sh" }], { event: "PostToolUseFailure", tool: "run_bash", error: "boom" }, hintExec);
check("PostToolUseFailure surfaces a fix hint", /import X/.test(r5.feedback));

// first PreToolUse blocker short-circuits (second hook not run)
let ran = 0;
const countExec: HookExec = async (cmd) => { ran++; return cmd === "a" ? { code: 2, stdout: "", stderr: "no" } : { code: 0, stdout: "", stderr: "" }; };
await runHooks([{ event: "PreToolUse", command: "a" }, { event: "PreToolUse", command: "b" }], { event: "PreToolUse", tool: "x" }, countExec);
check("PreToolUse first blocker short-circuits (2nd hook skipped)", ran === 1);

// hook executor that throws → recorded as feedback, not fatal
const throwExec: HookExec = async () => { throw new Error("spawn failed"); };
const r6 = await runHooks([{ event: "PostToolUse", command: "x" }], { event: "PostToolUse", tool: "t" }, throwExec);
check("a hook exec error is non-fatal (captured as feedback)", r6.decision === "allow" && /hook error/.test(r6.feedback));

// no matching hooks → trivial allow, ran 0
check("no matching hooks → allow, ran 0", (await runHooks(hooks, { event: "PostToolUse", tool: "read_file" }, okExec)).ran === 0);

// ── parseHooks validation ──────────────────────────────────────────────────────
const p = parseHooks([
  { event: "PreToolUse", command: "ok.sh", matcher: "run_bash" },
  { event: "Nope", command: "x" },
  { event: "PostToolUse" },          // missing command
  { event: "PostToolUseFailure", command: "fine.sh" },
]);
check("parseHooks keeps valid, drops invalid", p.hooks.length === 2 && p.errors.length === 2);
check("parseHooks non-array → error", parseHooks({}).errors.length === 1);
check("parseHooks null → empty (no error)", parseHooks(null).hooks.length === 0 && parseHooks(null).errors.length === 0);

if (fail) { console.error("\n✗ hooks smoke FAILED"); process.exit(1); }
console.log("\n✓ hooks smoke passed");
