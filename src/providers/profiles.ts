// Provider profiles — named, OpenAI-compatible providers OB-1 can be pointed at via the /models setup
// tab. A profile is pure METADATA + an endpoint: the wire path is the existing OpenAI-compatible
// provider (callOpenAI), so "adding a provider" is describing it well + persisting its URL/key, not a
// new protocol. The flagship is FreeLLMAPI.
//
// FreeLLMAPI (github.com/tashfeenahmed/freellmapi) is a self-hosted proxy that aggregates the FREE
// tiers of ~16 LLM providers behind ONE OpenAI-compatible endpoint. The user runs the server (Docker
// or Node) locally or on a remote host and hands OB-1 just the proxy URL + a bearer token.

export interface ProviderProfile {
  /** Stable key persisted as settings.providerProfile. */
  id: string;
  name: string;
  /** One-line "what it is", shown at the top of the setup tab + in listings. */
  tagline: string;
  /** Multi-line explanation shown in the setup tab so users know what they're connecting to. */
  blurb: string[];
  /** Internal Provider used on the wire (FreeLLMAPI speaks OpenAI Chat Completions). */
  wire: "openai";
  docsUrl: string;
  /** Typical self-hosted endpoint (prefilled for the "Local" preset). */
  defaultLocalUrl: string;
  /** Token prefix hint (NOT enforced — just shown so a wrong paste is obvious). */
  keyPrefix?: string;
  /** Sensible default model id; FreeLLMAPI's `auto` lets its own router pick the best free model. */
  defaultModel: string;
  /** Location presets offered as the first row of the setup form. */
  presets: { label: string; hint: string; url: string }[];
}

export const FREELLMAPI: ProviderProfile = {
  id: "freellmapi",
  name: "FreeLLMAPI",
  tagline: "One OpenAI-compatible endpoint · ~16 free LLM providers stacked (~1.7B tokens/mo)",
  blurb: [
    "FreeLLMAPI is a self-hosted proxy that aggregates the FREE tiers of ~16 LLM providers",
    "(Gemini, Groq, Cerebras, Mistral, GitHub Models, Cohere, …) behind ONE",
    "OpenAI-compatible endpoint — ~1.7B tokens/month with no per-provider rate-limit juggling.",
    "",
    "You run the server (Docker / Node) on this machine or a remote host; OB-1 just points at it.",
    "Your provider keys stay encrypted inside the server — OB-1 only needs the proxy URL + token.",
  ],
  wire: "openai",
  docsUrl: "https://github.com/tashfeenahmed/freellmapi",
  defaultLocalUrl: "http://localhost:3001/v1",
  keyPrefix: "freellmapi-",
  defaultModel: "auto",
  presets: [
    { label: "Local", hint: "the server runs on this machine (default :3001)", url: "http://localhost:3001/v1" },
    { label: "Remote", hint: "the server runs on another host — paste its URL", url: "https://" },
  ],
};

// The frontier (paid) models are NOT a user-configurable provider profile: they're served by the managed
// OB-1 server on the user's subscription credits (see config.ts resolveProvider's managed-server path and
// index.ts switchToManaged). The client never asks the user for an upstream gateway key — picking a
// frontier model from /models just switches the active model on the managed server. So the only
// user-facing provider profile is the self-hosted FreeLLMAPI proxy.
export const PROFILES: ProviderProfile[] = [FREELLMAPI];

export function profileById(id?: string): ProviderProfile | undefined {
  return id ? PROFILES.find((p) => p.id === id) : undefined;
}

/** Forgiving base-URL normalization so paste-what-you-have works: add a scheme (http for bare hosts —
 *  local servers are plain http), strip trailing slashes, drop a pasted endpoint path (…/chat/completions),
 *  and append `/v1` when the user gave only a host (FreeLLMAPI mounts the API there). Pure + tested. */
export function normalizeBaseUrl(raw: string): string {
  let u = (raw ?? "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "http://" + u; // bare host → assume http (the local default)
  u = u.replace(/\/+$/, "");                         // strip trailing slashes
  u = u.replace(/\/(chat\/completions|completions|responses|embeddings|models)$/i, ""); // drop a pasted endpoint
  u = u.replace(/\/+$/, "");
  const m = u.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);  // host with no path → append /v1
  if (m && !(m[2] && m[2].replace(/\/+$/, ""))) u = m[1] + "/v1";
  return u;
}

export interface ModelInfo { id: string; name?: string; contextWindow?: number; available?: boolean }
export interface ConnResult { ok: boolean; status: number; models: ModelInfo[]; error?: string }

/** Connectivity + capability probe: GET {baseUrl}/models with the bearer token. Used by the setup
 *  tab's "Test connection" action and to populate the post-setup model picker. Never throws — returns
 *  a structured result (ok=false carries status + a short error) so the UI can show a clean line. */
export async function fetchModels(baseUrl: string, apiKey: string, timeoutMs = 12_000): Promise<ConnResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: ac.signal,
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, status: res.status, models: [], error: body.slice(0, 300) || res.statusText };
    let json: any;
    try { json = JSON.parse(body); } catch { return { ok: false, status: res.status, models: [], error: "non-JSON response from /models" }; }
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const models: ModelInfo[] = data
      .map((m: any) => ({ id: String(m?.id ?? ""), name: m?.name, contextWindow: m?.context_window ?? m?.context_length, available: m?.available }))
      .filter((m: ModelInfo) => m.id);
    return { ok: true, status: res.status, models };
  } catch (e: any) {
    const error = e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : (e?.message ?? "connection failed");
    return { ok: false, status: 0, models: [], error };
  } finally {
    clearTimeout(timer);
  }
}
