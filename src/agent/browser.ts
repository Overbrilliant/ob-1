// Headless-browser verification (Playwright + Chromium, both shipped as deps). This is the harness's
// EYES: it renders a running app, performs interactions (click/fill/keypress), reads back live DOM /
// computed styles, captures console + page errors (with stack traces) + failed network requests,
// snapshots the accessibility tree, and screenshots — so the agent can confirm a VISUAL / INTERACTIVE
// change actually works. Static checks (typecheck/build) can't see "the toggle doesn't toggle"; this can.
//
// The feedback loop mirrors best-in-class agent browser tooling (chrome-devtools-mcp, Cline): a
// structured accessibility-tree snapshot for cheap element context, a vision screenshot for visual
// verification, and console/network error capture for diagnosis — the hybrid that wins for front-end work.
//
// Dynamically imports Playwright so a non-web project never pays the startup cost, and degrades with a
// clear message (rather than a stack trace) when the browser binaries aren't installed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface BrowserAction {
  click?: string;                          // CSS selector to click
  fill?: { selector: string; text: string }; // type into an input
  press?: string;                          // keyboard key (e.g. "Enter", "Tab")
  waitForSelector?: string;                // block until this appears (visible)
  wait?: number;                           // sleep ms (settling time after a click/animation)
  eval?: string;                           // run a JS expression in page context (e.g. stash a before-value)
}

export interface BrowserAssertion {
  describe: string;                        // human-readable claim, shown in the report
  eval: string;                            // JS expression evaluated in the page; its value is the "actual"
  equals?: unknown;                        // pass if actual === equals
  contains?: string;                       // pass if String(actual).includes(contains)
  truthy?: boolean;                        // pass if actual is truthy (the default when no matcher given)
}

export interface BrowserCheckOpts {
  url: string;
  actions?: BrowserAction[];
  assert?: BrowserAssertion[];
  screenshotPath?: string;                 // where to write a full-page PNG (skipped if omitted)
  captureImage?: boolean;                  // also return a base64 PNG the model can SEE (vision models only)
  snapshot?: boolean;                      // capture the accessibility-tree snapshot (default true)
  network?: boolean;                       // capture failed / 4xx-5xx network requests (default true)
  timeoutMs?: number;                      // per-navigation / per-action timeout (default 15s)
  viewport?: { width: number; height: number };
  signal?: AbortSignal;                    // ESC: close the browser mid-flight so the check returns at once
}

/** Hard caps so a huge page can never blow up the model's context. The a11y tree of a big SPA can be
 *  thousands of lines; failed-request lists can run long under a broken dev server. */
const MAX_SNAPSHOT_CHARS = 6_000;
const MAX_NETWORK_ERRORS = 40;
const MAX_PAGE_ERROR_CHARS = 1_800;        // room for a source-mapped stack, not just the message

export interface AssertionResult { describe: string; ok: boolean; actual: unknown; expected?: string }
export interface BrowserCheckResult {
  ok: boolean;
  url: string;
  steps: string[];                         // log line per action
  assertions: AssertionResult[];
  consoleErrors: string[];                 // console.error(...) emitted by the page (with source location)
  pageErrors: string[];                    // uncaught exceptions WITH stack traces (React hydration crashes land here)
  networkErrors: string[];                 // failed + 4xx/5xx requests (broken APIs / 404 assets)
  a11ySnapshot?: string;                   // accessibility-tree snapshot (structured element context for the model)
  screenshot?: string;
  imageBase64?: string;                    // base64 PNG of the viewport, for a vision model to inspect (when captureImage)
  imageMediaType?: string;                 // MIME of imageBase64 (always "image/png" today)
  error?: string;                          // launch / navigation failure (everything below is then empty)
}

/** Format the "expected" side of an assertion for the report. */
function expectedStr(a: BrowserAssertion): string | undefined {
  if (a.equals !== undefined) return `=== ${JSON.stringify(a.equals)}`;
  if (a.contains !== undefined) return `contains ${JSON.stringify(a.contains)}`;
  if (a.truthy === false) return "falsy";
  return "truthy";
}

function judge(a: BrowserAssertion, actual: unknown): boolean {
  if (a.equals !== undefined) return actual === a.equals;
  if (a.contains !== undefined) return String(actual ?? "").includes(a.contains);
  if (a.truthy === false) return !actual;
  return !!actual; // default
}

/** Shorten a URL for a log line: drop the origin (keep path + query), so a request line reads
 *  "GET /api/users?id=1 → 404" instead of repeating http://localhost:3000 on every entry. */
function shortUrl(u: string): string {
  try { const url = new URL(u); return (url.pathname + url.search) || "/"; }
  catch { return u.slice(0, 120); }
}

/** Render Playwright's legacy accessibility.snapshot() tree as an indented role/name outline — the
 *  fallback when locator.ariaSnapshot() (the modern, preferred ARIA-YAML form) isn't available. Pure. */
function renderAxTree(node: any, depth = 0): string {
  if (!node) return "";
  const pad = "  ".repeat(depth);
  const name = node.name ? ` "${String(node.name).slice(0, 80)}"` : "";
  const self = node.role && node.role !== "WebArea" ? `${pad}- ${node.role}${name}\n` : "";
  const kids = (node.children ?? []).map((c: any) => renderAxTree(c, node.role && node.role !== "WebArea" ? depth + 1 : depth)).join("");
  return self + kids;
}

/** Launch headless Chromium, drive the page through `actions`, evaluate `assert`ions, screenshot, and
 *  return a structured verdict. Never throws — a launch/nav failure comes back as `{ ok:false, error }`. */
export async function runBrowserCheck(opts: BrowserCheckOpts): Promise<BrowserCheckResult> {
  const result: BrowserCheckResult = { ok: false, url: opts.url, steps: [], assertions: [], consoleErrors: [], pageErrors: [], networkErrors: [] };
  const timeout = Math.max(1_000, Math.min(120_000, opts.timeoutMs ?? 15_000));
  // ESC already pressed before we even launched — don't spin up Chromium just to throw it away.
  if (opts.signal?.aborted) { result.error = "stopped by user"; return result; }

  let pw: any;
  try {
    // Keep this non-literal so Bun's fixed single-file bundle check does not inline Playwright's optional
    // native watcher stack. Runtime still resolves it from node_modules when browser_check is used.
    const playwrightPackage = "playwright";
    pw = await import(playwrightPackage);
  } catch {
    result.error = "Playwright is not available in this project. (It ships with OB-1 — if this persists, the install is broken.)";
    return result;
  }

  let browser: any;
  // ESC mid-check: closing the browser makes any in-flight goto/click/eval reject (each is already
  // wrapped in try/catch), so the call unwinds and returns at once instead of running out the timeout.
  // Hoisted above the try so the finally can detach it. No-op until `browser` is assigned.
  const onAbort = () => { try { void browser?.close(); } catch { /* already gone */ } };
  try {
    try {
      browser = await pw.chromium.launch({ headless: true });
    } catch (e) {
      result.error = `could not launch Chromium: ${(e as Error).message}. The browser binary may be missing — run \`bunx playwright install chromium\`.`;
      return result;
    }
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true }); }
    const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
    const page = await context.newPage();
    // Console errors — with the source location (url:line) so the model can pinpoint the offending code.
    page.on("console", (m: any) => {
      if (m.type() !== "error") return;
      let where = "";
      try { const loc = m.location?.(); if (loc?.url) where = ` (${shortUrl(loc.url)}:${loc.lineNumber ?? 0})`; } catch { /* location best-effort */ }
      result.consoleErrors.push((String(m.text()).slice(0, 500) + where).slice(0, 600));
    });
    // Uncaught page errors — capture the FULL stack, not just the message. Dev servers (Vite/webpack)
    // serve source-mapped stacks, so these frames point at the ORIGINAL source lines for free; only a
    // minified production bundle would stay obfuscated (out of scope — browser_check targets dev servers).
    page.on("pageerror", (e: any) => {
      const stack = (e?.stack && String(e.stack)) || String(e?.message ?? e);
      result.pageErrors.push(stack.slice(0, MAX_PAGE_ERROR_CHARS));
    });
    // Network failures — broken APIs and missing assets are a top cause of "the page looks wrong". Capture
    // outright failures (requestfailed) and 4xx/5xx responses. Capped so a flood can't blow up context.
    if (opts.network !== false) {
      page.on("requestfailed", (req: any) => {
        if (result.networkErrors.length >= MAX_NETWORK_ERRORS) return;
        let why = "failed"; try { why = req.failure?.()?.errorText ?? "failed"; } catch { /* ignore */ }
        result.networkErrors.push(`${req.method?.() ?? "GET"} ${shortUrl(req.url())} → ${why}`.slice(0, 200));
      });
      page.on("response", (res: any) => {
        if (result.networkErrors.length >= MAX_NETWORK_ERRORS) return;
        let status = 0; try { status = res.status(); } catch { /* ignore */ }
        if (status >= 400) {
          let method = "GET"; try { method = res.request().method(); } catch { /* ignore */ }
          result.networkErrors.push(`${method} ${shortUrl(res.url())} → ${status}`.slice(0, 200));
        }
      });
    }

    try {
      // Wait for "load", NOT "networkidle". Dev servers (Gatsby/Next/Vite) keep an HMR websocket open, so
      // the network NEVER goes idle — networkidle would burn the ENTIRE timeout on every single call (~15s
      // of dead waiting per check, which made the agent look stuck). "load" fires reliably in a few hundred
      // ms; rely on the caller's waitForSelector / wait actions for any post-hydration settling.
      await page.goto(opts.url, { waitUntil: "load", timeout });
    } catch {
      try { await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout }); }
      catch (e2) { result.error = `could not load ${opts.url}: ${(e2 as Error).message}. Is the dev server running and serving this URL?`; return result; }
    }

    // ── actions ──
    for (const a of opts.actions ?? []) {
      try {
        if (a.waitForSelector) { await page.waitForSelector(a.waitForSelector, { timeout, state: "visible" }); result.steps.push(`waited for ${a.waitForSelector}`); }
        if (a.click) { await page.click(a.click, { timeout }); result.steps.push(`clicked ${a.click}`); }
        if (a.fill) { await page.fill(a.fill.selector, a.fill.text, { timeout }); result.steps.push(`filled ${a.fill.selector}`); }
        if (a.press) { await page.keyboard.press(a.press); result.steps.push(`pressed ${a.press}`); }
        if (typeof a.wait === "number") { await page.waitForTimeout(Math.min(10_000, Math.max(0, a.wait))); result.steps.push(`waited ${a.wait}ms`); }
        if (a.eval) { const v = await page.evaluate(a.eval); result.steps.push(`eval ${a.eval.slice(0, 60)} → ${JSON.stringify(v)?.slice(0, 80)}`); }
      } catch (e) {
        result.steps.push(`✗ action failed (${JSON.stringify(a).slice(0, 80)}): ${(e as Error).message.split("\n")[0]}`);
      }
    }

    // ── assertions ──
    for (const a of opts.assert ?? []) {
      let actual: unknown; let ok = false;
      try { actual = await page.evaluate(a.eval); ok = judge(a, actual); }
      catch (e) { actual = `‹eval error: ${(e as Error).message.split("\n")[0]}›`; ok = false; }
      result.assertions.push({ describe: a.describe, ok, actual, expected: expectedStr(a) });
    }

    // ── accessibility-tree snapshot ──
    // A structured, post-interaction outline of the page's roles + accessible names — the cheap-text
    // half of the hybrid loop. Gives the model reliable element context to reason about and to target in
    // follow-up actions/assertions, WITHOUT a pixel screenshot. Prefer locator.ariaSnapshot() (modern,
    // stable ARIA-YAML, what Playwright-MCP uses); fall back to the legacy accessibility.snapshot() tree.
    if (opts.snapshot !== false) {
      try {
        let snap = "";
        try { snap = String(await page.locator("body").ariaSnapshot()); }
        catch { try { const ax = await page.accessibility.snapshot(); if (ax) snap = renderAxTree(ax).trimEnd(); } catch { /* neither form available */ } }
        if (snap.trim()) {
          result.a11ySnapshot = snap.length > MAX_SNAPSHOT_CHARS
            ? snap.slice(0, MAX_SNAPSHOT_CHARS) + "\n… (snapshot truncated)"
            : snap;
        }
      } catch { /* best-effort — a missing snapshot just omits that section */ }
    }

    // ── screenshot ──
    // File artifact: full-page PNG (human-facing). Best-effort — never fail the check on it.
    if (opts.screenshotPath) {
      try { await page.screenshot({ path: opts.screenshotPath, fullPage: true }); result.screenshot = opts.screenshotPath; }
      catch { /* screenshot is best-effort — never fail the check on it */ }
    }
    // Model image: a VIEWPORT (not full-page) PNG returned as base64, so a vision model can actually SEE
    // the rendered page. Viewport-bounded on purpose — a tall full-page shot can exceed providers' image
    // dimension limits (Anthropic downscales/ rejects very large images) and balloons input tokens.
    if (opts.captureImage) {
      try { const buf = await page.screenshot({ fullPage: false, type: "png" }); result.imageBase64 = Buffer.from(buf).toString("base64"); result.imageMediaType = "image/png"; }
      catch { /* best-effort — a missing image just falls back to the text report */ }
    }

    // Overall: every assertion passes AND no uncaught page errors. (Console errors are surfaced but
    // don't auto-fail — many apps log benign errors; a hard page crash is the real signal.)
    const assertionsOk = result.assertions.every((r) => r.ok);
    result.ok = assertionsOk && result.pageErrors.length === 0 && !result.error;
    return result;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    try { await browser?.close(); } catch { /* already gone */ }
  }
}

/** A default screenshot path under the workspace's .ob1 dir, stamped so checks don't overwrite. */
export function defaultScreenshotPath(cwd: string, stamp: number): string {
  const dir = join(cwd, ".ob1", "screenshots");
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore — screenshot is best-effort */ }
  return join(dir, `check-${stamp}.png`);
}

/** Render a BrowserCheckResult as a compact, model-readable report. */
export function formatBrowserCheck(r: BrowserCheckResult): string {
  if (r.error) return `✗ browser_check could not run: ${r.error}`;
  const lines: string[] = [];
  lines.push(`${r.ok ? "✓ browser_check PASSED" : "✗ browser_check FAILED"} — ${r.url}`);
  if (r.steps.length) lines.push("steps:\n" + r.steps.map((s) => `  · ${s}`).join("\n"));
  if (r.assertions.length) {
    lines.push("assertions:");
    for (const a of r.assertions) lines.push(`  ${a.ok ? "✓" : "✗"} ${a.describe} (expected ${a.expected}, actual ${JSON.stringify(a.actual)?.slice(0, 120)})`);
  }
  if (r.pageErrors.length) {
    // Indent every line of each (multi-line) stack so the trace stays readable under the "!" bullet.
    const fmt = (e: string) => "  ! " + e.split("\n").map((ln, i) => (i === 0 ? ln : "      " + ln)).join("\n");
    lines.push("⚠ uncaught page errors (these usually mean the feature is broken):\n" + r.pageErrors.map(fmt).join("\n"));
  }
  if (r.consoleErrors.length) lines.push("console.error output:\n" + r.consoleErrors.slice(0, 8).map((e) => `  ! ${e}`).join("\n"));
  if (r.networkErrors.length) lines.push("failed network requests (broken APIs / missing assets):\n" + r.networkErrors.slice(0, 20).map((e) => `  ! ${e}`).join("\n"));
  if (r.a11ySnapshot) lines.push("accessibility tree (post-interaction — use these roles/names to target elements):\n" + r.a11ySnapshot.split("\n").map((ln) => "  " + ln).join("\n"));
  if (r.screenshot) lines.push(`screenshot: ${r.screenshot}`);
  return lines.join("\n");
}
