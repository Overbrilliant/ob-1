// Model registry — "model descriptions": context window + output ceiling per model family.
//
// Why this exists: output length should be governed by the MODEL, not a global constant. For the
// OpenAI-compatible path we OMIT max_tokens entirely so the provider/model decides unless the user
// explicitly sets OB1_MAX_TOKENS. Values are best-effort by family and matched by regex so new
// snapshots (...-2507, etc.) resolve without edits.
export interface ModelSpec {
  match: RegExp;
  id?: string;           // canonical model id the managed OB-1 API routes to when picked from /models
  label: string;
  contextWindow: number; // input tokens
  maxOutput: number;     // output-token ceiling (the model's, not ours)
  inPrice?: number;      // best-effort USD per 1M input tokens (for the live cost meter)
  outPrice?: number;     // best-effort USD per 1M output tokens
  /** Reasoning/thinking capability (verified against the live OpenRouter catalog, June 2026).
   *   effort  — accepts low/medium/high reasoning effort (OpenRouter maps effort→token budget);
   *   visible — streams its reasoning trace back, so the Ctrl+O panel can show it. OpenAI's
   *             GPT/o-series reason but DON'T return the trace → visible:false. Field omitted ⇒ the
   *             model has no reasoning support at all. */
  reasoning?: { effort: boolean; visible: boolean };
  /** Accepts image input (multimodal). Drives whether browser_check attaches a screenshot the model can
   *  SEE vs. just the file path. Set ONLY for families verified multimodal against the live catalog —
   *  sending an image to a text-only model is a hard API error, so the default (omitted ⇒ false) is the
   *  safe one. Unknown/router models default to false too; OB1_FORCE_VISION=1 overrides for power users. */
  vision?: boolean;
  notes?: string;
}

// The current top frontier models — one flagship per major lab — plus the default Qwen. Served by the
// managed OB-1 server on the user's subscription credits. Context window, output ceiling and pricing are
// the providers' REAL values, verified against the live catalog (June 2026). Matched by regex so newer
// snapshots of the same family resolve without edits; the default `qwen/qwen3.6-plus` matches the last entry.
export const MODELS: ModelSpec[] = [
  { match: /claude.*opus|claude-opus/i,     id: "anthropic/claude-opus-4.8",      label: "Claude Opus 4.8",   contextWindow: 1_000_000, maxOutput: 128_000, inPrice: 5,    outPrice: 25, reasoning: { effort: true, visible: true }, vision: true },
  { match: /claude.*sonnet|claude-sonnet/i, id: "anthropic/claude-sonnet-4.6",    label: "Claude Sonnet 4.6", contextWindow: 1_000_000, maxOutput: 128_000, inPrice: 3,    outPrice: 15, reasoning: { effort: true, visible: true }, vision: true },
  { match: /gpt-5/i,                         id: "openai/gpt-5.5",                 label: "GPT-5.5",           contextWindow: 1_050_000, maxOutput: 128_000, inPrice: 5,    outPrice: 30, reasoning: { effort: true, visible: false }, vision: true },
  { match: /gemini/i,                        id: "google/gemini-3.1-pro-preview",  label: "Gemini 3.1 Pro",    contextWindow: 1_048_576, maxOutput: 65_536,  inPrice: 2,    outPrice: 12, reasoning: { effort: true, visible: true }, vision: true },
  { match: /grok/i,                          id: "x-ai/grok-4.3",                  label: "Grok 4.3",          contextWindow: 1_000_000, maxOutput: 64_000,  inPrice: 1.25, outPrice: 2.5, reasoning: { effort: true, visible: true }, vision: true },
  { match: /glm|z-ai/i,                      id: "z-ai/glm-5.2",                   label: "GLM 5.2",           contextWindow: 1_048_576, maxOutput: 131_072, inPrice: 1.2,  outPrice: 4.1, reasoning: { effort: true, visible: true } },
  { match: /deepseek/i,                      id: "deepseek/deepseek-v4-pro",       label: "DeepSeek V4 Pro",   contextWindow: 1_048_576, maxOutput: 384_000, inPrice: 0.43, outPrice: 0.87, reasoning: { effort: true, visible: true } },
  { match: /qwen/i,                          id: "qwen/qwen3.6-plus",              label: "Qwen 3.6 Plus",     contextWindow: 1_000_000, maxOutput: 65_536,  inPrice: 0.33, outPrice: 1.95, reasoning: { effort: true, visible: true }, vision: true, notes: "default" },
];

/** Default output ceiling for an unknown model — generous, so we don't truncate large artifacts. */
export const DEFAULT_MAX_OUTPUT = 16_384;

/** Conservative context-window fallback (input tokens) for an unknown/custom/local model — chosen as a
 *  safe floor so adaptive compaction doesn't assume a window the endpoint may not actually have. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function modelSpec(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.match.test(id));
}

/** A router alias — not a concrete model, but an instruction for the proxy to pick one per request
 *  (the free router's default). The real model is only known once a response comes back (ModelResponse.model). */
export function isRouterModel(id: string): boolean {
  return /^(auto|router|default)$/i.test(id.trim());
}

/** The model's output ceiling. Used for descriptions and explicit caps; the OpenAI-compatible path
 *  omits max_tokens unless the user explicitly sets OB1_MAX_TOKENS. */
export function maxOutputFor(id: string): number {
  return modelSpec(id)?.maxOutput ?? DEFAULT_MAX_OUTPUT;
}

/** The model's input context window in tokens. Best-effort by family; falls back to a conservative
 *  window for unknown/custom/router ids. Used to scale context compaction to the active model. */
export function contextWindowFor(id: string): number {
  return modelSpec(id)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** A model's reasoning capability, or undefined when it has none / is unknown. */
export function modelReasoning(id: string): { effort: boolean; visible: boolean } | undefined {
  return modelSpec(id)?.reasoning;
}

/** Whether to attach a reasoning-effort param for this model. Known reasoning models with effort:true →
 *  yes; known models without reasoning support → no; UNKNOWN ids (the free router's `auto`, an arbitrary proxy
 *  model) → yes on the benefit of the doubt — the effort param is harmlessly ignored by models that
 *  don't reason, and `auto` routers strip it upstream anyway. */
export function supportsEffort(id: string): boolean {
  const s = modelSpec(id);
  if (!s) return true;                 // unknown → send it; ignored if unsupported
  return s.reasoning?.effort ?? false; // known → only when the registry says it takes effort
}

/** Whether the model streams its reasoning trace back (so the Ctrl+O panel can show it). Unknown ids
 *  are assumed visible — most open reasoning models return the trace; only OpenAI's o-series hide it. */
export function reasoningVisible(id: string): boolean {
  const s = modelSpec(id);
  if (!s) return true;
  return s.reasoning?.visible ?? false;
}

/** Whether the model accepts image input. KNOWN multimodal model → true; known text-only model, an
 *  unknown id, or a router alias → false (the safe default: sending an image to a text-only model is a
 *  hard API error). The OB1_FORCE_VISION escape hatch is applied by visionEnabled(), not here. */
export function modelSupportsVision(id: string): boolean {
  return modelSpec(id)?.vision ?? false;
}

/** Power-user override: force image attachment even on a model the registry doesn't know is multimodal
 *  (e.g. a fresh snapshot, or an `auto` router you know resolves to a vision model). Read per-call. */
export function visionForced(): boolean {
  return process.env.OB1_FORCE_VISION === "1";
}

/** The single decision used by both the tool layer (attach a screenshot?) and the providers (translate
 *  vs. strip image blocks): attach images iff the model is known-multimodal OR the override is set. */
export function visionEnabled(id: string): boolean {
  return visionForced() || modelSupportsVision(id);
}

/** Best-effort USD cost estimate for a token count (0 when the model's pricing is unknown). */
export function estimateCost(id: string, inTok: number, outTok: number): number {
  const s = modelSpec(id);
  if (!s?.inPrice || !s.outPrice) return 0;
  return (inTok / 1_000_000) * s.inPrice + (outTok / 1_000_000) * s.outPrice;
}

/** Whether the price table has a real USD rate for this model. When false, estimateCost() returns 0 —
 *  NOT because the run was free but because we can't price a custom/LAN/unknown model. Lets /usage show
 *  "n/a" instead of a misleading $0.00 for those rows. */
export function hasKnownPricing(id: string): boolean {
  const s = modelSpec(id);
  return !!(s?.inPrice && s.outPrice);
}

// NOTE: the description does NOT lead with the model id — every caller already prints the id
// separately (e.g. `model: ${id} — ${describeModel(id)}`), so repeating it here produced the
// "auto — auto — …" stutter. Return only the descriptive part.
export function describeModel(id: string): string {
  const s = modelSpec(id);
  if (s) {
    const r = s.reasoning
      ? ` · reasoning (effort${s.reasoning.visible ? "" : ", trace hidden"})`
      : " · no reasoning";
    return `${s.label} — ${(s.contextWindow / 1000).toFixed(0)}k context · ${(s.maxOutput / 1000).toFixed(0)}k max output${r}`;
  }
  if (isRouterModel(id)) return `provider-routed (the proxy picks a model per request; output governed by the chosen model)`;
  return `unknown model (defaults: model-governed output; ${(DEFAULT_MAX_OUTPUT / 1000).toFixed(0)}k cap only where required)`;
}
