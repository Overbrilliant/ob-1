// End-to-end smoke for the browser_check verification tool (the harness's "eyes"). Serves a WORKING
// theme-toggle page and a BROKEN one, then proves runBrowserCheck PASSES the first and FAILS the second
// — i.e. it would have caught the "toggle does nothing" bug that static checks (build/typecheck) miss.
//
// Launches a real headless Chromium (shipped with OB-1). If the browser binary isn't installed in this
// environment, the smoke SKIPS cleanly rather than failing. Run: bun run scripts/browser-check-smoke.ts
export {};
import { runBrowserCheck, formatBrowserCheck } from "../src/agent/browser.ts";

let fail = false;
const check = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${ok || !d ? "" : `  — ${d}`}`); if (!ok) fail = true; };

// A page whose button REALLY toggles data-theme + body background (the correct implementation).
const WORKING = `<!doctype html><html data-theme="light"><head><style>
  :root{--bg:#fff} html[data-theme="dark"]{--bg:#111} body{background:var(--bg)}
</style></head><body>
  <button id="t" aria-label="Theme: toggle">toggle</button>
  <script>
    document.getElementById('t').addEventListener('click', function(){
      var cur = document.documentElement.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
    });
  </script>
</body></html>`;

// A page whose button is wired but does NOTHING (the bug from the transcript: present, but inert).
const BROKEN = `<!doctype html><html data-theme="light"><head><style>
  :root{--bg:#fff} html[data-theme="dark"]{--bg:#111} body{background:var(--bg)}
</style></head><body>
  <button id="t" aria-label="Theme: toggle">toggle</button>
  <script>/* oops — no event listener attached; the toggle is inert */</script>
</body></html>`;

// A page that throws on load (React-hydration-style crash) — must be caught as a page error.
const CRASHES = `<!doctype html><html><body><script>throw new Error("boom on load");</script></body></html>`;

// A page that opens a never-ending stream (stand-in for a dev server's HMR websocket): the network
// never goes idle, so a networkidle-based load would hang the full timeout. browser_check must not.
const HMR = `<!doctype html><html><body>ok<script>try{new EventSource('/stream')}catch(e){}</script></body></html>`;

// A page that fetches a missing endpoint (→ 404) — exercises network-error capture (broken API / asset).
const NET = `<!doctype html><html><body>net<script>fetch('/missing-404').catch(function(){})</script></body></html>`;

// A page that logs a console.error from an inline script — exercises console capture WITH source location.
const CONSOLE = `<!doctype html><html><body>c<script>console.error('boom-console-msg')</script></body></html>`;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/stream") {
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: hi\n\n")); /* never closed → keeps the connection open */ } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/missing-404") return new Response("nope", { status: 404 }); // for the NET page's fetch
    const body = p === "/broken" ? BROKEN : p === "/crash" ? CRASHES : p === "/hmr" ? HMR : p === "/net" ? NET : p === "/console" ? CONSOLE : WORKING;
    return new Response(body, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://localhost:${server.port}`;

// Build the same before/after toggle assertion the agent would write.
const togglePlan = (path: string) => ({
  url: `${base}${path}`,
  actions: [
    { eval: "window.__b = getComputedStyle(document.body).backgroundColor" },
    { click: "button[aria-label*='Theme']" },
    { wait: 150 },
  ],
  assert: [
    { describe: "body background changed after clicking the toggle", eval: "getComputedStyle(document.body).backgroundColor !== window.__b", truthy: true },
    { describe: "data-theme flipped to dark", eval: "document.documentElement.getAttribute('data-theme')", equals: "dark" },
  ],
});

try {
  // Probe once; if Chromium can't launch here, skip the whole suite cleanly.
  const probe = await runBrowserCheck({ url: base, timeoutMs: 8000 });
  if (probe.error && /could not launch|not available/i.test(probe.error)) {
    console.log(`⚠ SKIP browser-check smoke — ${probe.error}`);
    server.stop(true);
    process.exit(0);
  }

  check("loads a page with no assertions → ok (no errors)", probe.ok, probe.error ?? JSON.stringify(probe.assertions));

  const good = await runBrowserCheck(togglePlan("/"));
  check("WORKING toggle → browser_check PASSES", good.ok, formatBrowserCheck(good));
  check("  · both assertions passed", good.assertions.length === 2 && good.assertions.every((a) => a.ok));

  const bad = await runBrowserCheck(togglePlan("/broken"));
  check("BROKEN toggle → browser_check FAILS (catches the inert toggle)", !bad.ok);
  check("  · the 'background changed' assertion is the one that failed", bad.assertions[0] && bad.assertions[0].ok === false);

  const crash = await runBrowserCheck({ url: `${base}/crash`, assert: [{ describe: "page loaded without crashing", eval: "true", truthy: true }] });
  check("page that throws on load → FAILS via captured page error", !crash.ok && crash.pageErrors.length > 0, JSON.stringify(crash.pageErrors));

  const gone = await runBrowserCheck({ url: "http://localhost:1/", timeoutMs: 3000 });
  check("unreachable URL → reported as an error, not a false pass", !gone.ok && !!gone.error);

  // Regression guard: a page with a persistent open connection (HMR-style) must load FAST — proving we
  // navigate on "load", not "networkidle" (which would hang the full timeout on every dev-server call).
  const t0 = Date.now();
  const hmr = await runBrowserCheck({ url: `${base}/hmr`, assert: [{ describe: "page loaded despite an open stream", eval: "document.body.textContent.includes('ok')", truthy: true }] });
  const ms = Date.now() - t0;
  check("page with a never-idle network loads fast (no networkidle hang)", hmr.ok && ms < 8000, `${ms}ms`);

  // Vision capture: captureImage returns a base64 PNG a vision model can SEE. PNG bytes always start
  // with the signature \x89PNG\r\n\x1a\n, which base64-encodes to a leading "iVBORw0KGgo".
  const shot = await runBrowserCheck({ url: base, captureImage: true });
  check("captureImage → a non-empty base64 PNG (vision payload)", !!shot.imageBase64 && shot.imageBase64.length > 100 && shot.imageBase64.startsWith("iVBORw0KGgo"), (shot.imageBase64 ?? "").slice(0, 16));
  check("captureImage reports image/png media type", shot.imageMediaType === "image/png");
  // Default (no captureImage): no base64 payload — non-vision sessions don't pay for it.
  const noShot = await runBrowserCheck({ url: base });
  check("no captureImage → no base64 payload (non-vision path stays lean)", noShot.imageBase64 === undefined);

  // ── accessibility-tree snapshot: structured element context the model can target ──
  const snap = await runBrowserCheck({ url: base });
  check("a11y snapshot captured by default", !!snap.a11ySnapshot && snap.a11ySnapshot.length > 0);
  check("a11y snapshot surfaces the button role + its accessible name", !!snap.a11ySnapshot && /button/i.test(snap.a11ySnapshot) && snap.a11ySnapshot.includes("toggle"));
  check("a11y snapshot appears in the model-readable report", formatBrowserCheck(snap).includes("accessibility tree"));
  const noSnap = await runBrowserCheck({ url: base, snapshot: false });
  check("snapshot:false → no a11y snapshot (opt-out honored)", noSnap.a11ySnapshot === undefined);

  // ── network capture: failed / 4xx-5xx requests ──
  const net = await runBrowserCheck({ url: `${base}/net`, actions: [{ wait: 600 }] });
  check("network capture: a 404 fetch is recorded (broken API / asset)", net.networkErrors.some((e) => e.includes("404") && e.includes("/missing-404")));
  check("network errors appear in the report", formatBrowserCheck(net).includes("failed network requests"));
  const noNet = await runBrowserCheck({ url: `${base}/net`, actions: [{ wait: 600 }], network: false });
  check("network:false → capture disabled (opt-out honored)", noNet.networkErrors.length === 0);

  // ── source-mapped-style stack traces: the page-error carries a stack, not just the message ──
  const crashStack = await runBrowserCheck({ url: `${base}/crash`, assert: [{ describe: "loaded", eval: "true", truthy: true }] });
  check("page error carries the message", crashStack.pageErrors.length > 0 && crashStack.pageErrors[0].includes("boom on load"));
  check("page error carries a STACK (frame/location), not just the message", crashStack.pageErrors[0].includes("\n") || /\bat\b|:\d+:\d+/.test(crashStack.pageErrors[0]));

  // ── console error capture with source location ──
  const con = await runBrowserCheck({ url: `${base}/console`, actions: [{ wait: 100 }] });
  check("console.error captured with its text", con.consoleErrors.some((e) => e.includes("boom-console-msg")));
  check("console.error carries a source location (url:line)", con.consoleErrors.some((e) => /:\d+\)/.test(e)));
} finally {
  server.stop(true);
}

console.log("");
if (fail) { console.error("✗ browser-check smoke FAILED"); process.exit(1); }
console.log("✓ browser-check smoke passed");
