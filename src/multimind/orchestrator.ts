// Multi-mind orchestrator (Phase 3) — parallel fan-out + synthesis.
//
// Spawns N isolated workers on the same task (each with a different "angle"), then a
// synthesizer compresses their outputs into one answer. This is the shared skeleton the
// named modes refine: Fusion adds auto-scoring of candidates, Council adds adversarial
// cross-critique rounds, Personas assigns role-specialized angles. (Phases 4–6.)
import { runWorker, runParallel, readOnlyTools, type WorkerResult, type WorkerEvent } from "./runtime.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";

export interface FanoutResult {
  workers: WorkerResult[];
  synthesis: string;
  totalInputTokens: number;
  totalOutputTokens: number;
}

const DEFAULT_ANGLES = [
  "Solve it directly and pragmatically.",
  "Focus first on edge cases, risks, and failure modes.",
  "Find the simplest possible solution; prefer reuse over new code.",
];

export async function fanout(opts: {
  task: string;
  cfg: Config;
  tools: Map<string, Tool>;
  angles?: string[];
  concurrency?: number;
  onEvent?: (ev: WorkerEvent) => void; // live per-worker progress (workers + synthesizer) for the UI
  signal?: AbortSignal;                // external cancellation (ESC)
}): Promise<FanoutResult> {
  const roTools = readOnlyTools(opts.tools);
  const angles = opts.angles ?? DEFAULT_ANGLES;

  const results = await runParallel(
    angles,
    (angle, i) =>
      runWorker({
        label: `worker-${i + 1}`,
        task: opts.task,
        system:
          `You are OB-1 worker ${i + 1}, exploring a coding task in an isolated context. ${angle} ` +
          `Use the read-only tools to investigate the codebase as needed. Produce a concise, concrete answer or draft — no preamble.`,
        cfg: opts.cfg,
        tools: roTools,
        onEvent: opts.onEvent, signal: opts.signal,
      }),
    opts.concurrency ?? angles.length,
  );

  // Result compression back to the orchestrator: one synthesizer pass over the drafts.
  const combined = results
    .map((r) => `## ${r.label}${r.ok ? "" : " (incomplete)"}\n${r.text || r.error || "(no output)"}`)
    .join("\n\n");
  const synth = await runWorker({
    label: "synthesizer",
    task: `${results.length} independent workers explored this task:\n\n${combined}\n\nSynthesize the single best answer, grafting the strongest parts of each and discarding anything wrong or unsupported. Be concise and concrete.`,
    system: "You are OB-1's synthesizer. Merge independent drafts into one best answer. Do not invent; prefer points multiple workers agree on.",
    cfg: opts.cfg,
    tools: new Map(),
    onEvent: opts.onEvent,
    stream: true, // sequential primary → stream its thinking live
  });

  return {
    workers: results,
    synthesis: synth.text,
    totalInputTokens: results.reduce((a, r) => a + r.inputTokens, 0) + synth.inputTokens,
    totalOutputTokens: results.reduce((a, r) => a + r.outputTokens, 0) + synth.outputTokens,
  };
}
