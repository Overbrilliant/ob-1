// OpenAI-compatible Chat Completions provider (OpenRouter, OpenAI, local servers, etc.).
// Translates OB-1's internal message/tool blocks to OpenAI format and back.
// Streams the response (idle-timeout + retry via http.ts), assembling tool-call deltas by index.
import {
  toSystemBlocks,
  type CallOpts,
  type ContentBlock,
  type ImageSource,
  type ModelResponse,
  type SystemInput,
  type Usage,
} from "./types.ts";
import { visionEnabled } from "./models.ts";
import { streamSSE } from "./http.ts";

/** An OpenAI content part. A text part (whose `cache_control` is the OpenRouter prompt-cache breakpoint
 *  marker — honored for Anthropic/Gemini, ignored by auto-caching providers), or an image part (a
 *  data: URL the vision models read). */
type OATextPart = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type OAImagePart = { type: "image_url"; image_url: { url: string } };
type OAContentPart = OATextPart | OAImagePart;

/** Split a tool_result's content into its text and any image sources. A plain string → text only. */
function splitToolResult(content: string | ContentBlock[]): { text: string; images: ImageSource[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const text = content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  const images = content
    .filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image")
    .map((b) => b.source);
  return { text, images };
}

/** An internal ImageSource → an OpenAI image_url content part (a base64 data: URL). */
function imagePart(s: ImageSource): OAImagePart {
  return { type: "image_url", image_url: { url: `data:${s.mediaType};base64,${s.data}` } };
}

interface OAMessage {
  role: "system" | "user" | "assistant" | "tool";
  // A string, OR an array of content parts when we attach a cache_control breakpoint (OpenRouter only).
  // Never null/omitted: a tool-only assistant turn (tool_calls, no text) must still carry content "";
  // strict OpenAI-compatible proxies (Alibaba/Qwen) reject null/missing content with "The content field
  // is a required field." OpenAI accepts "" here too, so it's safe.
  content: string | OAContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** Build the system message. With caching on (OpenRouter), the system is emitted as content PARTS so a
 *  cache_control breakpoint can sit on the stable block(s) while a volatile trailing block (date /
 *  identity / per-turn memory) stays uncached — keeping the big static prefix a cross-step cache hit.
 *  Without caching (plain OpenAI / strict proxies) it stays a single string: auto-caching providers
 *  cache automatically, and we avoid sending array content that a strict proxy might reject. */
function systemMessage(system: SystemInput, cache: boolean): OAMessage {
  const blocks = toSystemBlocks(system);
  if (!cache || !blocks.some((b) => b.cache)) {
    return { role: "system", content: blocks.map((b) => b.text).join("\n\n") };
  }
  return {
    role: "system",
    content: blocks.map(
      (b): OAContentPart =>
        b.cache ? { type: "text", text: b.text, cache_control: EPHEMERAL } : { type: "text", text: b.text },
    ),
  };
}

/** Attach a cache_control breakpoint to the tail of the conversation (the last message with non-empty
 *  string content — typically the latest tool result or user turn). Caches the whole prefix up to here
 *  so the next step is a cache READ instead of a full re-send of the growing history. OpenRouter only. */
function markConversationCache(out: OAMessage[]): void {
  for (let i = out.length - 1; i >= 1; i--) {
    // skip i=0 (system, already handled)
    const m = out[i];
    if (typeof m.content === "string" && m.content.length > 0) {
      m.content = [{ type: "text", text: m.content, cache_control: EPHEMERAL }];
      return;
    }
  }
}

export function toOpenAIMessages(
  system: SystemInput,
  messages: CallOpts["messages"],
  cache = false,
  vision = false,
): OAMessage[] {
  const out: OAMessage[] = [systemMessage(system, cache)];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: OAMessage = { role: "assistant", content: text }; // "" for a tool-only turn — never null
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user turn: emit a `tool` message per tool_result, then any plain text. Images are special —
      // the OpenAI format does NOT allow image parts on a `tool` message, so any images a tool_result
      // (or a standalone image block) carries are collected and re-emitted in a trailing `user`
      // message with image_url parts. Vision-gated: a non-vision model gets a text placeholder instead.
      const pendingImages: OAImagePart[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const { text, images } = splitToolResult(b.content);
          const content =
            images.length && !vision
              ? (text ? text + "\n" : "") + "[screenshot omitted — the current model can't view images]"
              : text;
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content }); // never null — "" is fine
          if (vision) for (const im of images) pendingImages.push(imagePart(im));
        } else if (b.type === "image") {
          if (vision) pendingImages.push(imagePart(b.source));
        }
      }
      const texts = m.content
        .filter((b) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (pendingImages.length) {
        const parts: OAContentPart[] = [];
        if (texts) parts.push({ type: "text", text: texts });
        parts.push({ type: "text", text: "[Image(s) attached from the tool result above]" });
        parts.push(...pendingImages);
        out.push({ role: "user", content: parts });
      } else if (texts) {
        out.push({ role: "user", content: texts });
      }
    }
  }
  if (cache) markConversationCache(out);
  return out;
}

/** Build the Chat Completions request body. max_tokens is OMITTED when unset, so the model/provider
 *  governs output length (no arbitrary cap). Exported for deterministic testing. */
export function openAIBody(opts: CallOpts): Record<string, unknown> {
  const tools = opts.tools?.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const body: Record<string, unknown> = {
    model: opts.model,
    // Emit cache_control breakpoints only on OpenRouter (it honors them for Anthropic/Gemini and
    // normalizes message shapes for every provider). Plain/strict OpenAI-compatible endpoints get
    // plain-string content — OpenAI auto-caches anyway, and we avoid array content a strict proxy
    // (Alibaba/Qwen, FreeLLMAPI) might reject.
    messages: toOpenAIMessages(opts.system, opts.messages, !!opts.openrouter, visionEnabled(opts.model)),
    stream: true,
    stream_options: { include_usage: true }, // get a final usage chunk
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens; // omit ⇒ governed by the model
  if (opts.effort) {
    // OpenRouter takes the unified `reasoning` object (and maps effort→budget for every model, incl.
    // Anthropic/Gemini that natively use a token budget); plain OpenAI-compatible endpoints take the
    // legacy top-level param. Both are ignored by non-reasoning models. Reasoning streams back in
    // `delta.reasoning` by default (no `exclude`), which extractDelta() surfaces to onReasoning.
    if (opts.openrouter) body.reasoning = { effort: opts.effort };
    else body.reasoning_effort = opts.effort;
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

/** Pull the answer text and the reasoning/thinking delta out of one streaming `choices[].delta`.
 *  OpenRouter normalizes reasoning to `reasoning`; some providers use `reasoning_content`. Pure. */
export function extractDelta(delta: any): { text?: string; reasoning?: string } {
  return {
    text: delta?.content || undefined,
    reasoning: delta?.reasoning || delta?.reasoning_content || undefined,
  };
}

/** Rough token estimate (≈ 4 chars/token) used only as a fallback when a proxy omits the usage chunk —
 *  matches the chars/4 heuristic the live loader already uses, so the meter stays consistent. */
function estimateUsage(opts: CallOpts, outText: string, toolArgsChars: number): Usage {
  const sysChars = toSystemBlocks(opts.system).reduce((n, b) => n + b.text.length, 0);
  const inChars =
    sysChars +
    opts.messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
      0,
    );
  return {
    input_tokens: Math.ceil(inChars / 4),
    output_tokens: Math.ceil((outText.length + toolArgsChars) / 4),
    estimated: true,
  };
}

/** The Python/JS null reprs a buggy proxy sometimes sends as the literal text content of a tool-calling
 *  step (e.g. FreeLLMAPI). Exactly-this-and-nothing-else only — a real word like "None." won't match. */
const NULL_ARTIFACT = /^(none|null|undefined)$/i;

export async function callOpenAI(opts: CallOpts): Promise<ModelResponse> {
  let text = "";
  let heldNull = ""; // a LEADING bare-null delta, held back until we know if real text/tool calls follow
  const toolAcc: { id: string; name: string; args: string }[] = []; // by tool_call index
  let finish = "stop";
  let usage: Usage | undefined;
  let resolvedModel: string | undefined; // the model the proxy actually routed to (vs. an `auto` request)

  // Authorization is sent only when there IS a key. A keyless local/LAN endpoint (the Custom-endpoint
  // profile — Ollama, llama.cpp, …) needs no auth, and sending `Bearer undefined`/`Bearer ` can trip a
  // strict server. Managed server and keyed FreeLLMAPI/Custom endpoints carry a key.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "X-Title": "OB-1",
  };
  // Per-call extra headers (the free router's per-provider headers: OpenRouter attribution, a browser-like
  // UA for Cloudflare-fronted providers, …). Merged AFTER the defaults so a provider can override X-Title,
  // but BEFORE auth so it can never clobber the Authorization header below.
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  // Money-path retry safety: send the gateway's per-logical-call idempotency key so the managed server's
  // replay cache can dedupe a retried request that already billed. Sent to EVERY endpoint — third-party
  // OpenAI-compatible servers (Ollama, LM Studio, OpenRouter) ignore unknown headers, so it's harmless.
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  for await (const ev of streamSSE({
    url: `${opts.baseUrl}/chat/completions`,
    headers,
    body: JSON.stringify(openAIBody(opts)),
    signal: opts.signal,
  })) {
    if (ev.usage) {
      // OpenAI/OpenRouter report cached_tokens as a SUBSET of prompt_tokens (cache reads bill at a
      // discount), so subtract it out to keep input_tokens = the UNCACHED portion. The usage ledger
      // stores input + cacheRead separately so cached tokens are visible without being double-counted.
      // cache_write is surfaced for cost but NOT subtracted (its subset-of-prompt_tokens behavior varies by
      // provider, and we must never under-report input).
      const det = ev.usage.prompt_tokens_details ?? {};
      const cachedRead = det.cached_tokens ?? 0;
      const cacheWrite = det.cache_write_tokens ?? det.cache_creation_input_tokens ?? 0;
      usage = {
        input_tokens: Math.max(0, (ev.usage.prompt_tokens ?? 0) - cachedRead),
        output_tokens: ev.usage.completion_tokens ?? 0,
        cache_read_input_tokens: cachedRead || undefined,
        cache_creation_input_tokens: cacheWrite || undefined,
      };
    }
    if (ev.model) resolvedModel = ev.model; // proxies echo the resolved model on each chunk
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const d = extractDelta(delta);
    if (d.text) {
      if (!text && !heldNull && NULL_ARTIFACT.test(d.text.trim())) {
        heldNull = d.text; // first text is exactly "None"/"null" → hold it; it may be a null-content artifact
      } else {
        if (heldNull) {
          text += heldNull;
          opts.onText?.(heldNull);
          heldNull = "";
        } // real text followed → it was legit
        text += d.text;
        opts.onText?.(d.text);
      }
    }
    if (d.reasoning) opts.onReasoning?.(d.reasoning);
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const slot = (toolAcc[i] ??= { id: "", name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  const hasTools = toolAcc.some((t) => t.id || t.name);
  // A held bare-null leading delta: keep it ONLY if it stands alone as the answer (no tool calls) — then
  // it's a legitimate one-word reply. With tool calls it's the proxy's null-content artifact → drop it
  // (never streamed, never stored), which is what produced the stray "None" line in scrollback.
  if (heldNull && !hasTools) {
    text += heldNull;
    opts.onText?.(heldNull);
  }

  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  for (const tc of toolAcc) {
    if (!tc.id && !tc.name) continue;
    let input: any = {};
    try {
      input = JSON.parse(tc.args || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }
  const stop_reason = content.some((b) => b.type === "tool_use") || finish === "tool_calls" ? "tool_use" : "end_turn";
  // Proxy quirk: some OpenAI-compatible endpoints (e.g. FreeLLMAPI's `auto` router, several free-tier
  // providers) send no usage chunk, send all-zeros, or report ONLY prompt tokens (completion_tokens
  // 0/absent) even though a real answer streamed. Fall back to a local char-based estimate so the meter
  // never reads a misleading 0 — and backfill JUST the output count when the input was reported but the
  // output wasn't (the "10.1k in / 0.0k out" free-route symptom), keeping the provider's real input total.
  const toolArgsChars = toolAcc.reduce((n, t) => n + t.name.length + t.args.length, 0);
  const producedOutput = text.length > 0 || toolArgsChars > 0;
  if (!usage || (usage.input_tokens === 0 && usage.output_tokens === 0)) {
    usage = estimateUsage(opts, text, toolArgsChars);
  } else if (usage.output_tokens === 0 && producedOutput) {
    usage.output_tokens = estimateUsage(opts, text, toolArgsChars).output_tokens;
    usage.estimated = true;
  }
  return { stop_reason, content, usage, model: resolvedModel };
}
