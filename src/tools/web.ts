// Web tools — `web_search` (via a SearXNG JSON API) and `web_fetch` (read a page, HTML → text).
// Both are READ-ONLY network tools: no approval gate, and (being non-mutating) available to the
// multi-mind workers for research. The HTTP/JSON/HTML plumbing lives here as small pure helpers +
// an injectable `fetchFn`, so it's unit-testable without the network.

import { lookup } from "node:dns/promises";

const UA = "OB-1/0.1 (+https://github.com/overbrilliant/ob-1)";
const TIMEOUT_MS = 20_000;
export type Fetcher = typeof fetch;
/** Resolve a hostname to its IP address(es). Injectable so the SSRF DNS check stays hermetic in tests. */
export type HostLookup = (host: string) => Promise<string[]>;
const dnsLookup: HostLookup = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Abort signal for a request: the built-in 20s timeout, OR-ed with the caller's turn signal (ESC) when
 *  present, so a fetch ends on the FIRST of "timed out" or "user stopped". */
function reqSignal(userSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
}

export interface SearchOpts {
  categories?: string;   // e.g. "news", "science", "it"
  engines?: string;      // comma-separated engine list
  language?: string;     // e.g. "en"
  time_range?: string;   // day | week | month | year
  pageno?: number;
}

/** Build a SearXNG search URL: `base` is the full `.../search` endpoint; always requests JSON and
 *  forwards only the supported, whitelisted params. */
export function buildSearchUrl(base: string, query: string, opts: SearchOpts = {}): string {
  const u = new URL(base);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  for (const k of ["categories", "engines", "language", "time_range"] as const) {
    const v = opts[k];
    if (v != null && String(v).trim()) u.searchParams.set(k, String(v).trim());
  }
  if (opts.pageno && opts.pageno > 1) u.searchParams.set("pageno", String(opts.pageno));
  return u.toString();
}

/** Format SearXNG JSON into a compact, model-friendly ranked list (title · url · snippet). */
export function formatSearchResults(data: any, limit = 8): string {
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) {
    const sugg = Array.isArray(data?.suggestions) && data.suggestions.length
      ? `\nSuggestions: ${data.suggestions.slice(0, 5).join(", ")}` : "";
    return "(no results)" + sugg;
  }
  const lines = results.slice(0, limit).map((r: any, i: number) => {
    const title = String(r?.title ?? "(untitled)").replace(/\s+/g, " ").trim();
    const url = String(r?.url ?? "").trim();
    const snippet = String(r?.content ?? "").replace(/\s+/g, " ").trim();
    return `${i + 1}. ${title}\n   ${url}${snippet ? `\n   ${snippet}` : ""}`;
  });
  const more = results.length > limit ? `\n\n(+${results.length - limit} more results)` : "";
  return lines.join("\n\n") + more;
}

/** Run a web search against the configured SearXNG endpoint. Throws actionable errors on
 *  misconfiguration, auth failure, or a non-JSON response. */
export async function webSearch(opts: {
  base?: string;
  key?: string;
  /** true → authenticate with `Authorization: Bearer <key>` (managed OB-1 server);
   *  false/undefined → `X-API-Key: <key>` (direct SearXNG instance). */
  bearer?: boolean;
  query: string;
  limit?: number;
  fetchFn?: Fetcher;
  signal?: AbortSignal;
} & SearchOpts): Promise<string> {
  const { base, key, bearer, query, limit, fetchFn = fetch, signal } = opts;
  if (!query || !query.trim()) throw new Error("web_search: empty query");
  if (!base) throw new Error("web_search is not configured — set OB1_SEARXNG_URL (and OB1_SEARXNG_KEY)");
  const url = buildSearchUrl(base, query, opts);
  const headers: Record<string, string> = { "user-agent": UA, accept: "application/json" };
  if (key) headers[bearer ? "authorization" : "X-API-Key"] = bearer ? `Bearer ${key}` : key;
  let res: Response;
  try {
    res = await fetchFn(url, { headers, signal: reqSignal(signal) });
  } catch (e) {
    throw new Error(`web_search: request failed (${(e as Error).message})`);
  }
  if (res.status === 401) throw new Error(bearer ? "web_search: not signed in — run `ob1 login`" : "web_search: 401 — missing or wrong API key (set OB1_SEARXNG_KEY)");
  if (res.status === 402) throw new Error("web_search is a paid feature — upgrade your OB-1 plan to enable it");
  if (res.status === 403) throw new Error("web_search: 403 — access denied");
  if (!res.ok) throw new Error(`web_search: HTTP ${res.status}`);
  let data: any;
  try { data = await res.json(); } catch { throw new Error("web_search: response was not JSON (does the endpoint support &format=json?)"); }
  return formatSearchResults(data, limit ?? 8);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", apos: "'" };
/** Strip an HTML/XML document down to readable text; pass any other content type through unchanged.
 *  Entities are decoded in a SINGLE non-cascading pass — so deliberately double-escaped source like
 *  `&amp;lt;` stays the literal `&lt;` (sequential .replace() passes would wrongly collapse it to `<`). */
export function htmlToText(raw: string, contentType: string): string {
  if (!/html|xml/i.test(contentType)) return raw;
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|nbsp|apos|#0*39|#x0*27);/gi, (m, e: string) => {
      e = e.toLowerCase();
      if (e[0] === "#") return "'"; // numeric apostrophe forms (&#39; / &#x27;)
      return ENTITIES[e] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** SSRF guard: is `hostname` a loopback / private / link-local (incl. the 169.254.169.254 cloud-metadata
 *  IP) / internal address? web_fetch refuses these by default so a model or autonomous worker can't read
 *  internal services or instance metadata on a server/CI host. Exported for testing. */
/** Fold an IPv4-mapped IPv6 address to its embedded IPv4 dotted form. `URL` normalizes `::ffff:127.0.0.1`
 *  to the HEX form `::ffff:7f00:1`, so the IPv4 rules must run against the decoded address — otherwise
 *  loopback / 169.254.169.254 metadata slip past a dotted-only check. Returns null when not v4-mapped. */
function mappedIpv4(host: string): string | null {
  const m = host.match(/^::ffff:(.+)$/i);
  if (!m) return null;
  const tail = m[1];
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;   // already dotted
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);          // two 16-bit groups (e.g. 7f00:1)
  if (!hex) return null;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
  const mapped = mappedIpv4(h);
  if (h.startsWith("::ffff:") && !mapped) return true;      // a v4-mapped form we can't decode → refuse (defense in depth)
  const ipv4 = mapped ?? h;                                 // test the embedded IPv4 when present
  const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127) return true;                  // this-host / loopback
    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                // link-local incl. 169.254.169.254 metadata
  }
  if (/^(fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(h)) return true; // IPv6 loopback/ULA/link-local
  return false;
}

/** Fetch an http(s) URL and return readable text (HTML stripped), truncated to `maxChars`. By default
 *  refuses internal/loopback/metadata hosts (SSRF guard); pass `allowPrivate` (OB1_WEB_FETCH_ALLOW_PRIVATE=1)
 *  to fetch e.g. a localhost dev server. */
export async function webFetch(opts: { url: string; maxChars?: number; allowPrivate?: boolean; fetchFn?: Fetcher; lookupFn?: HostLookup; signal?: AbortSignal }): Promise<string> {
  const { url, maxChars = 20_000, allowPrivate = false, fetchFn = fetch, lookupFn = dnsLookup, signal } = opts;
  if (!/^https?:\/\//i.test(url)) throw new Error("web_fetch: url must start with http:// or https://");
  let host: string;
  try { host = new URL(url).hostname; } catch { throw new Error("web_fetch: invalid URL"); }
  if (!allowPrivate) {
    if (isBlockedHost(host)) {
      throw new Error(`web_fetch: refusing to fetch a private/internal/loopback address (${host}); set OB1_WEB_FETCH_ALLOW_PRIVATE=1 to allow`);
    }
    // A literal-hostname check is bypassable: a public-looking name can RESOLVE to 127.0.0.1, 10.x, or the
    // 169.254.169.254 metadata IP. Resolve it and refuse if any address is internal. (A fetch re-resolves,
    // so this isn't full DNS-rebinding protection, but it closes the common public-name→private-IP bypass.)
    let addrs: string[];
    try { addrs = await lookupFn(host); }
    catch { throw new Error(`web_fetch: could not resolve host (${host})`); }
    const bad = addrs.find((a) => isBlockedHost(a));
    if (bad) {
      throw new Error(`web_fetch: refusing to fetch ${host} — it resolves to a private/internal address (${bad}); set OB1_WEB_FETCH_ALLOW_PRIVATE=1 to allow`);
    }
  }
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "user-agent": UA }, signal: reqSignal(signal) });
  } catch (e) {
    throw new Error(`web_fetch: request failed (${(e as Error).message})`);
  }
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = htmlToText(raw, ct);
  const truncated = text.length > maxChars;
  return `HTTP ${res.status} · ${ct || "?"}\n${text.slice(0, maxChars)}${truncated ? "\n…[truncated]" : ""}`;
}
