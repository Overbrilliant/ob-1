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
  /** When true, the API key is OPTIONAL: a local/LAN OpenAI-compatible server (Ollama, llama.cpp, vLLM,
   *  LM Studio, …) usually needs none. The setup form lets you Save with a blank key, no Authorization
   *  header is sent on the wire, and the keyless profile is persisted + restored across restarts. */
  keyOptional?: boolean;
  /** When true, the setup form asks you to TYPE the model id instead of picking from a fetched catalog —
   *  a local endpoint may not expose a queryable /models list, and you usually know the exact name. The
   *  typed value becomes the active model. */
  needsModel?: boolean;
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

// Custom endpoint — ANY OpenAI-compatible server you run yourself. The escape hatch for a local/LAN model
// (Ollama, llama.cpp `server`, vLLM, LM Studio, text-generation-webui, …): you give OB-1 the endpoint URL
// and the model id, and the key is OPTIONAL because most of these need no auth. Unlike FreeLLMAPI it does
// NOT assume a queryable catalog — you TYPE the model name (needsModel), so it works against a server that
// only exposes /chat/completions.
export const CUSTOM: ProviderProfile = {
  id: "custom",
  name: "Custom endpoint",
  tagline: "Any OpenAI-compatible server you run — local or LAN (Ollama, llama.cpp, vLLM, LM Studio…)",
  blurb: [
    "Point OB-1 at your OWN OpenAI-compatible endpoint — a model running on this machine or another",
    "host on your network (e.g. a GPU box). Works with Ollama, llama.cpp's server, vLLM, LM Studio,",
    "text-generation-webui, and anything else that speaks the OpenAI /chat/completions API.",
    "",
    "Enter the endpoint URL (…/v1) and the exact model id the server serves. The API key is OPTIONAL —",
    "leave it blank for a server with no auth; fill it in only if yours requires a token.",
  ],
  wire: "openai",
  docsUrl: "https://platform.openai.com/docs/api-reference/chat",
  defaultLocalUrl: "http://localhost:11434/v1", // Ollama's default — the most common local server
  defaultModel: "",                              // you type the model id (needsModel)
  keyOptional: true,
  needsModel: true,
  presets: [
    { label: "Local", hint: "the server runs on this machine (Ollama default :11434)", url: "http://localhost:11434/v1" },
    { label: "LAN / Remote", hint: "the server runs on another host — paste http://<ip>:<port>/v1", url: "http://" },
  ],
};

// The frontier (paid) models are NOT a user-configurable provider profile: they're served by the managed
// OB-1 server on the user's subscription credits (see config.ts resolveProvider's managed-server path and
// index.ts switchToManaged). The client never asks the user for an upstream gateway key — picking a
// frontier model from /models just switches the active model on the managed server. The user-facing
// provider profiles are the self-hosted FreeLLMAPI proxy and a bring-your-own Custom endpoint.
export const PROFILES: ProviderProfile[] = [FREELLMAPI, CUSTOM];

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
    // Send Authorization only when there IS a key — a keyless local/LAN server (Custom endpoint) must not
    // be probed with a bogus `Bearer ` header, which some strict servers reject outright.
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/models`, { headers, signal: ac.signal });
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
