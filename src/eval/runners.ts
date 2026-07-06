// Eval runners (Phase 7) — adapt each mode to the harness's uniform ModeRunner: take a task
// prompt, return final text + total tokens. Every mode is held to the same grading contract
// (one fenced code block) so the objective check can grade them identically.
import { runWorker, readOnlyTools } from "../multimind/runtime.ts";
import { runFusion } from "../multimind/fusion.ts";
import { runCodeAct, CODEACT_SYSTEM } from "../agent/codeact.ts";
import { shellExec } from "../agent/verify.ts";
import { callModel } from "../providers/gateway.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";
import type { ModeRunner, RunOutput } from "./harness.ts";

const GRADE_CONTRACT =
  "\n\nOutput the COMPLETE solution as a single fenced code block (full file content, exports included). No prose outside the block.";

/** Solo baseline: a single isolated read-only worker, one pass — the 1× reference all modes race. */
export async function runSolo(taskPrompt: string, cfg: Config, tools: Map<string, Tool>): Promise<RunOutput> {
  const w = await runWorker({
    label: "solo",
    task: taskPrompt,
    system:
      "You are OB-1 Solo — a single, careful coding agent. Solve the task well in one pass; investigate " +
      "with the read-only tools if needed, then output the complete solution as one fenced code block. No preamble.",
    cfg,
    tools: readOnlyTools(tools),
  });
  return { text: w.text, inputTokens: w.inputTokens, outputTokens: w.outputTokens };
}

/** CodeAct (item #9) as an eval mode: the model develops + verifies its solution by EXECUTING code in
 *  the sandbox, then a final extraction call turns the verified work into the graded artifact (one fenced
 *  block). Tokens counted = the whole solve loop + the extraction (CodeAct's real cost vs Solo's one pass).
 *  Note CodeAct's terminal signal is "no code block", which conflicts with the grade contract — hence the
 *  separate extraction step rather than asking the loop itself to emit the block. */
export async function runCodeActMode(taskPrompt: string, cfg: Config): Promise<RunOutput> {
  const model = async (messages: { role: "user" | "assistant"; content: string }[]) => {
    const r = await callModel({ provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, model: cfg.model, system: CODEACT_SYSTEM, messages });
    return { text: r.content.filter((b) => b.type === "text").map((b: any) => b.text).join(""), inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 };
  };
  // Run the solve loop in a THROWAWAY scratch dir so the model's dev/test files never pollute the
  // workspace (the eval just grades the extracted block; CodeAct's working files are disposable).
  const scratch = mkdtempSync(join(tmpdir(), "ob1-codeact-eval-"));
  const exec = (command: string) => shellExec({ cwd: scratch, sandbox: cfg.sandbox, command, timeoutMs: 30_000 });
  let r;
  try {
    r = await runCodeAct({
      task: taskPrompt + "\n\nDevelop and VERIFY your solution by writing and running code (use `bun` to test TypeScript). When confident it is correct, give your final answer.",
      model, exec, maxSteps: 8,
    });
  } finally { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ } }
  // Extraction: the verified work → the graded fenced block (counts toward CodeAct's token budget).
  const ext = await callModel({
    provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, model: cfg.model, system: "",
    messages: [{ role: "user", content: `Task:\n${taskPrompt}\n\nYour working notes:\n${r.answer || "(solved via code execution)"}\n\nNow output the COMPLETE final solution as a single fenced code block (the full file, with the named export). No prose outside the block.` }],
  });
  const text = ext.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  return { text, inputTokens: r.totalInputTokens + (ext.usage?.input_tokens ?? 0), outputTokens: r.totalOutputTokens + (ext.usage?.output_tokens ?? 0) };
}

export const ALL_MODES = ["solo", "fusion"] as const;
export const SELECTABLE_MODES = [...ALL_MODES, "codeact"] as const;

const parseModels = (v: string | undefined): string[] | undefined => {
  const ms = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ms.length ? ms : undefined;
};

/** Build runners for the requested modes, all bound to the same cfg/tools and grading contract.
 *  Fusion multi-model routing comes from OB1_FUSION_MODELS (round-robin). NOTE: heterogeneous panels
 *  (council/personas) were measured HARMFUL (100%→40% accuracy at 29× tokens) and deleted 2026-07; see
 *  git history. */
export function buildRunners(cfg: Config, tools: Map<string, Tool>, modes: string[]): Record<string, ModeRunner> {
  const fusionModels = parseModels(process.env.OB1_FUSION_MODELS);
  const out: Record<string, ModeRunner> = {};
  for (const m of modes) {
    if (m === "solo") out.solo = (t) => runSolo(t + GRADE_CONTRACT, cfg, tools);
    else if (m === "fusion") out.fusion = (t) => runFusion({ task: t + GRADE_CONTRACT, cfg, tools, models: fusionModels, moa: process.env.OB1_FUSION_MOA === "1", judgeModel: process.env.OB1_FUSION_JUDGE_MODEL }).then((r) => ({ text: r.synthesis, inputTokens: r.totalInputTokens, outputTokens: r.totalOutputTokens }));
    else if (m === "codeact") out.codeact = (t) => runCodeActMode(t, cfg); // develops+verifies via sandboxed execution, then extracts
  }
  return out;
}
