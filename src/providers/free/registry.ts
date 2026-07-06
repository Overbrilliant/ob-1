// Static provider registry for the embedded free-models router — the SOURCE OF TRUTH for connection
// metadata (base URLs, keyless flags, signup pages, per-provider quirks/caps). Cross-checked against the
// upstream freeapi provider registry; that project's providers/index.ts is authoritative for URLs/headers.
//
// The catalog (models + limits) is VENDORED as ./catalog.json and imported STATICALLY so `bun build
// --compile` bundles it into the binary — we NEVER runtime-read a repo-relative file (the compiled binary
// has no repo). Regenerate it with `bun scripts/sync-free-catalog.ts`.
import catalogJson from "./catalog.json";

/** Published free-tier rate limits for one model. `null` = the provider publishes no cap on that axis. */
export interface CatalogLimits {
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
}

/** A caveat surfaced to the user (key format, queue limits, training-on-prompts, …). */
export interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: string;
}

/** One vendored catalog row. `modality` image/audio rows are dropped at sync time, so a runtime row is
 *  always a text/chat model. `enabled:false` rows are KEPT (respected at gating time), not filtered. */
export interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number; // 1 = smartest (within the whole catalog, best-effort)
  speedRank: number; // 1 = fastest
  sizeLabel: string; // Frontier | Large | Medium | Small (cross-provider capability tier)
  limits: CatalogLimits;
  monthlyTokenBudget: string; // DISPLAY string ("~3M") — never machine-parsed for routing
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  quirks: CatalogQuirk[];
  modality?: string;
  mediaNote?: string;
}

/** The vendored catalog document shape. */
export interface Catalog {
  version: string;
  generatedAt: string;
  tier: string;
  counts: Record<string, number>;
  platforms: { id: string; name: string }[];
  models: CatalogModel[];
  quirks: unknown[];
}

/** The vendored, filtered catalog (media + aihorde already removed at sync time). Cast through unknown so
 *  the giant JSON literal doesn't inflate the inferred type; the sync script guarantees the shape. */
export const CATALOG: Catalog = catalogJson as unknown as Catalog;

/** A resolved wire connection for ONE request: the base URL to POST to and the bearer key to send
 *  (empty string ⇒ no Authorization header). Some providers derive both from a compound key. */
export interface ResolvedConnection {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}

/** Connection metadata for one free provider. Every catalog `platform` maps to exactly one of these. */
export interface FreeProvider {
  /** Platform id (matches catalog `platform`; never contains "/"). */
  id: string;
  name: string;
  /** OpenAI-compatible base URL (…/v1). Ignored when `resolveConnection` derives it from the key. */
  baseUrl: string;
  /** True ⇒ works with no key (anonymous tier). A keyless provider is healthy-by-default. */
  keyless: boolean;
  /** The keys.env variable name that activates this provider (`<ID>_API_KEY`). Present even for keyless
   *  providers so an OPTIONAL key (LLM7) can still raise limits. */
  keyEnvName: string;
  /** Where the user gets a key (or an account, for keyless "no key needed" providers). */
  signupUrl: string;
  /** Short caveat shown next to the key line in the template (e.g. Cloudflare's compound key format). */
  keyNote?: string;
  /** Headers sent on every request to this provider (e.g. OpenRouter attribution, Routeway's UA). */
  extraHeaders?: Record<string, string>;
  /** Account-wide requests-per-minute cap shared across ALL of this provider's models (NVIDIA: 40). */
  providerRpmCap?: number;
  /** Account-wide requests-per-day cap shared across ALL of this provider's models (OpenRouter :free: 50). */
  providerRpdCap?: number;
  /** Recommended = shown in the "best free tiers" group at the top of the keys template. */
  recommended?: boolean;
  /** Derive the wire connection from the stored key. Default (undefined) ⇒ {baseUrl, apiKey: key}. Used
   *  by Cloudflare, whose key is `ACCOUNT_ID:TOKEN` and whose URL embeds the account id. */
  resolveConnection?: (key: string) => ResolvedConnection;
  /** Health-probe override. The background probe GETs `{probeBase}/models` (default: the resolved base
   *  URL). Some providers don't serve a catalog there, which made a perfectly good key read as health
   *  "error": `probeBaseUrl(conn)` points the probe at the base whose `/models` DOES exist (GitHub
   *  Models' catalog lives at a different path than its inference base). */
  probeBaseUrl?: (conn: ResolvedConnection) => string;
  /** Skip the /models health probe entirely — health stays "unknown", never a false "error". For a
   *  provider whose OpenAI-compat endpoint has no usable GET /models at all (Cloudflare: 405 on
   *  `/ai/v1/models`, and its model list lives at the non-`/models` `/ai/models/search`). Chat still
   *  works while credits remain; the auth check happens on the real call (which benches on 401/403). */
  skipProbe?: boolean;
}

/** Cloudflare Workers AI: the key is `ACCOUNT_ID:TOKEN`. Split on the FIRST ":" — the account id goes in
 *  the URL path, the token is the bearer. A key without ":" yields an empty account id (the call then 4xxs
 *  and the router benches it), which is the correct, non-throwing failure. */
function cloudflareConnection(key: string): ResolvedConnection {
  const sep = key.indexOf(":");
  const accountId = sep === -1 ? "" : key.slice(0, sep);
  const token = sep === -1 ? key : key.slice(sep + 1);
  return {
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    apiKey: token,
  };
}

// A browser-like UA — Routeway sits behind Cloudflare, which returns error 1010 to non-browser agents.
const ROUTEWAY_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** The 23 free providers (aihorde dropped — it is queue-based with no streaming). Order here is only the
 *  declaration order; the keys-template grouping uses `recommended` + `keyless`, and routing uses the
 *  catalog + strategy. All are routed through OB-1's existing OpenAI-compatible caller (callOpenAI). */
export const FREE_PROVIDERS: FreeProvider[] = [
  // ── Recommended (best free tiers) ──────────────────────────────────────────
  {
    id: "google",
    name: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyless: false,
    keyEnvName: "GOOGLE_API_KEY",
    signupUrl: "https://aistudio.google.com/apikey",
    recommended: true,
    // The catalog stores BARE Gemini ids (e.g. "gemini-2.5-flash"), which the generativelanguage
    // OpenAI-compat endpoint accepts as-is — no per-model mapping hook needed (verified against the
    // vendored data + the existing GEMINI_API_KEY env route in config.ts). Live single/simple turns
    // verified working incl. gemini-3-flash-preview (with and without reasoning_effort). CAVEAT: gemini-3
    // can 400 mid tool-loop over the OpenAI-compat bridge ("missing thought_sig" — the native
    // thoughtSignature isn't expressible in OpenAI wire format); that's an upstream/model quirk the
    // router's failover routes around, not a param-mapping bug on our side.
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyless: false,
    keyEnvName: "GROQ_API_KEY",
    signupUrl: "https://console.groq.com/keys",
    recommended: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyless: false,
    keyEnvName: "OPENROUTER_API_KEY",
    signupUrl: "https://openrouter.ai/keys",
    recommended: true,
    // The :free daily cap is ACCOUNT-WIDE (shared across every :free model), not per-model — model it as a
    // provider-wide rpd cap so the router stops before earning surprise 429s across the whole pool.
    providerRpdCap: 50,
    extraHeaders: { "HTTP-Referer": "https://overbrilliant.com", "X-Title": "OB-1" },
  },
  {
    id: "github",
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    keyless: false,
    keyEnvName: "GITHUB_API_KEY",
    signupUrl: "https://github.com/settings/tokens",
    recommended: true,
    // The inference base only serves POST /chat/completions — `…/inference/models` 404s. The model
    // catalog lives on a SEPARATE path (`…/catalog/models`, verified 200), so probe there instead of
    // false-flagging a good token as health "error".
    probeBaseUrl: () => "https://models.github.ai/catalog",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyless: false,
    keyEnvName: "NVIDIA_API_KEY",
    signupUrl: "https://build.nvidia.com/settings/api-keys",
    recommended: true,
    providerRpmCap: 40, // account-wide per-minute cap across all NIM models
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyless: false,
    keyEnvName: "CEREBRAS_API_KEY",
    signupUrl: "https://cloud.cerebras.ai",
    recommended: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyless: false,
    keyEnvName: "MISTRAL_API_KEY",
    signupUrl: "https://console.mistral.ai/api-keys/",
    recommended: true,
  },
  // ── More providers ─────────────────────────────────────────────────────────
  {
    id: "agnes",
    name: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    keyless: false,
    keyEnvName: "AGNES_API_KEY",
    signupUrl: "https://platform.agnes-ai.com",
  },
  {
    id: "ainative",
    name: "AINative Studio",
    baseUrl: "https://api.ainative.studio/api/v1",
    keyless: false,
    keyEnvName: "AINATIVE_API_KEY",
    signupUrl: "https://ainative.studio",
  },
  {
    id: "bazaarlink",
    name: "BazaarLink",
    baseUrl: "https://bazaarlink.ai/api/v1",
    keyless: false,
    keyEnvName: "BAZAARLINK_API_KEY",
    signupUrl: "https://bazaarlink.ai",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1", // template; real URL via resolveConnection
    keyless: false,
    keyEnvName: "CLOUDFLARE_API_KEY",
    signupUrl: "https://dash.cloudflare.com",
    keyNote: "key format: ACCOUNT_ID:TOKEN",
    resolveConnection: cloudflareConnection,
    // GET `…/ai/v1/models` 405s ("GET not supported for requested URI") and the model list lives at the
    // non-`/models` `…/ai/models/search`, so there's no usable /models probe — skip it (health stays
    // "unknown", never a false "error"). NOTE: the free tier is a shared 10k-neuron/day cap that
    // exhausts fast → a live call then 429s with "used up your daily free allocation of … neurons"
    // (verified); that's upstream quota, not a client bug, and the router correctly benches it on the 429.
    skipProbe: true,
  },
  {
    id: "cohere",
    name: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    keyless: false,
    keyEnvName: "COHERE_API_KEY",
    signupUrl: "https://dashboard.cohere.com/api-keys",
  },
  {
    id: "huggingface",
    name: "HuggingFace Router",
    baseUrl: "https://router.huggingface.co/v1",
    keyless: false,
    keyEnvName: "HUGGINGFACE_API_KEY",
    signupUrl: "https://huggingface.co/settings/tokens",
  },
  {
    id: "ollama",
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    keyless: false,
    keyEnvName: "OLLAMA_API_KEY",
    signupUrl: "https://ollama.com/settings/keys",
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    keyless: false,
    keyEnvName: "OPENCODE_API_KEY",
    signupUrl: "https://opencode.ai/auth",
  },
  {
    id: "reka",
    name: "Reka",
    baseUrl: "https://api.reka.ai/v1",
    keyless: false,
    keyEnvName: "REKA_API_KEY",
    signupUrl: "https://platform.reka.ai",
  },
  {
    id: "routeway",
    name: "Routeway",
    baseUrl: "https://api.routeway.ai/v1",
    keyless: false,
    keyEnvName: "ROUTEWAY_API_KEY",
    signupUrl: "https://routeway.ai",
    extraHeaders: { "User-Agent": ROUTEWAY_UA }, // Cloudflare 1010 without a browser-like UA
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.com/v1",
    keyless: false,
    keyEnvName: "SILICONFLOW_API_KEY",
    signupUrl: "https://siliconflow.com",
  },
  {
    id: "zhipu",
    name: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyless: false,
    keyEnvName: "ZHIPU_API_KEY",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  // ── No key needed — always on ──────────────────────────────────────────────
  {
    id: "kilo",
    name: "Kilo Gateway",
    baseUrl: "https://api.kilo.ai/api/gateway/v1",
    keyless: true,
    keyEnvName: "KILO_API_KEY",
    signupUrl: "https://app.kilo.ai",
  },
  {
    id: "pollinations",
    name: "Pollinations",
    baseUrl: "https://text.pollinations.ai/openai/v1",
    keyless: true,
    keyEnvName: "POLLINATIONS_API_KEY",
    signupUrl: "https://pollinations.ai",
  },
  {
    id: "ovh",
    name: "OVH AI Endpoints",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyless: true,
    keyEnvName: "OVH_API_KEY",
    signupUrl: "https://endpoints.ai.cloud.ovh.net",
  },
  {
    id: "llm7",
    name: "LLM7",
    baseUrl: "https://api.llm7.io/v1",
    keyless: true, // works anonymously; an OPTIONAL LLM7_API_KEY raises the limits
    keyEnvName: "LLM7_API_KEY",
    signupUrl: "https://llm7.io",
    keyNote: "optional — anonymous works; a key raises limits",
  },
];

const PROVIDERS_BY_ID = new Map<string, FreeProvider>(FREE_PROVIDERS.map((p) => [p.id, p]));

/** Look up a provider's connection metadata by platform id. */
export function providerById(id: string): FreeProvider | undefined {
  return PROVIDERS_BY_ID.get(id);
}

/** Resolve the wire connection for one request against a provider + stored key. Keyless providers with no
 *  key pass "" through, so callOpenAI omits the Authorization header. */
export function resolveConnection(provider: FreeProvider, key: string): ResolvedConnection {
  const conn = provider.resolveConnection
    ? provider.resolveConnection(key)
    : { baseUrl: provider.baseUrl, apiKey: key };
  return { ...conn, extraHeaders: { ...provider.extraHeaders, ...conn.extraHeaders } };
}

/** A stable "platform/modelId" key. Platform ids never contain "/", so a naive join is unambiguous even
 *  though a modelId MAY contain "/" (e.g. "qwen/qwen3-coder:free"). */
export function modelKey(platform: string, modelId: string): string {
  return `${platform}/${modelId}`;
}

/** Split a "platform/modelId" pin on the FIRST "/". Returns undefined for a bare string with no "/". */
export function splitModelKey(key: string): { platform: string; modelId: string } | undefined {
  const i = key.indexOf("/");
  if (i <= 0 || i >= key.length - 1) return undefined;
  return { platform: key.slice(0, i), modelId: key.slice(i + 1) };
}
