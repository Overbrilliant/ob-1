// Code-as-action (CodeAct) execution mode — PLAN-V2 item #9. OPT-IN (the `/codeact` command).
//
// Instead of emitting a JSON tool call, the model acts by emitting a single executable code block
// (```python or ```bash); we run it in the existing OS sandbox (network-off, approval-gated) and feed
// the stdout/stderr back as the observation. It keeps acting until it answers with NO code block — that
// terminal message is the final answer. This is the CodeAct paradigm (Wang et al. / OpenHands
// CodeActAgent), reported to beat rigid JSON tool-calling on agentic benchmarks — but it's an unproven
// ⚠️ claim for OUR setup, so it's opt-in and meant to be measured on `/eval` before being trusted.
//
// This module is the pure, testable core (parse + command-build + observation-format) plus a loop with
// injected model/exec/approve seams. Source: arxiv 2402.01030 (CodeAct) + OpenHands runtime.

export interface CodeAction { lang: "python" | "bash"; code: string }

// A unique heredoc delimiter so the model's code can't accidentally close it.
const PY_EOF = "OB1_CODEACT_PY_EOF";

/** Extract the LAST executable fenced block from the model's message (models often narrate with an
 *  illustrative snippet first, then give the real action last — CodeAct research). No block ⇒ null
 *  (= final answer). */
export function parseCodeAction(text: string): CodeAction | null {
  const matches = [...text.matchAll(/```(python|py|bash|sh|shell)[ \t]*\r?\n([\s\S]*?)```/gi)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  const lang: CodeAction["lang"] = /^(python|py)$/i.test(m[1]) ? "python" : "bash";
  const code = m[2].replace(/\s+$/, "");
  return code.trim() ? { lang, code } : null;
}

/** Build the shell command that runs an action under the sandbox (python via a stdin heredoc). */
export function buildCommand(a: CodeAction): string {
  return a.lang === "python" ? `python3 - <<'${PY_EOF}'\n${a.code}\n${PY_EOF}` : a.code;
}

/** Head+tail truncate so a `cat` of a huge file can't blow the context (CodeAct observation hygiene). */
export function clip(s: string, head = 4000, tail = 4000): string {
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + `\n[… ${s.length - head - tail} bytes elided …]\n` + s.slice(-tail);
}

/** Format an execution result as the observation fed back to the model: exit-code-bearing + truncated. */
export function formatObservation(code: number, output: string): string {
  const body = clip(output.trim()) || "(no output)";
  return `[observation exit_code=${code}]\n${body}`;
}

export const CODEACT_SYSTEM =
  "You are OB-1 running in CODE-ACTION mode. Act by emitting EXACTLY ONE fenced code block — ```python for " +
  "logic/file work or ```bash for shell. After each block I run it in a sandbox and reply with an " +
  "`[observation exit_code=N]` (its stdout/stderr). Decide your next single block from that observation. " +
  "Keep blocks SMALL — prefer one step at a time over bundling many operations. Import packages and define " +
  "variables before use. The NETWORK IS DISABLED — do not pip-install or make HTTP calls; use the standard " +
  "library and pre-installed tools. Prefer executing code over describing it, and verify each action via its " +
  "observation (don't assume it worked). When the task is fully done, reply with your FINAL ANSWER as plain " +
  "prose and NO code block — that ends the task.";

export interface CodeActStep { action: CodeAction; code: number; output: string }
export interface CodeActResult {
  answer: string;
  steps: CodeActStep[];
  stopped: "answered" | "max-steps" | "denied" | "aborted" | "looping";
  totalInputTokens: number;
  totalOutputTokens: number;
}

export const MAX_CODEACT_STEPS = 15;

export type CodeActModel = (messages: { role: "user" | "assistant"; content: string }[]) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
export type CodeActExec = (command: string) => Promise<{ code: number; output: string }>;

/** The CodeAct ReAct loop: model emits a code block → (approve) → execute → observe → repeat, until the
 *  model answers with no code block, an approval is denied, the step cap, or abort. All I/O injected. */
export async function runCodeAct(opts: {
  task: string;
  model: CodeActModel;
  exec: CodeActExec;
  approve?: (action: CodeAction) => Promise<boolean>;
  onText?: (delta: string) => void;
  maxSteps?: number;
  signal?: AbortSignal;
}): Promise<CodeActResult> {
  const max = opts.maxSteps ?? MAX_CODEACT_STEPS;
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: opts.task }];
  const steps: CodeActStep[] = [];
  let inTok = 0, outTok = 0;
  let prevCode: string | null = null, steers = 0; // repetition guard

  for (let i = 0; i < max; i++) {
    if (opts.signal?.aborted) return { answer: "", steps, stopped: "aborted", totalInputTokens: inTok, totalOutputTokens: outTok };
    const resp = await opts.model(messages);
    inTok += resp.inputTokens; outTok += resp.outputTokens;
    messages.push({ role: "assistant", content: resp.text });
    const action = parseCodeAction(resp.text);
    if (!action) {
      opts.onText?.(resp.text);
      return { answer: resp.text.trim(), steps, stopped: "answered", totalInputTokens: inTok, totalOutputTokens: outTok };
    }
    // Loop guard: an identical block re-emitted is the dominant CodeAct degenerate loop. Steer once;
    // terminate if it persists (rather than re-running the same failing action forever).
    if (action.code === prevCode) {
      if (++steers >= 2) return { answer: "", steps, stopped: "looping", totalInputTokens: inTok, totalOutputTokens: outTok };
      messages.push({ role: "user", content: "[observation] You re-emitted an identical code block. Change your approach or give the final answer — do not repeat a failing action." });
      continue;
    }
    steers = 0; prevCode = action.code;
    if (opts.approve && !(await opts.approve(action))) {
      return { answer: "", steps, stopped: "denied", totalInputTokens: inTok, totalOutputTokens: outTok };
    }
    const { code, output } = await opts.exec(buildCommand(action));
    steps.push({ action, code, output });
    messages.push({ role: "user", content: formatObservation(code, output) });
  }
  return { answer: "", steps, stopped: "max-steps", totalInputTokens: inTok, totalOutputTokens: outTok };
}
