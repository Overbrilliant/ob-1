// Anthropic Messages API provider. Internal types are already Anthropic-shaped, so this is
// nearly a pass-through. Streams the response (idle-timeout + retry via http.ts) and sets
// prompt-cache breakpoints on the stable prefix (system + tools) so cache-reads are ~10% cost.
import { toSystemBlocks, type CallOpts, type ContentBlock, type ImageSource, type Message, type ModelResponse, type Usage } from "./types.ts";
import { maxOutputFor, visionEnabled } from "./models.ts";
import { streamSSE } from "./http.ts";

const EPHEMERAL = { type: "ephemeral" } as const;

/** A message already translated to Anthropic wire shape (content blocks are wire objects, not our
 *  internal union). `unknown[]` because translated blocks are heterogeneous provider-specific shapes. */
type WireMessage = { role: "user" | "assistant"; content: string | unknown[] };

/** An internal ImageSource → Anthropic's nested base64 image source. */
function toAnthropicSource(s: ImageSource) {
  return { type: "base64" as const, media_type: s.mediaType, data: s.data };
}

/** Translate one internal block to Anthropic wire shape. `vision` gates images: when the model can't see
 *  them, an image block degrades to a short text placeholder — so a screenshot left in history by an
 *  earlier vision-model turn never 400s a text-only model after a mid-session model switch. */
function toAnthropicBlock(b: ContentBlock, vision: boolean): unknown {
  if (b.type === "image") {
    return vision
      ? { type: "image", source: toAnthropicSource(b.source) }
      : { type: "text", text: "[screenshot omitted — the current model can't view images]" };
  }
  if (b.type === "tool_result") {
    const content = typeof b.content === "string" ? b.content : b.content.map((c) => toAnthropicBlock(c, vision));
    const out: Record<string, unknown> = { type: "tool_result", tool_use_id: b.tool_use_id, content };
    if (b.is_error) out.is_error = true;
    return out;
  }
  return b; // text / tool_use are already Anthropic-shaped
}

/** Translate internal messages to Anthropic wire messages (image sources + tool_result array content).
 *  Pure — never mutates the caller's history. Exported for deterministic testing. */
export function toAnthropicMessages(messages: Message[], vision: boolean): WireMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map((b) => toAnthropicBlock(b, vision)),
  }));
}

/** Return a wire copy of (already-translated) `messages` with a cache breakpoint on the LAST content
 *  block of the last message — so the WHOLE conversation prefix up to here is cached and reused on the
 *  next step. This is the lever that makes each tool-call step within a turn a cache HIT instead of a
 *  full re-send of the growing history. Never mutates its input: clones only the final message. A
 *  string content is promoted to a single text block so the breakpoint has somewhere to attach. */
export function withConversationCache(messages: WireMessage[]): unknown[] {
  if (messages.length === 0) return messages;
  const out: unknown[] = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  const blocks = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : last.content.map((b) => ({ ...(b as object) }));
  if (blocks.length) (blocks[blocks.length - 1] as Record<string, unknown>).cache_control = EPHEMERAL;
  out.push({ role: last.role, content: blocks });
  return out;
}

/** Anthropic REQUIRES max_tokens, so when unset we use the model's registry ceiling rather than an
 *  arbitrary cap. cache_control breakpoints mark the reusable prefix — the LAST tool def, the stable
 *  system block(s), and the tail of the conversation — so cache-reads cost ~10% of full input and the
 *  big static prefix isn't re-billed on every tool call (R1). Stays within Anthropic's 4-breakpoint
 *  limit: ≤1 (last tool) + ≤1 (stable system; volatile tail uncached) + 1 (conversation). Exported for tests. */
export function anthropicBody(opts: CallOpts): Record<string, unknown> {
  const tools = opts.tools && opts.tools.length
    ? opts.tools.map((t, i) =>
        i === opts.tools!.length - 1 ? { ...t, cache_control: EPHEMERAL } : t)
    : undefined;
  const blocks = toSystemBlocks(opts.system);
  const system = blocks.length
    ? blocks.map((b) => (b.cache ? { type: "text", text: b.text, cache_control: EPHEMERAL } : { type: "text", text: b.text }))
    : undefined;
  return {
    model: opts.model,
    max_tokens: opts.maxTokens ?? maxOutputFor(opts.model),
    system,
    messages: withConversationCache(toAnthropicMessages(opts.messages, visionEnabled(opts.model))),
    tools,
  };
}

export async function callAnthropic(opts: CallOpts): Promise<ModelResponse> {
  const blocks: ContentBlock[] = [];        // indexed by SSE content-block index
  const jsonByIndex: Record<number, string> = {}; // accumulates tool_use input json deltas
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stop_reason = "end_turn";

  for await (const ev of streamSSE({
    url: `${opts.baseUrl}/v1/messages`,
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ ...anthropicBody(opts), stream: true }),
    signal: opts.signal,
  })) {
    switch (ev.type) {
      case "message_start": {
        const u = ev.message?.usage;
        if (u) {
          usage.input_tokens = u.input_tokens ?? 0;
          usage.cache_read_input_tokens = u.cache_read_input_tokens;
          usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        }
        break;
      }
      case "content_block_start": {
        const cb = ev.content_block;
        if (cb?.type === "text") blocks[ev.index] = { type: "text", text: cb.text ?? "" };
        else if (cb?.type === "tool_use") { blocks[ev.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {} }; jsonByIndex[ev.index] = ""; }
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index];
        if (ev.delta?.type === "text_delta" && b?.type === "text") { b.text += ev.delta.text; opts.onText?.(ev.delta.text); }
        else if (ev.delta?.type === "thinking_delta") opts.onReasoning?.(ev.delta.thinking ?? "");
        else if (ev.delta?.type === "input_json_delta") jsonByIndex[ev.index] = (jsonByIndex[ev.index] ?? "") + (ev.delta.partial_json ?? "");
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b?.type === "tool_use") { try { b.input = jsonByIndex[ev.index] ? JSON.parse(jsonByIndex[ev.index]) : {}; } catch { b.input = {}; } }
        break;
      }
      case "message_delta": {
        if (ev.delta?.stop_reason) stop_reason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
        break;
      }
      case "error": throw new Error(`Anthropic stream error: ${JSON.stringify(ev.error)}`);
    }
  }

  return { stop_reason, content: blocks.filter(Boolean), usage };
}
