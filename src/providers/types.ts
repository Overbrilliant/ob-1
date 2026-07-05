// Canonical internal LLM types. The runtime model route is OpenAI-compatible only:
// managed OB-1 server (OpenRouter server-side), FreeLLMAPI, or Custom API.
export type Provider = "openai";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A base64-encoded image, provider-agnostic. `data` is the raw base64 (no data: prefix); `mediaType`
 *  is the MIME (e.g. "image/png"). The active OpenAI-compatible route translates this to an
 *  `image_url:{url:"data:…"}` content part when the selected model supports vision. */
export interface ImageSource { data: string; mediaType: string }

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "tool_use"; id: string; name: string; input: any }
  // A tool_result is text, OR text + image blocks (a screenshot a vision model can SEE — browser_check).
  // Kept as a union so the overwhelmingly-common text-only case stays a plain string on the wire.
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** A segment of the system prompt with an explicit cacheability hint. `cache: true` marks a
 *  prompt-cache breakpoint at the END of this segment, so everything up to and including it is a
 *  reusable cached prefix (system instructions, tool defs, repo map). Volatile per-turn content
 *  (date, model identity, retrieved memory) is left UNCACHED in a trailing segment so it never busts
 *  the big stable prefix. Honored as explicit `cache_control` on OpenRouter; ignored harmlessly by
 *  plain OpenAI-compatible endpoints. */
export interface SystemBlock { text: string; cache?: boolean }
export type SystemInput = string | SystemBlock[];

/** Normalize a system prompt to blocks. A plain string is treated as one fully-cached block (matches
 *  the historical behavior where the whole system prompt was a single cache breakpoint). Empty blocks
 *  are dropped so we never emit a stray empty cache_control breakpoint. */
export function toSystemBlocks(system: SystemInput): SystemBlock[] {
  const blocks = typeof system === "string" ? [{ text: system, cache: true }] : system;
  return blocks.filter((b) => b.text && b.text.trim().length > 0);
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** True when the provider returned no usage and we estimated tokens locally (chars/4). Some
   *  OpenAI-compatible proxies — e.g. FreeLLMAPI's `auto` router — omit the usage chunk; without this
   *  the meter would read a misleading 0. The meter renders estimated counts with an "(est)" marker. */
  estimated?: boolean;
}

export interface ModelResponse {
  stop_reason: string;
  content: ContentBlock[];
  usage?: Usage;
  /** The model the provider actually used. Echoed by OpenAI-compatible responses; meaningful when the
   *  request asked for a router alias (e.g. `auto`) so the UI can show what it resolved to. */
  model?: string;
}

export interface CallOpts {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Output-token cap. UNDEFINED ⇒ governed by the model and omitted on the OpenAI-compatible path. */
  maxTokens?: number;
  system: SystemInput;
  messages: Message[];
  tools?: ToolDef[];
  /** Reasoning effort, when the model/provider supports it. On OpenRouter it's sent as the unified
   *  `reasoning: { effort }`; on a plain OpenAI-compatible endpoint as the legacy top-level
   *  `reasoning_effort`. Both map low/medium/high to a thinking-token budget. */
  effort?: "low" | "medium" | "high";
  /** True when the endpoint is the managed OB-1 server route to OpenRouter, which forwards the body
   *  verbatim. Selects the unified `reasoning` param. False/undefined for plain OpenAI-compatible
   *  endpoints (FreeLLMAPI, Custom API) → legacy `reasoning_effort`. */
  openrouter?: boolean;
  /** Live-streaming callback: invoked with each text delta as it arrives. Optional — workers
   *  omit it (just accumulate); the interactive loop passes one to print tokens live. */
  onText?: (delta: string) => void;
  /** Live-streaming callback for the model's REASONING/thinking deltas (separate channel from the
   *  answer). Surfaced in the TUI behind the Ctrl+O toggle; not stored in history. */
  onReasoning?: (delta: string) => void;
  /** External cancellation (ESC). Aborts the in-flight request; surfaces as an AbortError. */
  signal?: AbortSignal;
  /** Invoked before each retry of a failed upstream call (network / 429 / 5xx / idle timeout), so the
   *  UI can tell the user it's retrying rather than hanging. attempt is 1-based; delayMs is the wait. */
  onRetry?: (info: { attempt: number; max: number; delayMs: number; error: string }) => void;
  /** Idempotency key for the money path. ONE uuid per LOGICAL model call, held stable across that
   *  call's internal retries (set by the gateway's callModel), so a server-side replay cache can dedupe
   *  a retried request that already billed instead of double-charging. Sent as the `Idempotency-Key`
   *  request header; unknown headers are harmlessly ignored by third-party OpenAI-compatible endpoints. */
  idempotencyKey?: string;
}
