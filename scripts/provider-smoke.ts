// Deterministic test (no API key). Verifies the active OpenAI-compatible model route:
//   - OpenAI-compatible OMITS max_tokens when unset (the model governs length)
//   - OpenRouter cache/reasoning/image behavior is represented in OpenAI-format payloads
// Usage: bun run scripts/provider-smoke.ts
import { toOpenAIMessages, openAIBody, extractDelta, callOpenAI } from "../src/providers/openai.ts";
import { streamSSE } from "../src/providers/http.ts";
import { maxOutputFor, describeModel, DEFAULT_MAX_OUTPUT, isRouterModel, supportsEffort, modelReasoning, reasoningVisible, modelSupportsVision, visionEnabled } from "../src/providers/models.ts";
import type { Message, CallOpts } from "../src/providers/types.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

// --- tool_use / tool_result translation round-trip ---
const history: Message[] = [
  { role: "user", content: "read the config" },
  { role: "assistant", content: [
    { type: "text", text: "Reading it." },
    { type: "tool_use", id: "call_1", name: "read_file", input: { path: "config.ts" } },
  ] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "call_1", content: "export const x = 1;" },
  ] },
];
const oa = toOpenAIMessages("You are OB-1.", history);
const asst = oa.find((m) => m.role === "assistant") as any;
const toolMsg = oa.find((m) => m.role === "tool") as any;
check("translation: system + tool_use→tool_calls + tool_result→tool msg",
  oa[0].role === "system" && asst?.tool_calls?.[0]?.id === "call_1" &&
  asst.tool_calls[0].function.name === "read_file" &&
  JSON.parse(asst.tool_calls[0].function.arguments).path === "config.ts" &&
  toolMsg?.tool_call_id === "call_1" && toolMsg.content.includes("export const x"));

// --- tool-ONLY assistant turn (e.g. use_skill with no text): content must be "" (string), NEVER null.
//     Strict OpenAI-compatible proxies (Alibaba/Qwen) 400 with "content field is a required field" on null. ---
const toolOnly = toOpenAIMessages("sys", [
  { role: "assistant", content: [{ type: "tool_use", id: "c9", name: "use_skill", input: { name: "ascii-art" } }] },
]);
const toolOnlyAsst = toolOnly.find((m) => m.role === "assistant") as any;
check("tool-only assistant turn: content is \"\" (string), never null",
  toolOnlyAsst.content === "" && toolOnlyAsst.content !== null && toolOnlyAsst.tool_calls?.[0]?.id === "c9");
check("tool-only assistant turn: serialized JSON keeps a string content field (not null/missing)",
  (() => { const j = JSON.parse(JSON.stringify(toolOnlyAsst)); return typeof j.content === "string"; })());

// --- model-governed token caps ---
const base: CallOpts = { provider: "openai", apiKey: "x", baseUrl: "http://x", model: "qwen/qwen3.6-plus", system: "s", messages: [{ role: "user", content: "hi" }] };
const uncapped = openAIBody(base);
check("openai OMITS max_tokens when unset (model governs)", !("max_tokens" in uncapped));
check("openai includes max_tokens only when explicitly set", openAIBody({ ...base, maxTokens: 5000 }).max_tokens === 5000);

// --- prompt caching: OpenRouter path emits cache_control in OpenAI-format content arrays ---
const orSplit: CallOpts = { ...base, openrouter: true,
  system: [{ text: "STABLE", cache: true }, { text: "volatile" }],
  messages: [{ role: "user", content: "do a thing" }] };
const orBody = openAIBody(orSplit);
const orSys = (orBody.messages as any[])[0];
check("openrouter: system emitted as content PARTS with cache_control on the stable block", (() => {
  return Array.isArray(orSys.content) && orSys.content[0].text === "STABLE" && orSys.content[0].cache_control?.type === "ephemeral" && orSys.content[1].cache_control === undefined;
})());
check("openrouter: conversation tail gets a cache_control breakpoint", (() => {
  const last = (orBody.messages as any[]).at(-1);
  return Array.isArray(last.content) && last.content.at(-1).cache_control?.type === "ephemeral";
})());

// --- plain OpenAI (NOT OpenRouter): system stays a plain string, no cache_control (strict-proxy safe) ---
const plainBody = openAIBody({ ...base, system: [{ text: "STABLE", cache: true }, { text: "volatile" }] });
check("plain openai: system is a plain STRING (no array, no cache_control)", typeof (plainBody.messages as any[])[0].content === "string");
check("plain openai: no cache_control anywhere in the body", JSON.stringify(plainBody).indexOf("cache_control") === -1);

// --- streaming: OpenAI-compatible body opts in to a streamed response + final usage chunk ---
check("openai: requests a stream with usage", uncapped.stream === true && (uncapped.stream_options as any)?.include_usage === true);

// --- reasoning effort: sent only when set, with the right param per endpoint ---
check("openai: omits all reasoning params when effort unset", !("reasoning_effort" in uncapped) && !("reasoning" in uncapped));
check("openai (plain): sends legacy reasoning_effort when set", openAIBody({ ...base, effort: "high" }).reasoning_effort === "high");
check("openai (openrouter): sends unified reasoning.effort, not the legacy param", (() => {
  const b = openAIBody({ ...base, effort: "high", openrouter: true });
  return !("reasoning_effort" in b) && (b.reasoning as any)?.effort === "high";
})());
check("openai (openrouter): no reasoning object when effort unset", !("reasoning" in openAIBody({ ...base, openrouter: true })));

// --- streaming delta extraction: answer text vs reasoning/thinking channel ---
check("extractDelta: pulls answer text", extractDelta({ content: "hello" }).text === "hello" && extractDelta({ content: "hi" }).reasoning === undefined);
check("extractDelta: pulls reasoning (OpenRouter `reasoning`)", extractDelta({ reasoning: "let me think" }).reasoning === "let me think");
check("extractDelta: pulls reasoning_content fallback", extractDelta({ reasoning_content: "deepseek-style" }).reasoning === "deepseek-style");
check("extractDelta: text + reasoning are separate channels", (() => { const d = extractDelta({ content: "ans", reasoning: "why" }); return d.text === "ans" && d.reasoning === "why"; })());
check("extractDelta: empty delta → nothing", (() => { const d = extractDelta({}); return d.text === undefined && d.reasoning === undefined; })());

// --- cancellation: an already-aborted signal stops the stream before any fetch (ESC) ---
{
  const ac = new AbortController(); ac.abort();
  let name = "";
  try { for await (const _ of streamSSE({ url: "http://127.0.0.1:0/never", headers: {}, body: "{}", signal: ac.signal })) { /* unreachable */ } }
  catch (e) { name = (e as Error).name; }
  check("streamSSE: aborted signal throws AbortError before fetching", name === "AbortError");
}

// --- registry ---
check("registry: qwen3.6-plus ceiling > old 4096 default", maxOutputFor("qwen/qwen3.6-plus") > 4096);
check("registry: claude sonnet ceiling is large", maxOutputFor("claude-sonnet-4-6") >= 32000);
check("registry: unknown model → generous default", maxOutputFor("totally-made-up-model") === DEFAULT_MAX_OUTPUT);
check("registry: describeModel returns a string", typeof describeModel("qwen/qwen3.6-plus") === "string" && describeModel("qwen/qwen3.6-plus").includes("output"));

// --- reasoning capability (per-model surfacing) ---
check("capability: known reasoning model takes effort", supportsEffort("qwen/qwen3.6-plus") && supportsEffort("anthropic/claude-opus-4.8"));
check("capability: unknown model gets effort on benefit of the doubt", supportsEffort("totally-made-up-model"));
check("capability: GPT reasons but hides its trace", modelReasoning("openai/gpt-5.5")?.effort === true && reasoningVisible("openai/gpt-5.5") === false);
check("capability: open reasoners return a visible trace", reasoningVisible("deepseek/deepseek-v4-pro") && reasoningVisible("x-ai/grok-4.3"));
check("describeModel: notes reasoning capability", describeModel("qwen/qwen3.6-plus").includes("reasoning") && describeModel("openai/gpt-5.5").includes("trace hidden"));

// --- router aliases: graceful display instead of "unknown model" ---
check("isRouterModel: recognizes auto/router/default, not concrete ids",
  isRouterModel("auto") && isRouterModel(" Router ") && isRouterModel("default") && !isRouterModel("qwen/qwen3.6-plus"));
check("describeModel: router alias is 'provider-routed', never 'unknown model'",
  describeModel("auto").includes("provider-routed") && !describeModel("auto").includes("unknown"));
// no-stutter: descriptions must NOT lead with the id (callers print the id separately → "auto — auto —")
check("describeModel: does not repeat the id (no 'auto —' stutter)", !describeModel("auto").startsWith("auto"));
check("describeModel: unknown model does not repeat the id", !describeModel("totally-made-up").startsWith("totally-made-up"));

// --- proxy quirk (a free-tier `auto` router): capture the resolved model + estimate tokens when usage is absent ---
{
  // A local SSE server we fully control: /nousage echoes a resolved model but NEVER sends a usage chunk
  // (the proxy quirk); /withusage sends a real usage chunk. callOpenAI must estimate in the first case.
  const sse = (objs: object[]) =>
    new Response(objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({ port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.includes("nousage")) return sse([
      { model: "deepseek/deepseek-v4-pro", choices: [{ delta: { content: "Hello" } }] },
      { model: "deepseek/deepseek-v4-pro", choices: [{ delta: { content: " world" }, finish_reason: "stop" }] },
    ]);
    // proxy returns a literal "None" as the text of a tool-calling step (the free-tier null artifact)
    if (path.includes("nullwithtool")) return sse([
      { choices: [{ delta: { content: "None" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run_bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    ]);
    // a legitimate one-word "None" answer (no tool calls) — must be preserved
    if (path.includes("nulltext")) return sse([
      { choices: [{ delta: { content: "None" }, finish_reason: "stop" }] },
    ]);
    // OpenRouter cache hit: cached_tokens is a SUBSET of prompt_tokens — input_tokens must be the
    // UNCACHED remainder, with the cached portion surfaced as cache_read (not double-counted).
    if (path.includes("cached")) return sse([
      { model: "anthropic/claude-sonnet-4.6", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 10339, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 0 } }, choices: [] },
    ]);
    return sse([
      { model: "qwen/qwen3.6-plus", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 123, completion_tokens: 45 }, choices: [] },
    ]);
  } });
  const baseCall = { provider: "openai" as const, apiKey: "x", model: "auto",
    system: "a system prompt of some length", messages: [{ role: "user" as const, content: "hello there friend" }] };

  const r1 = await callOpenAI({ ...baseCall, baseUrl: `http://localhost:${server.port}/nousage` });
  check("callOpenAI: captures the model the proxy resolved `auto` to", r1.model === "deepseek/deepseek-v4-pro");
  check("callOpenAI: estimates tokens when the proxy omits usage (no misleading 0)",
    r1.usage?.estimated === true && (r1.usage?.input_tokens ?? 0) > 0 && (r1.usage?.output_tokens ?? 0) > 0);

  const r2 = await callOpenAI({ ...baseCall, baseUrl: `http://localhost:${server.port}/withusage` });
  check("callOpenAI: uses the proxy's real usage when present (not estimated)",
    r2.usage?.input_tokens === 123 && r2.usage?.output_tokens === 45 && !r2.usage?.estimated);
  check("callOpenAI: resolved model captured alongside real usage", r2.model === "qwen/qwen3.6-plus");

  const rc = await callOpenAI({ ...baseCall, baseUrl: `http://localhost:${server.port}/cached` });
  check("callOpenAI: cached_tokens subtracted from input (no double-count), surfaced as cache-read",
    rc.usage?.input_tokens === 21 && rc.usage?.cache_read_input_tokens === 10318 && !rc.usage?.estimated);

  // null-artifact: a bare "None" accompanying tool calls is dropped (not streamed, not stored)…
  let streamed3 = "";
  const r3 = await callOpenAI({ ...baseCall, baseUrl: `http://localhost:${server.port}/nullwithtool`, onText: (d) => { streamed3 += d; } });
  const r3text = r3.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  check("callOpenAI: drops a bare 'None' that accompanies tool calls (artifact)", r3text === "" && streamed3 === "" && r3.content.some((b) => b.type === "tool_use"));
  // …but a standalone "None" answer (no tool calls) is preserved
  let streamed4 = "";
  const r4 = await callOpenAI({ ...baseCall, baseUrl: `http://localhost:${server.port}/nulltext`, onText: (d) => { streamed4 += d; } });
  const r4text = r4.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  check("callOpenAI: keeps a standalone 'None' answer (no tool calls)", r4text === "None" && streamed4 === "None");

  server.stop(true);
}

// --- vision capability registry ---
// Verified multimodal against the live catalog: Claude / GPT / Gemini / Grok, plus the DEFAULT Qwen 3.6
// Plus (OpenRouter lists image input). NOT marked: GLM 5.2 (vision lives in the separate GLM-*V line, not
// this text model) and DeepSeek V4 (multimodal on paper, but image input isn't exposed via the API yet).
check("vision: known multimodal flagships are vision-capable (incl. default Qwen)", modelSupportsVision("anthropic/claude-opus-4.8") && modelSupportsVision("openai/gpt-5.5") && modelSupportsVision("google/gemini-3.1-pro-preview") && modelSupportsVision("x-ai/grok-4.3") && modelSupportsVision("qwen/qwen3.6-plus"));
check("vision: text-only-via-API families stay false (DeepSeek V4, GLM 5.2 text model)", modelSupportsVision("deepseek/deepseek-v4-pro") === false && modelSupportsVision("z-ai/glm-5.2") === false);
check("vision: unknown model + router alias → false (never send an image to a text-only model)", modelSupportsVision("totally-made-up") === false && modelSupportsVision("auto") === false);
check("vision: visionEnabled mirrors capability when no override", visionEnabled("anthropic/claude-opus-4.8") === true && visionEnabled("auto") === false);
{
  const prev = process.env.OB1_FORCE_VISION;
  process.env.OB1_FORCE_VISION = "1";
  check("vision: OB1_FORCE_VISION=1 forces images even on unknown/router models", visionEnabled("auto") === true && visionEnabled("totally-made-up") === true);
  if (prev === undefined) delete process.env.OB1_FORCE_VISION; else process.env.OB1_FORCE_VISION = prev;
}

// --- image tool_result translation: a browser_check screenshot rides through both providers ---
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // 1x1 png
const imgHistory: Message[] = [
  { role: "assistant", content: [{ type: "tool_use", id: "bc1", name: "browser_check", input: { url: "http://localhost:8000/" } }] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "bc1", content: [
      { type: "text", text: "✓ browser_check PASSED — http://localhost:8000/" },
      { type: "image", source: { data: PNG_B64, mediaType: "image/png" } },
    ] },
  ] },
];

// OpenAI (vision ON): the tool message carries the TEXT; the image rides in a FOLLOWING user message
// as an image_url data: URL (the OpenAI format forbids images on a `tool` message).
const oaVis = toOpenAIMessages("sys", imgHistory, false, true);
const oaTool = oaVis.find((m) => m.role === "tool") as any;
const oaUser = oaVis.find((m) => m.role === "user") as any;
check("openai vision: tool message keeps the text report (no image on a tool message)",
  oaTool?.content === "✓ browser_check PASSED — http://localhost:8000/" && typeof oaTool.content === "string");
check("openai vision: image re-emitted as an image_url data: URL in a trailing user message",
  Array.isArray(oaUser?.content) && oaUser.content.some((p: any) => p.type === "image_url" && p.image_url.url === `data:image/png;base64,${PNG_B64}`));
check("openai vision: trailing user message order is [text marker, image] after the tool message",
  oaVis.indexOf(oaTool) < oaVis.indexOf(oaUser) && oaUser.content.some((p: any) => p.type === "text"));

// OpenAI (vision OFF): NO image_url anywhere; the screenshot degrades to a text placeholder on the tool msg.
const oaNo = toOpenAIMessages("sys", imgHistory, false, false);
check("openai non-vision: no image_url part is emitted (won't 400 a text-only model)",
  JSON.stringify(oaNo).indexOf("image_url") === -1);
check("openai non-vision: tool message notes the screenshot was omitted",
  (oaNo.find((m) => m.role === "tool") as any)?.content.includes("screenshot omitted"));

// A plain-string tool_result is untouched by the image path (the overwhelmingly-common case).
const plainTR = toOpenAIMessages("sys", [
  { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "export const x = 1;" }] },
], false, true);
check("string tool_result unaffected: stays a single tool message, no extra user/image message",
  plainTR.filter((m) => m.role === "tool").length === 1 && plainTR.filter((m) => m.role === "user").length === 0);

if (fail) { console.error("\n✗ provider smoke FAILED"); process.exit(1); }
console.log("\n✓ provider smoke passed (OpenAI-compatible route + model-governed max_tokens + registry + router/estimate + vision/images)");
