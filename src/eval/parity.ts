// Mock-provider parity harness (parity with claw-code's mock_parity_harness).
//
// A deterministic, scripted "model" injected at the gateway seam (runTurn's _callModel) that REPLAYS a
// fixed sequence of responses and RECORDS every request it received (system + messages + tool names).
// This lets us regression-test the agent loop's WIRE behavior — that tool_results are fed back, the
// conversation grows correctly, the system prompt is stable across steps, denials surface as errors —
// without a network or a real provider. Response builders make scenarios terse.
import type { CallOpts, ContentBlock, ModelResponse, Usage } from "../providers/types.ts";

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 };

/** A plain end_turn text response. */
export function asText(text: string): ModelResponse {
  return { stop_reason: "end_turn", content: [{ type: "text", text }], usage: { ...USAGE } };
}

export interface ToolCallSpec { name: string; input: unknown; id?: string }
/** A tool_use response (optionally preceded by some assistant text). */
export function asToolUse(calls: ToolCallSpec[], opts: { text?: string } = {}): ModelResponse {
  const content: ContentBlock[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  calls.forEach((c, i) => content.push({ type: "tool_use", id: c.id ?? `call_${i + 1}`, name: c.name, input: c.input }));
  return { stop_reason: "tool_use", content, usage: { ...USAGE } };
}

/** A snapshot of one request the loop made (messages deep-cloned, since history is mutated in place). */
export interface RecordedRequest {
  system: string;
  messages: { role: string; content: any }[];
  toolNames: string[];
}

/** A scripted model: replays `script` in order, recording each request. Use `.callModel` as runTurn's
 *  `_callModel`. Runs out → returns a benign end_turn (so an over-short script fails loudly in asserts,
 *  not by hanging). */
export class MockBrain {
  readonly requests: RecordedRequest[] = [];
  private i = 0;
  constructor(private readonly script: ModelResponse[]) {}

  callModel = async (opts: CallOpts): Promise<ModelResponse> => {
    const system = typeof opts.system === "string" ? opts.system : opts.system.map((b) => b.text).join("\n\n");
    this.requests.push({
      system,
      messages: JSON.parse(JSON.stringify(opts.messages)),
      toolNames: (opts.tools ?? []).map((t) => t.name),
    });
    return this.script[this.i++] ?? asText("(script exhausted)");
  };

  get steps(): number { return this.i; }
  request(n: number): RecordedRequest | undefined { return this.requests[n]; }
  last(): RecordedRequest | undefined { return this.requests[this.requests.length - 1]; }
}

/** Find the tool_result blocks fed back in a recorded request (the user message after an assistant
 *  tool_use). Useful for asserting a scenario's roundtrip. */
export function toolResultsIn(req: RecordedRequest | undefined): { tool_use_id: string; content: string; is_error?: boolean }[] {
  if (!req) return [];
  const out: any[] = [];
  for (const m of req.messages) {
    if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}
