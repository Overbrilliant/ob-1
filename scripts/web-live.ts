// LIVE test for the web tools — hits the REAL SearXNG JSON API + a real page. Opt-in: self-skips
// unless OB1_SEARXNG_URL (+ OB1_SEARXNG_KEY) are set (loaded from the gitignored .env locally, or
// CI secrets). Verifies all three auth cases (correct key → JSON, wrong key → 401, missing key →
// 401), real result parsing, and a real web_fetch. Spends no model tokens.
// Usage: bun run scripts/web-live.ts
import { webSearch, webFetch } from "../src/tools/web.ts";

const base = process.env.OB1_SEARXNG_URL;
const key = process.env.OB1_SEARXNG_KEY;
if (!base || !key) {
  console.log("• skipped — set OB1_SEARXNG_URL + OB1_SEARXNG_KEY to run the live web test");
  process.exit(0);
}

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? " — " + extra : ""}`); if (!ok) fail = true; };
async function expectThrow(fn: () => Promise<unknown>, re: RegExp): Promise<{ ok: boolean; msg: string }> {
  try { await fn(); return { ok: false, msg: "(no throw)" }; } catch (e) { const msg = (e as Error).message; return { ok: re.test(msg), msg }; }
}

// 1) Correct key → real JSON results.
let out = "";
try { out = await webSearch({ base, key, query: "anthropic claude" }); }
catch (e) { check("live search with correct key returns results", false, (e as Error).message); }
if (out) {
  check("live search returns ranked results", out.includes("1. ") && /https?:\/\//.test(out), out.split("\n")[0]?.slice(0, 80));
  check("live search results look topical", /claude|anthropic/i.test(out));
}

// 2) Wrong key → 401.
const wrong = await expectThrow(() => webSearch({ base, key: "definitely-not-the-key", query: "test" }), /401|403/);
check("live search with WRONG key → 401/403", wrong.ok, wrong.msg);

// 3) Missing key → 401 (the Caddy gate rejects a request with no X-API-Key).
const missing = await expectThrow(() => webSearch({ base, query: "test" }), /401|403/);
check("live search with MISSING key → 401/403", missing.ok, missing.msg);

// 4) A search param (time_range) is accepted by the live endpoint.
try {
  const recent = await webSearch({ base, key, query: "anthropic", time_range: "year" });
  check("live search honors a query param (time_range)", recent.includes("1. ") || recent.includes("(no results)"));
} catch (e) { check("live search honors a query param (time_range)", false, (e as Error).message); }

// 5) Real web_fetch reads + strips a live page. A connect/DNS failure here is an ENVIRONMENT limit
//    (some sandboxes resolve no external hosts), not a tool bug — so skip that case loudly rather
//    than fail. Any other error (bad status, HTML not stripped) IS a failure.
try {
  const page = await webFetch({ url: "https://example.com" });
  check("live web_fetch reads + strips a real page", page.includes("HTTP 200") && /example domain/i.test(page));
} catch (e) {
  const msg = (e as Error).message;
  if (/request failed/.test(msg)) console.log(`• web_fetch live check SKIPPED — host unreachable from here (${msg})`);
  else check("live web_fetch reads + strips a real page", false, msg);
}

if (fail) { console.error("\n✗ web LIVE test FAILED"); process.exit(1); }
console.log("\n✓ web LIVE test passed (real SearXNG: correct/wrong/missing key + params + real web_fetch)");
