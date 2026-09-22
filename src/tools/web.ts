// Web tools — `web_search` (via a SearXNG JSON API) and `web_fetch` (read a page, HTML → text).
// Both are READ-ONLY network tools: no approval gate, and (being non-mutating) available to the
// multi-mind workers for research. The HTTP/JSON/HTML plumbing lives here as small pure helpers +
// an injectable `fetchFn`, so it's unit-testable without the network.

import { lookup } from "node:dns/promises";
import { CLI_VERSION } from "../version.ts";

const UA = `OB-1/${CLI_VERSION} (+https://github.com/overbrilliant/ob-1)`;
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

/** Expand an IPv6 address (brackets already stripped, `::` compressed allowed) into its eight 16-bit
 *  hex groups, or null if it isn't parseable IPv6. Used to detect embedded-IPv4 forms. */
function ipv6Groups(h: string): string[] | null {
  if (!h.includes(":")) return null;
  let head = h, tail: string[] = [];
  const dc = h.indexOf("::");
  if (dc !== -1) { head = h.slice(0, dc); tail = h.slice(dc + 2).split(":").filter(Boolean); }
  const headParts = head ? head.split(":") : [];
  const groups = [...headParts];
  while (groups.length + tail.length < 8) groups.push("0");
  groups.push(...tail);
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups;
}

/** Embedded IPv4 inside an IPv6 address: v4-MAPPED (`::ffff:7f00:1`) or legacy v4-COMPATIBLE
 *  (`::7f00:1` — what `URL` normalizes `http://[::127.0.0.1]/` to). Both hide loopback/private
 *  addresses from a dotted-quad-only check. Returns dotted form, or null when no embedded v4. */
function embeddedIpv4(groups: string[]): string | null {
  const hi = groups.slice(0, 5).join(":"), h6 = groups[5];
  const low = (parseInt(groups[6], 16) >> 8) & 255, lo2 = parseInt(groups[6], 16) & 255;
  const lo3 = (parseInt(groups[7], 16) >> 8) & 255, lo4 = parseInt(groups[7], 16) & 255;
  if (hi === "0:0:0:0:0" && h6 === "ffff") return `${low}.${lo2}.${lo3}.${lo4}`; // ::ffff:a.b.c.d
  if (hi === "0:0:0:0:0" && h6 === "0") return `${low}.${lo2}.${lo3}.${lo4}`;    // ::a.b.c.d compatible
  return null;
}

export function isBlockedHost(hostname: string): boolean {
  // Strip IPv6 brackets and a trailing FQDN dot (`localhost.` is the same host as `localhost`).
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
  let ipv4: string | null = mappedIpv4(h);
  if (!ipv4 && /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) ipv4 = h; // plain dotted-quad host
  const undecodableMapped = h.startsWith("::ffff:") && !ipv4;
  const groups = ipv6Groups(h);
  if (!ipv4 && groups) {
    ipv4 = embeddedIpv4(groups);
    // Any compressed/oblique v4-mapped form we can't decode → refuse (defense in depth).
    if (undecodableMapped) return true;
  }
  if (ipv4) {
    const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return true; // embedded form we failed to parse → refuse
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a === 0 || a === 127) return true;                  // this-host / loopback
      if (a === 10) return true;                              // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
      if (a === 100 && b >= 64 && b <= 127) return true;      // 100.64.0.0/10 CGNAT (Tailscale/VPN nets)
      if (a === 192 && b === 168) return true;                // 192.168.0.0/16
      if (a === 169 && b === 254) return true;                // link-local incl. 169.254.169.254 metadata
    }
  }
  if (/^(fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(h)) return true; // IPv6 ULA/link-local
  // v4-compatible IPv6 with any zero-prefixed form not caught above (e.g. hand-written `::7f00:1`
  // reached un-normalized) → if it parses as all-zero-prefix IPv6, treat it as the embedded IPv4.
  if (groups && groups.slice(0, 6).every((g) => Number.parseInt(g, 16) === 0)) return true;
  return false;
}

/** Fetch an http(s) URL and return readable text (HTML stripped), truncated to `maxChars`. By default
 *  refuses internal/loopback/metadata hosts (SSRF guard); pass `allowPrivate` (OB1_WEB_FETCH_ALLOW_PRIVATE=1)
 *  to fetch e.g. a localhost dev server.
 *  Redirects are followed MANUALLY (max 5 hops) and every hop's host re-checked against the SSRF guard:
 *  with the default `redirect: "follow"`, a public page answering 302 → http://169.254.169.254/ would
 *  silently defeat the pre-flight check. */
export async function webFetch(opts: { url: string; maxChars?: number; allowPrivate?: boolean; fetchFn?: Fetcher; lookupFn?: HostLookup; signal?: AbortSignal }): Promise<string> {
  const { url, maxChars = 20_000, allowPrivate = false, fetchFn = fetch, lookupFn = dnsLookup, signal } = opts;
  if (!/^https?:\/\//i.test(url)) throw new Error("web_fetch: url must start with http:// or https://");
  // Applied to the first URL AND to every redirect target.
  const guard = async (u: string): Promise<string> => {
    let host: string;
    try { host = new URL(u).hostname; } catch { throw new Error("web_fetch: invalid URL"); }
    if (allowPrivate) return u;
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
    return u;
  };
  let target = await guard(url);
  let res: Response | undefined;
  for (let hop = 0; hop <= 5; hop++) {
    try {
      res = await fetchFn(target, { headers: { "user-agent": UA }, redirect: "manual", signal: reqSignal(signal) });
    } catch (e) {
      throw new Error(`web_fetch: request failed (${(e as Error).message})`);
    }
    // 3xx with a Location → validate the next hop's host, then follow it ourselves.
    const location = res.status >= 301 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    if (hop === 5) throw new Error("web_fetch: too many redirects (more than 5)");
    let next: string;
    try { next = new URL(location, target).toString(); } catch { throw new Error(`web_fetch: invalid redirect Location (${location})`); }
    if (!/^https?:\/\//i.test(next)) throw new Error("web_fetch: redirect to a non-http(s) target refused");
    target = await guard(next);
  }
  if (!res) throw new Error("web_fetch: request failed (no response)");
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = htmlToText(raw, ct);
  const truncated = text.length > maxChars;
  return `HTTP ${res.status} · ${ct || "?"}\n${text.slice(0, maxChars)}${truncated ? "\n…[truncated]" : ""}`;
}
