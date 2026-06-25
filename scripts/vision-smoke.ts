// Deterministic test for the vision/image path end-to-end (no API key, no Chromium). Proves the data
// path a browser_check screenshot travels: a tool's {text, images} return → normalizeToolOutput →
// toolResultContent (a tool_result content-block array) → each provider's wire format, gated by whether
// the active model can see images. The Chromium capture itself is covered by browser-check-smoke; the
// per-provider translation by provider-smoke. This ties the seams together. Run: bun run scripts/vision-smoke.ts
import { normalizeToolOutput, toolResultContent, screenshotMode, shouldAttachScreenshot, type ToolOutput } from "../src/agent/tools.ts";
import { toOpenAIMessages } from "../src/providers/openai.ts";
import { toAnthropicMessages } from "../src/providers/anthropic.ts";
import { visionEnabled } from "../src/providers/models.ts";
import type { Message, ImageSource } from "../src/providers/types.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const img: ImageSource = { data: PNG_B64, mediaType: "image/png" };

// ── normalizeToolOutput: the seam that lets a tool return either a string or {text, images} ──
check("normalize: a plain string → text only, no images", (() => {
  const n = normalizeToolOutput("hello");
  return n.text === "hello" && n.images === undefined;
})());
check("normalize: a {text, images} result → both preserved", (() => {
  const n = normalizeToolOutput({ text: "report", images: [img] });
  return n.text === "report" && n.images?.length === 1 && n.images[0].data === PNG_B64;
})());
check("normalize: a {text} with no images → images undefined (not an empty array)", (() => {
  const n = normalizeToolOutput({ text: "just text" });
  return n.text === "just text" && n.images === undefined;
})());
check("normalize: an empty images array is treated as none", normalizeToolOutput({ text: "x", images: [] }).images === undefined);
check("normalize: an unexpected non-string/non-result → String()'d, never '[object Object]' from a tool", (() => {
  const n = normalizeToolOutput(42 as unknown as ToolOutput);
  return n.text === "42" && n.images === undefined;
})());

// ── toolResultContent: assemble the tool_result content the loop pushes into history ──
check("assemble: text-only → a plain STRING (lean wire for the common case)", typeof toolResultContent("only text") === "string");
check("assemble: text + image → a content-block array [text, image]", (() => {
  const c = toolResultContent("report", [img]);
  return Array.isArray(c) && c.length === 2 && c[0].type === "text" && c[1].type === "image" && (c[1] as any).source.data === PNG_B64;
})());
check("assemble: empty text + image → just the image block (no empty text block)", (() => {
  const c = toolResultContent("", [img]) as any[];
  return Array.isArray(c) && c.length === 1 && c[0].type === "image";
})());

// ── end-to-end: tool return → tool_result content → provider wire, both vision states ──
const toolReturn: ToolOutput = { text: "✓ browser_check PASSED — http://localhost:8000/", images: [img] };
const { text, images } = normalizeToolOutput(toolReturn);
const history: Message[] = [
  { role: "assistant", content: [{ type: "tool_use", id: "bc1", name: "browser_check", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "bc1", content: toolResultContent(text, images) }] },
];

// Vision model (e.g. Opus): image survives to BOTH wire formats.
check("e2e vision: model is vision-enabled (Opus)", visionEnabled("anthropic/claude-opus-4.8") === true);
const oa = toOpenAIMessages("sys", history, false, true);
check("e2e vision (openai): a data: image_url part reaches the wire", JSON.stringify(oa).includes(`data:image/png;base64,${PNG_B64}`));
const an = toAnthropicMessages(history, true);
check("e2e vision (anthropic): a base64 image source reaches the wire", JSON.stringify(an).includes(PNG_B64) && JSON.stringify(an).includes("\"base64\""));

// The default Qwen 3.6 Plus IS multimodal (OpenRouter: accepts image input) → vision on by default.
check("e2e: default Qwen 3.6 Plus is vision-enabled (multimodal)", visionEnabled("qwen/qwen3.6-plus") === true);
// Non-vision model (DeepSeek V4 — multimodal on paper, but image input not exposed via the API): the
// screenshot degrades to a text note; NO base64 on the wire.
check("e2e non-vision: a text-only-via-API model (DeepSeek) is not vision-enabled", visionEnabled("deepseek/deepseek-v4-pro") === false);
const oaNo = toOpenAIMessages("sys", history, false, false);
const anNo = toAnthropicMessages(history, false);
check("e2e non-vision (openai): no image bytes, a 'screenshot omitted' note instead",
  !JSON.stringify(oaNo).includes(PNG_B64) && JSON.stringify(oaNo).includes("screenshot omitted"));
check("e2e non-vision (anthropic): no image bytes, a 'screenshot omitted' note instead",
  !JSON.stringify(anNo).includes(PNG_B64) && JSON.stringify(anNo).includes("screenshot omitted"));
check("e2e: the PASSED text report survives in BOTH vision states + both providers", (() => {
  const needle = "browser_check PASSED";
  return [oa, an, oaNo, anNo].every((wire) => JSON.stringify(wire).includes(needle));
})());

// ── cost-aware screenshot policy (browser_check) ──
check("mode: omitted/unknown → 'auto' (the cost-aware default)", screenshotMode(undefined) === "auto" && screenshotMode("weird") === "auto" && screenshotMode("auto") === "auto");
check("mode: legacy boolean true → 'always', false → 'off' (back-compat)", screenshotMode(true) === "always" && screenshotMode(false) === "off");
check("mode: synonyms map sensibly (on/always vs off/none/never)", screenshotMode("on") === "always" && screenshotMode("none") === "off" && screenshotMode("never") === "off");

// auto = attach ONLY on failure; always = attach whenever vision; off / no-vision = never.
check("attach: auto + PASS + vision → NO image (don't burn tokens on a passing check)", shouldAttachScreenshot("auto", true, true) === false);
check("attach: auto + FAIL + vision → image attached (model needs to SEE the failure)", shouldAttachScreenshot("auto", true, false) === true);
check("attach: always + PASS + vision → image attached every time", shouldAttachScreenshot("always", true, true) === true);
check("attach: off → never, even on failure with a vision model", shouldAttachScreenshot("off", true, false) === false);
check("attach: no vision model → never attach, regardless of mode/result", shouldAttachScreenshot("always", false, false) === false && shouldAttachScreenshot("auto", false, false) === false);

if (fail) { console.error("\n✗ vision smoke FAILED"); process.exit(1); }
console.log("\n✓ vision smoke passed (normalize + assemble + end-to-end image path + screenshot policy, vision-gated, both providers)");
process.exit(0);
