// Multi-mind runtime (Phase 3) — the substrate Fusion/Council/Personas sit on.
//
// A worker runs a headless ReAct loop in its OWN isolated context window (separate message
// history) and returns a compressed text result — the orchestrator never sees the worker's
// intermediate tokens (R5: sub-agent isolation keeps the orchestrator lean). We own the control
// flow in code rather than a framework (R7 / 12-factor-agents).
//
// Tool capability is decided by the CALLER via the `tools` map it passes (full vs readOnlyTools),
// not hard-coded here: a worker given write/edit/run_bash CAN use them — so Council/Fusion workers
// can investigate, edit, run and TEST a real solution, not just propose text. Pass `approve` to gate
// each mutating tool (Council, which writes the REAL tree, threads the same per-action gate Solo
// uses); omit it for an isolated throwaway copy (Fusion candidates) where gating is pointless.
import { callModel, type Message, type ContentBlock } from "../providers/gateway.ts";
import { isOpenRouterEndpoint, type Config } from "../config.ts";
import { normalizeToolOutput, readOnlyToolView, toolCallMutates, type Tool } from "../agent/tools.ts";

export interface WorkerResult {
  label: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  error?: string;
}

// Progress signal so the orchestrators (Fusion/Council/Personas/Adaptive) can show LIVE feedback,
// instead of a frozen "working… 0.0k" while ~14 sequential model calls run silently. A worker fires:
//   • start — it began            (→ "· author…")
//   • text  — a streamed delta    (the worker's live "thinking", only when opts.stream is set)
//   • tool  — it called a tool     (→ "  → author: read_file index.html")
//   • step  — one model call finished, with THAT call's token deltas (→ bump the live token meter)
//   • done  — it finished, with its running token totals + ok
export type WorkerEvent =
  | { label: string; phase: "start" }
  | { label: string; phase: "text"; delta: string }
  | { label: string; phase: "tool"; tool: string; input: unknown }
  | { label: string; phase: "step"; inputTokens: number; outputTokens: number }
  | { label: string; phase: "done"; inputTokens: number; outputTokens: number; ok: boolean };

/** A terse one-line description of a worker's mutating tool call for the approval gate. Kept local
 *  (not imported from loop.ts) to avoid a circular import; mirrors loop.ts's `describe` for the cases
 *  that matter to a worker (write/edit/run_bash). */
function actionDesc(name: string, input: any): string {
  if (name === "write_file" || name === "edit_file") return `${name} ${input?.path ?? ""}`.trim();
  if (name === "run_bash") return `run_bash${input?.background ? " (background)" : ""}: ${String(input?.command ?? "")}`.trim();
  const s = (() => { try { return JSON.stringify(input); } catch { return ""; } })();
  return `${name}${s ? " " + (s.length > 80 ? s.slice(0, 77) + "…" : s) : ""}`;
}

/** Tools safe for an autonomous worker: read-only, and not the memory-mutating or
 *  registry-mutating helpers (load_mcp_tool would activate tools into the shared map). */
export function readOnlyTools(all: Map<string, Tool>): Map<string, Tool> {
  const deny = new Set(["memory_add", "relate", "load_mcp_tool"]);
  const m = new Map<string, Tool>();
  for (const [k, t] of all) {
    if (deny.has(t.def.name)) continue;
    const view = readOnlyToolView(t);
    if (view) m.set(k, view);
  }
  return m;
}

/** Run a single worker to completion in an isolated context. Returns its final text. */
export async function runWorker(opts: {
  label: string;
  task: string;
  system: string;
  cfg: Config;
  tools: Map<string, Tool>;
  maxSteps?: number;
  model?: string; // override cfg.model (for multi-model Fusion)
  onEvent?: (ev: WorkerEvent) => void; // live progress (start/text/tool/step/done) for the orchestrator's UI
  stream?: boolean;                    // forward token-by-token text deltas as `text` events (sequential workers only — parallel ones would interleave)
  signal?: AbortSignal;                // external cancellation (ESC) — stops the worker
  /** Per-action gate for MUTATING tools (write/edit/run_bash). When set, a mutating call runs only if
   *  this resolves true; when omitted, mutating tools run ungated (safe only for a throwaway copy). */
  approve?: (desc: string) => Promise<boolean>;
  _call?: typeof callModel;            // injectable model call (deterministic tests)
}): Promise<WorkerResult> {
  const { label, task, system, cfg, tools } = opts;
  const call = opts._call ?? callModel;
  const maxSteps = opts.maxSteps ?? 12;
  const model = opts.model ?? cfg.model;
  const history: Message[] = [{ role: "user", content: task }];
  const toolDefs = [...tools.values()].map((t) => t.def);
  let inTok = 0, outTok = 0;
  // Emit `done` and return in one place, so every exit path (success / step-budget / error) reports.
  const done = (r: WorkerResult): WorkerResult => {
    opts.onEvent?.({ label, phase: "done", inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: r.ok });
    return r;
  };
  opts.onEvent?.({ label, phase: "start" });

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (opts.signal?.aborted) return done({ label, text: "(stopped)", inputTokens: inTok, outputTokens: outTok, ok: false, error: "aborted" });
      const resp = await call({
        provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl,
        model, maxTokens: cfg.maxTokens, effort: cfg.effort, openrouter: isOpenRouterEndpoint(cfg), system, messages: history,
        tools: toolDefs.length ? toolDefs : undefined,
        // Forward this worker's live "thinking" as text events (sequential workers only).
        onText: opts.stream && opts.onEvent ? (d) => opts.onEvent!({ label, phase: "text", delta: d }) : undefined,
        signal: opts.signal,
      });
      const stepIn = resp.usage?.input_tokens ?? 0, stepOut = resp.usage?.output_tokens ?? 0;
      inTok += stepIn; outTok += stepOut;
      opts.onEvent?.({ label, phase: "step", inputTokens: stepIn, outputTokens: stepOut }); // bump the live meter per call
      history.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = resp.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n").trim();
        return done({ label, text, inputTokens: inTok, outputTokens: outTok, ok: true });
      }

      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        // ESC: stop starting tools, but still emit a result per tool_use so history stays well-formed.
        if (opts.signal?.aborted) { results.push({ type: "tool_result", tool_use_id: tu.id, content: "Stopped by user (ESC).", is_error: true }); continue; }
        opts.onEvent?.({ label, phase: "tool", tool: tu.name, input: tu.input }); // surface each tool call
        const tool = tools.get(tu.name);
        if (!tool) { results.push({ type: "tool_result", tool_use_id: tu.id, content: `unknown tool: ${tu.name}`, is_error: true }); continue; }
        // A `forceAsk` tool (e.g. expose_port — a PUBLIC tunnel) must NEVER run unattended. When no approve
        // callback is wired (autopilot worker) there's no way to confirm, so deny it with a clear reason
        // rather than silently opening it to the internet.
        if (tool.forceAsk && !opts.approve) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `${tu.name} always requires explicit confirmation and can't run unattended in this mode.`, is_error: true }); continue;
        }
        // Capability is set by the tools map the caller passed; here we only gate a mutating call when an
        // `approve` callback is wired (Council writing the real tree). No callback ⇒ runs (Fusion copy).
        if (toolCallMutates(tool, tu.name, tu.input) && opts.approve && !(await opts.approve(actionDesc(tu.name, tu.input)))) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "User denied this action.", is_error: true }); continue;
        }
        // Read-only minds don't consume images — keep just the text (and avoid "[object Object]" on a
        // structured {text,images} return).
        try { results.push({ type: "tool_result", tool_use_id: tu.id, content: normalizeToolOutput(await tool.run(tu.input, { signal: opts.signal })).text }); }
        catch (e) { results.push({ type: "tool_result", tool_use_id: tu.id, content: `error: ${(e as Error).message}`, is_error: true }); }
      }
      history.push({ role: "user", content: results });
    }
    return done({ label, text: "(hit step budget without finishing)", inputTokens: inTok, outputTokens: outTok, ok: false });
  } catch (e) {
    return done({ label, text: "", inputTokens: inTok, outputTokens: outTok, ok: false, error: (e as Error).message });
  }
}

/** Run items through `fn` concurrently with a cap; results preserve input order. */
export async function runParallel<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<WorkerResult>,
  concurrency = 4,
): Promise<WorkerResult[]> {
  const results: WorkerResult[] = new Array(items.length);
  let next = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => pump()));
  return results;
}
