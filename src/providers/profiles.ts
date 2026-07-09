// Provider profiles — named, OpenAI-compatible providers OB-1 can be pointed at via the /models setup
// tab. A profile is pure METADATA + an endpoint: the wire path is the existing OpenAI-compatible
// provider (callOpenAI), so "adding a provider" is describing it well + persisting its URL/key, not a
// new protocol. The flagship is FREE — the embedded free-models router (src/providers/free), which has
// no URL/key to enter (see its `embedded` flag below); every other profile is a URL + optional key.

export interface ProviderProfile {
  /** Stable key persisted as settings.providerProfile. */
  id: string;
  name: string;
  /** One-line "what it is", shown at the top of the setup tab + in listings. */
  tagline: string;
  /** Multi-line explanation shown in the setup tab so users know what they're connecting to. */
  blurb: string[];
  /** Internal Provider used on the wire (every profile speaks OpenAI Chat Completions). */
  wire: "openai";
  docsUrl: string;
  /** Typical self-hosted endpoint (prefilled for the "Local" preset). */
  defaultLocalUrl: string;
  /** Token prefix hint (NOT enforced — just shown so a wrong paste is obvious). */
  keyPrefix?: string;
  /** Sensible default model id; the free router's `auto` lets it pick the best available free model. */
  defaultModel: string;
  /** Location presets offered as the first row of the setup form. */
  presets: { label: string; hint: string; url: string }[];
  /** Well-known environment keys for this provider. Used by onboarding/docs only; never persisted. */
  envKeys?: string[];
  /** When true, the API key is OPTIONAL: a local/LAN OpenAI-compatible server (Ollama, llama.cpp, vLLM,
   *  LM Studio, …) usually needs none. The setup form lets you Save with a blank key, no Authorization
   *  header is sent on the wire, and the keyless profile is persisted + restored across restarts. */
  keyOptional?: boolean;
  /** When true, the setup form asks you to TYPE the model id instead of picking from a fetched catalog —
   *  a local endpoint may not expose a queryable /models list, and you usually know the exact name. The
   *  typed value becomes the active model. */
  needsModel?: boolean;
  /** When true, this profile is the EMBEDDED in-process route (the free-models router). There is no URL/key
   *  to enter — the wire path is `provider:"free"` (src/providers/free), configured via the keys file. */
  embedded?: boolean;
}

// Free models — the EMBEDDED router (src/providers/free). Unlike every other profile there is no server to
// run, no URL, and no single key: OB-1 routes across a signed free-model catalog in-process, activated by
// one editable keys file (keyless providers work with nothing at all). The wire provider is "free", not
// "openai" — callFree picks a concrete OpenAI-compatible endpoint per request. defaultModel "auto" ⇒
// strategy routing; keyOptional (keyless providers need none); needsModel false (never type a model id).
export const FREE: ProviderProfile = {
  id: "free",
  name: "Free models",
  tagline: "Signed free-model catalog — keys optional, routed automatically",
  blurb: [
    "OB-1 routes across a signed free-model catalog in-process — no server, no second process. Free",
    "users get newly released free models after 30 days; hosted subscribers get them immediately.",
    "Keyless providers work with zero setup, and you can add your own provider keys for higher limits.",
    "",
    "Every request is routed to the best available model for your chosen strategy, with automatic",
    "failover, rate-limit tracking, and cooldowns. Keys never leave this machine except to call the",
    "provider directly.",
  ],
  wire: "openai",
  docsUrl: "https://github.com/Overbrilliant/ob-1",
  defaultLocalUrl: "",
  defaultModel: "auto",
  keyOptional: true,
  needsModel: false,
  embedded: true,
  presets: [],
};

// Custom endpoint — ANY OpenAI-compatible server you run yourself. The escape hatch for a local/LAN model
// (Ollama, llama.cpp `server`, vLLM, LM Studio, text-generation-webui, …): you give OB-1 the endpoint URL
// and the model id, and the key is OPTIONAL because most of these need no auth. Unlike a hosted gateway it
// does NOT assume a queryable catalog — you TYPE the model name (needsModel), so it works against a server
// that only exposes /chat/completions.
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
  defaultModel: "", // you type the model id (needsModel)
  keyOptional: true,
  needsModel: true,
  presets: [
    {
      label: "Local",
      hint: "the server runs on this machine (Ollama default :11434)",
      url: "http://localhost:11434/v1",
    },
    { label: "LAN / Remote", hint: "the server runs on another host — paste http://<ip>:<port>/v1", url: "http://" },
  ],
};

export const OPENROUTER: ProviderProfile = {
  id: "openrouter",
  name: "OpenRouter",
  tagline: "Bring your own OpenRouter key for 300+ hosted models",
  blurb: [
    "Use your own OpenRouter account and key. OB-1 talks to OpenRouter through the same",
    "OpenAI-compatible route as every other provider, but your billing and limits stay with OpenRouter.",
    "",
    "Set OPENROUTER_API_KEY for a runtime-only route, or save this profile from /models.",
  ],
  wire: "openai",
  docsUrl: "https://openrouter.ai/docs",
  defaultLocalUrl: "https://openrouter.ai/api/v1",
  keyPrefix: "sk-or-",
  defaultModel: "qwen/qwen3.6-plus",
  envKeys: ["OPENROUTER_API_KEY"],
  presets: [{ label: "OpenRouter", hint: "hosted OpenAI-compatible gateway", url: "https://openrouter.ai/api/v1" }],
};

export const OLLAMA: ProviderProfile = {
  id: "ollama",
  name: "Ollama",
  tagline: "Local models through Ollama's OpenAI-compatible endpoint",
  blurb: [
    "Run models locally with Ollama, then point OB-1 at the local OpenAI-compatible endpoint.",
    "The API key is usually blank. Type the model id you have pulled, such as llama3.1 or qwen2.5-coder.",
  ],
  wire: "openai",
  docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
  defaultLocalUrl: "http://localhost:11434/v1",
  defaultModel: "",
  keyOptional: true,
  needsModel: true,
  presets: [
    { label: "Local", hint: "Ollama default :11434", url: "http://localhost:11434/v1" },
    { label: "LAN", hint: "Ollama on another machine", url: "http://" },
  ],
};

export const LM_STUDIO: ProviderProfile = {
  id: "lmstudio",
  name: "LM Studio",
  tagline: "Local desktop models through LM Studio's OpenAI-compatible server",
  blurb: [
    "Start LM Studio's local server, then connect OB-1 to its /v1 endpoint.",
    "The API key is usually blank. Type the model id shown by LM Studio.",
  ],
  wire: "openai",
  docsUrl: "https://lmstudio.ai/docs/app/api",
  defaultLocalUrl: "http://localhost:1234/v1",
  defaultModel: "",
  keyOptional: true,
  needsModel: true,
  presets: [
    { label: "Local", hint: "LM Studio default :1234", url: "http://localhost:1234/v1" },
    { label: "LAN", hint: "LM Studio on another machine", url: "http://" },
  ],
};

export const LLAMA_CPP: ProviderProfile = {
  id: "llamacpp",
  name: "llama.cpp",
  tagline: "Local or LAN llama.cpp server",
  blurb: [
    "Run llama.cpp's server with OpenAI-compatible mode enabled, then connect OB-1 to /v1.",
    "The API key is usually blank. Type the model id your server exposes.",
  ],
  wire: "openai",
  docsUrl: "https://github.com/ggml-org/llama.cpp/tree/master/tools/server",
  defaultLocalUrl: "http://localhost:8080/v1",
  defaultModel: "",
  keyOptional: true,
  needsModel: true,
  presets: [
    { label: "Local", hint: "common llama.cpp server port :8080", url: "http://localhost:8080/v1" },
    { label: "LAN", hint: "llama.cpp on another machine", url: "http://" },
  ],
};

export const VLLM: ProviderProfile = {
  id: "vllm",
  name: "vLLM",
  tagline: "Self-hosted OpenAI-compatible vLLM server",
  blurb: [
    "Point OB-1 at a vLLM OpenAI-compatible server running locally, on a LAN GPU box, or in your cloud.",
    "Leave the API key blank unless your server enforces one. Type the served model id.",
  ],
  wire: "openai",
  docsUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
  defaultLocalUrl: "http://localhost:8000/v1",
  defaultModel: "",
  keyOptional: true,
  needsModel: true,
  presets: [
    { label: "Local", hint: "common vLLM port :8000", url: "http://localhost:8000/v1" },
    { label: "LAN / Cloud", hint: "vLLM on another host", url: "http://" },
  ],
};

export const GROQ: ProviderProfile = {
  id: "groq",
  name: "Groq",
  tagline: "Bring your own Groq key for fast hosted open models",
  blurb: [
    "Use your own Groq account and key through Groq's OpenAI-compatible endpoint.",
    "Set GROQ_API_KEY for a runtime-only route, or save this profile from /models.",
  ],
  wire: "openai",
  docsUrl: "https://console.groq.com/docs/openai",
  defaultLocalUrl: "https://api.groq.com/openai/v1",
  defaultModel: "llama-3.3-70b-versatile",
  envKeys: ["GROQ_API_KEY"],
  presets: [{ label: "Groq", hint: "hosted OpenAI-compatible endpoint", url: "https://api.groq.com/openai/v1" }],
};

// The hosted frontier tier is NOT a provider profile: those models are served by the managed OB-1 server
// on subscription credits (see config.ts resolveProvider's managed-server path and index.ts
// switchToManaged). BYOK/provider-neutral routes are profiles: the embedded Free models router, named
// OpenAI-compatible presets, and a bring-your-own Custom endpoint.
export const PROFILES: ProviderProfile[] = [
  FREE,
  OPENROUTER,
  OLLAMA,
  LM_STUDIO,
  LLAMA_CPP,
  VLLM,
  GROQ,
  CUSTOM,
];

export function profileById(id?: string): ProviderProfile | undefined {
  return id ? PROFILES.find((p) => p.id === id) : undefined;
}

/** Forgiving base-URL normalization so paste-what-you-have works: add a scheme (http for bare hosts —
 *  local servers are plain http), strip trailing slashes, drop a pasted endpoint path (…/chat/completions),
 *  and append `/v1` when the user gave only a host (OpenAI-compatible APIs mount there). Pure + tested. */
export function normalizeBaseUrl(raw: string): string {
  let u = (raw ?? "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "http://" + u; // bare host → assume http (the local default)
  u = u.replace(/\/+$/, ""); // strip trailing slashes
  u = u.replace(/\/(chat\/completions|completions|responses|embeddings|models)$/i, ""); // drop a pasted endpoint
  u = u.replace(/\/+$/, "");
  const m = u.match(/^(https?:\/\/[^/]+)(\/.*)?$/i); // host with no path → append /v1
  if (m && !(m[2] && m[2].replace(/\/+$/, ""))) u = m[1] + "/v1";
  return u;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  available?: boolean;
}
export interface ConnResult {
  ok: boolean;
  status: number;
  models: ModelInfo[];
  error?: string;
}

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
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, status: res.status, models: [], error: "non-JSON response from /models" };
    }
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const models: ModelInfo[] = data
      .map((m: any) => ({
        id: String(m?.id ?? ""),
        name: m?.name,
        contextWindow: m?.context_window ?? m?.context_length,
        available: m?.available,
      }))
      .filter((m: ModelInfo) => m.id);
    return { ok: true, status: res.status, models };
  } catch (e: any) {
    const error = e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : (e?.message ?? "connection failed");
    return { ok: false, status: 0, models: [], error };
  } finally {
    clearTimeout(timer);
  }
}
