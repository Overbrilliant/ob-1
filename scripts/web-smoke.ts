// Deterministic test for the web tools (no network — a fake fetch is injected). Verifies the
// SearXNG URL builder + result formatter, HTML→text stripping, the X-API-Key header, auth/HTTP/JSON
// error handling, and that web_search is registered only when configured.
// Usage: bun run scripts/web-smoke.ts
import { buildSearchUrl, formatSearchResults, htmlToText, isBlockedHost, webSearch, webFetch, type Fetcher } from "../src/tools/web.ts";
import { buildTools } from "../src/agent/tools.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { loadConfig } from "../src/config.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? " — " + extra : ""}`); if (!ok) fail = true; };
async function throws(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return re.test((e as Error).message); }
}
/** A fake fetch that returns a scripted Response and records the request. */
function fakeFetch(opts: { status?: number; json?: unknown; text?: string; contentType?: string; throwErr?: string }): { fn: Fetcher; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (opts.throwErr) throw new Error(opts.throwErr);
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? (opts.contentType ?? "application/json") : null) },
      json: async () => { if (opts.json === undefined) throw new Error("not json"); return opts.json; },
      text: async () => opts.text ?? "",
    } as any;
  }) as Fetcher;
  return { fn, calls };
}

// --- buildSearchUrl ---
const u = new URL(buildSearchUrl("https://srx.example/search", "anthropic claude", { time_range: "week", language: "en", pageno: 2 }));
check("buildSearchUrl sets q + format=json", u.searchParams.get("q") === "anthropic claude" && u.searchParams.get("format") === "json");
check("buildSearchUrl forwards whitelisted params", u.searchParams.get("time_range") === "week" && u.searchParams.get("language") === "en" && u.searchParams.get("pageno") === "2");
check("buildSearchUrl drops pageno=1", !new URL(buildSearchUrl("https://srx.example/search", "x", { pageno: 1 })).searchParams.has("pageno"));
check("buildSearchUrl ignores blank params", !new URL(buildSearchUrl("https://srx.example/search", "x", { categories: "  " })).searchParams.has("categories"));

// --- formatSearchResults ---
const fmt = formatSearchResults({ results: [
  { title: "Claude", url: "https://anthropic.com", content: "AI by Anthropic" },
  { title: "Docs", url: "https://docs.anthropic.com", content: "" },
] }, 8);
check("formatSearchResults renders title/url/snippet", fmt.includes("1. Claude") && fmt.includes("https://anthropic.com") && fmt.includes("AI by Anthropic"));
check("formatSearchResults handles a missing snippet", fmt.includes("2. Docs") && fmt.includes("https://docs.anthropic.com"));
check("formatSearchResults limit + overflow note", formatSearchResults({ results: Array.from({ length: 10 }, (_, i) => ({ title: "t" + i, url: "u" + i })) }, 3).includes("(+7 more results)"));
check("formatSearchResults empty → (no results) + suggestions", formatSearchResults({ results: [], suggestions: ["claude ai"] }).includes("(no results)") && formatSearchResults({ results: [], suggestions: ["claude ai"] }).includes("claude ai"));

// --- htmlToText ---
const stripped = htmlToText("<html><head><style>.x{}</style><script>bad()</script></head><body><h1>Hi&amp;Bye</h1><p>a&nbsp;b</p></body></html>", "text/html; charset=utf-8");
check("htmlToText drops script/style", !stripped.includes("bad()") && !stripped.includes(".x{"));
check("htmlToText strips tags + decodes entities", stripped.includes("Hi&Bye") && stripped.includes("a b") && !stripped.includes("<h1>"));
check("htmlToText passes non-HTML through", htmlToText('{"a":1}', "application/json") === '{"a":1}');
// Single-pass decode: deliberately double-escaped source must NOT collapse into live markup.
check("htmlToText does not double-decode (&amp;lt; stays literal &lt;)", htmlToText("<p>&amp;lt;script&amp;gt;</p>", "text/html") === "&lt;script&gt;");
check("htmlToText decodes numeric apostrophe", htmlToText("<p>it&#39;s &#x27;ok&#x27;</p>", "text/html") === "it's 'ok'");

// --- isBlockedHost (SSRF guard) ---
check("isBlockedHost flags loopback + private + metadata", ["127.0.0.1", "localhost", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.169.254", "::1", "foo.internal"].every(isBlockedHost));
check("isBlockedHost allows public hosts", !["example.com", "8.8.8.8", "172.32.0.1", "anthropic.com"].some(isBlockedHost));

// --- webSearch (mocked) ---
const okFetch = fakeFetch({ json: { results: [{ title: "R", url: "https://r", content: "snip" }] }, contentType: "application/json" });
const out = await webSearch({ base: "https://srx.example/search", key: "secret-key", query: "q", fetchFn: okFetch.fn });
check("webSearch returns formatted results", out.includes("1. R") && out.includes("https://r"));
check("webSearch sends the X-API-Key header", okFetch.calls[0]?.headers["X-API-Key"] === "secret-key");
check("webSearch requests JSON", okFetch.calls[0]?.url.includes("format=json"));
check("webSearch: empty query → error", await throws(() => webSearch({ base: "https://srx.example/search", query: "  ", fetchFn: okFetch.fn }), /empty query/));
check("webSearch: no base → 'not configured'", await throws(() => webSearch({ query: "q", fetchFn: okFetch.fn }), /not configured/));
check("webSearch: 401 → key error", await throws(() => webSearch({ base: "https://srx.example/search", key: "bad", query: "q", fetchFn: fakeFetch({ status: 401 }).fn }), /401.*API key/));
check("webSearch: 500 → HTTP error", await throws(() => webSearch({ base: "https://srx.example/search", query: "q", fetchFn: fakeFetch({ status: 500, json: {} }).fn }), /HTTP 500/));
check("webSearch: non-JSON → actionable error", await throws(() => webSearch({ base: "https://srx.example/search", query: "q", fetchFn: fakeFetch({ status: 200 }).fn }), /not JSON/));
check("webSearch: network failure → wrapped error", await throws(() => webSearch({ base: "https://srx.example/search", query: "q", fetchFn: fakeFetch({ throwErr: "ECONNREFUSED" }).fn }), /request failed.*ECONNREFUSED/));

// --- webFetch (mocked) ---
// Hermetic DNS resolver: webFetch resolves the host (SSRF guard); a public-looking host maps to a public
// IP so the mocked fetch is reached. Blocked-literal cases below don't get here (refused before resolve).
const pubLookup = async () => ["93.184.216.34"];
const wf = await webFetch({ url: "https://example.com", lookupFn: pubLookup, fetchFn: fakeFetch({ text: "<html><body><p>Hello world</p></body></html>", contentType: "text/html" }).fn });
check("webFetch strips HTML to text", wf.includes("Hello world") && !wf.includes("<p>") && wf.includes("HTTP 200"));
check("webFetch: rejects non-http url", await throws(() => webFetch({ url: "file:///etc/passwd", fetchFn: okFetch.fn }), /must start with http/));
check("webFetch: refuses cloud-metadata IP (SSRF)", await throws(() => webFetch({ url: "http://169.254.169.254/latest/meta-data/", fetchFn: okFetch.fn }), /private\/internal\/loopback/));
check("webFetch: refuses localhost (SSRF)", await throws(() => webFetch({ url: "http://localhost:8888/", fetchFn: okFetch.fn }), /private\/internal\/loopback/));
check("webFetch: allowPrivate overrides the SSRF guard", (await webFetch({ url: "http://127.0.0.1/x", allowPrivate: true, fetchFn: fakeFetch({ text: "ok", contentType: "text/plain" }).fn })).includes("ok"));
const longText = "x".repeat(50);
check("webFetch truncates", (await webFetch({ url: "https://e", maxChars: 10, lookupFn: pubLookup, fetchFn: fakeFetch({ text: longText, contentType: "text/plain" }).fn })).includes("…[truncated]"));
// SSRF: a PUBLIC-looking host that RESOLVES to a private/metadata IP must still be refused (DNS-aware guard).
check("webFetch: refuses a public name resolving to a private IP (SSRF)",
  await throws(() => webFetch({ url: "https://sneaky.example.com/", lookupFn: async () => ["169.254.169.254"], fetchFn: okFetch.fn }), /resolves to a private\/internal address/));

// --- abort threading (ESC): the turn's AbortSignal cancels an in-flight request, not just the model ---
// A signal-aware fake fetch: rejects the instant the passed signal aborts (mirrors real fetch), so this
// stays fully offline. webFetch/webSearch OR the user signal with their 20s timeout via reqSignal().
const abortAwareFetch: Fetcher = (async (_url: any, init: any) => {
  const sig: AbortSignal | undefined = init?.signal;
  if (sig?.aborted) throw new Error("The operation was aborted");
  return await new Promise((_res, rej) => sig?.addEventListener("abort", () => rej(new Error("The operation was aborted")), { once: true }));
}) as Fetcher;
const preAborted = (() => { const ac = new AbortController(); ac.abort(); return ac.signal; })();
check("webFetch aborts on a pre-aborted signal (ESC mid-fetch)",
  await throws(() => webFetch({ url: "https://example.com", lookupFn: pubLookup, fetchFn: abortAwareFetch, signal: preAborted }), /request failed|abort/i));
check("webSearch aborts on a pre-aborted signal (ESC mid-search)",
  await throws(() => webSearch({ base: "https://srx.example/search", query: "q", fetchFn: abortAwareFetch, signal: preAborted }), /request failed|abort/i));
// And a signal that aborts WHILE the request is in flight (the real ESC case) also unblocks it.
check("webFetch aborts mid-flight when the signal fires",
  await throws(async () => {
    const ac = new AbortController();
    const p = webFetch({ url: "https://example.com", lookupFn: pubLookup, fetchFn: abortAwareFetch, signal: ac.signal });
    ac.abort();
    return p;
  }, /request failed|abort/i));

// --- tool registration: web_search appears only when configured ---
const dbPath = join(tmpdir(), `ob1-web-${process.pid}.db`);
const store = new MemoryStore(dbPath);
const cfgBase = loadConfig();
const toolsOff = buildTools({ ...cfgBase, searxngUrl: undefined, searxngKey: undefined }, store);
const toolsOn = buildTools({ ...cfgBase, searxngUrl: "https://srx.example/search", searxngKey: "k" }, store);
check("web_fetch always registered", toolsOff.has("web_fetch") && toolsOn.has("web_fetch"));
check("web_search registered ONLY when configured", !toolsOff.has("web_search") && toolsOn.has("web_search"));
check("web tools are read-only (available to workers)", toolsOn.get("web_search")!.mutating === false && toolsOn.get("web_fetch")!.mutating === false);
store.close();
for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });

if (fail) { console.error("\n✗ web smoke FAILED"); process.exit(1); }
console.log("\n✓ web smoke passed (search url/format + result render + html→text + X-API-Key + auth/HTTP/JSON errors + conditional registration)");
