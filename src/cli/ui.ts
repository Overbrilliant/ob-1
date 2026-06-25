// Tiny zero-dependency ANSI helpers + banner. (Ink/TUI is a later phase; R7.)
const ESC = "\x1b[";
const wrap = (code: string) => (s: string) => `${ESC}${code}m${s}${ESC}0m`;

export const c = {
  reset: `${ESC}0m`,
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  brightCyan: wrap("96"),
  gray: wrap("90"),
};

/** Per-mode accent, mirroring the plan's colour language. */
export function modeColor(mode: string): (s: string) => string {
  switch (mode) {
    case "fusion": return c.blue;
    case "council": return c.magenta;
    case "personas": return c.cyan;
    case "adaptive": return c.green;
    default: return c.gray; // solo
  }
}

/** Line-level diff via LCS. Returns tagged lines: " " keep, "-" removed, "+" added. */
export function diffLines(before: string, after: string): { t: " " | "-" | "+"; s: string }[] {
  const a = before.split("\n"), b = after.split("\n");
  const m = a.length, n = b.length;
  if (m * n > 4_000_000) { // too large for an O(mn) table — fall back to a coarse replace
    return [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))];
  }
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: " " | "-" | "+"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "-", s: a[i] }); i++; }
    else { out.push({ t: "+", s: b[j] }); j++; }
  }
  while (i < m) out.push({ t: "-", s: a[i++] });
  while (j < n) out.push({ t: "+", s: b[j++] });
  return out;
}

/** Render a colored unified-style diff for the CLI. Empty string when nothing changed. */
export function renderDiff(before: string, after: string, path = "", cap = 60): string {
  const lines = diffLines(before, after);
  if (!lines.some((l) => l.t !== " ")) return "";
  const shown = lines.slice(0, cap);
  const body = shown
    .map((l) => (l.t === "+" ? c.green("  + " + l.s) : l.t === "-" ? c.red("  - " + l.s) : c.dim("    " + l.s)))
    .join("\n");
  const more = lines.length > cap ? c.dim(`\n    … ${lines.length - cap} more line(s)`) : "";
  return c.dim(`  ┌─ diff: ${path} ─`) + "\n" + body + more;
}

// ─── Friendly error formatting ────────────────────────────────────────────────
// Upstream/model failures arrive as terse strings — often `API <status>: {json}` from http.ts. Dumping
// that raw JSON at the user is unreadable. explainError() turns it into a short, human message + the
// right next step (a clickable action for things you fix in a browser; "continue" only when a retry
// could actually help), and renderError() lays it out as a compact red block for the transcript.

/** A clickable terminal hyperlink (OSC 8). Degrades to "label (url)" when hyperlinks won't work (no TTY,
 *  a dumb terminal, or OB1_NO_HYPERLINKS=1) so the URL is never lost. */
export function link(label: string, url: string): string {
  const supported = !!process.stdout.isTTY && process.env.TERM !== "dumb" && process.env.OB1_NO_HYPERLINKS !== "1";
  if (!supported) return `${label} (${url})`;
  const OSC = "\x1b]8;;", BEL = "\x07";
  return `${OSC}${url}${BEL}${label}${OSC}${BEL}`;
}

export interface FriendlyError {
  title: string;                              // short heading ("Subscription required")
  detail?: string;                            // one human sentence of explanation
  action?: { label: string; url: string };   // a clickable call-to-action (e.g. upgrade)
  hint?: string;                              // a non-URL next step ("Run `ob1 login`.")
  retry: boolean;                             // true ⇒ a retry might help ⇒ offer "continue"
}

/** Map a raw error string to a human-readable, actionable shape. Pure + tested. */
export function explainError(raw: string): FriendlyError {
  const msg = String(raw ?? "").trim();
  // `API <status>: <body>` (http.ts). Body may be JSON ({error, upgrade_url, resets_in_days, …}).
  const m = msg.match(/^API (\d{3}):\s*([\s\S]*)$/);
  const status = m ? Number(m[1]) : undefined;
  const body = m ? m[2] : msg;
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { /* not JSON — keep the raw body */ }
  const serverMsg: string | undefined =
    parsed?.error?.message ?? (typeof parsed?.error === "string" ? parsed.error : undefined) ?? parsed?.message;
  const upgradeUrl: string | undefined = parsed?.upgrade_url ?? parsed?.upgradeUrl;
  const resets: number | undefined = typeof parsed?.resets_in_days === "number" ? parsed.resets_in_days : undefined;
  const resetHint = resets != null ? `Credits reset in ${resets} day${resets === 1 ? "" : "s"}.` : undefined;

  switch (status) {
    case 402: return {
      title: "Subscription required",
      detail: serverMsg || "Your plan doesn't cover intelligent models.",
      action: upgradeUrl ? { label: "Upgrade your plan", url: upgradeUrl } : undefined,
      hint: resetHint, retry: false,
    };
    case 401: return {
      title: "Sign-in needed",
      detail: serverMsg || "Your session has expired.",
      hint: "Run `ob1 login` to sign back in.", retry: false,
    };
    case 403: return {
      title: "Access denied",
      detail: serverMsg || "This account can't use that model or feature.",
      action: upgradeUrl ? { label: "See plans", url: upgradeUrl } : undefined, retry: false,
    };
    case 404: return {
      title: "Not found",
      detail: serverMsg || "The model or endpoint wasn't found — check the model id.", retry: false,
    };
    case 429: return {
      title: "Rate limited",
      detail: serverMsg || "Too many requests right now.",
      hint: "Wait a moment, then retry.", retry: true,
    };
  }
  if (status && status >= 500) return {
    title: "Provider error",
    detail: serverMsg || `The model provider returned a ${status}.`,
    hint: "Usually temporary.", retry: true,
  };
  if (/stream idle|request failed after|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|timed out|timeout|socket/i.test(msg)) return {
    title: "Connection problem",
    detail: "Couldn't reach the model — the network or proxy dropped.",
    hint: "Check your connection, or that the server is running.", retry: true,
  };
  // Unknown shape: surface the cleanest text we have, trimmed — never a wall of JSON.
  return { title: "Model error", detail: (serverMsg || msg).slice(0, 300), retry: true };
}

/** Lay a FriendlyError out as a compact, indented red block for the transcript. The action line is a
 *  clickable (OSC 8) link. Pass `{ action: false }` when the action is also surfaced elsewhere (the TUI's
 *  focusable banner above the prompt) so it isn't shown twice; the REPL has no banner, so it keeps it. */
export function renderFriendly(e: FriendlyError, opts: { action?: boolean } = {}): string {
  const lines = [`  ${c.red("✗ " + e.title)}`];
  if (e.detail) lines.push(`    ${e.detail}`);
  if (e.hint) lines.push(`    ${c.dim(e.hint)}`);
  if (opts.action !== false && e.action) lines.push(`    ${c.cyan("↗ " + link(e.action.label, e.action.url))}`);
  if (e.retry) lines.push(`    ${c.dim('Say "continue" to retry.')}`);
  return lines.join("\n");
}

/** Convenience: parse a raw error string and render it. */
export function renderError(raw: string): string {
  return renderFriendly(explainError(raw));
}

export function banner(): string {
  const art = [
    "   ██████╗ ██████╗      ██╗",
    "  ██╔═══██╗██╔══██╗    ███║",
    "  ██║   ██║██████╔╝═══ ╚██║",
    "  ██║   ██║██╔══██╗     ██║",
    "  ╚██████╔╝██████╔╝     ██║",
    "   ╚═════╝ ╚═════╝      ╚═╝",
  ].join("\n");
  const rule = "  " + "─".repeat(58);
  return [
    "",
    c.bold(c.brightCyan(art)),                              // prominent wordmark
    "",
    "  " + c.bold(c.cyan("OB-1")) + c.dim("  free, multi-agent, token-efficient coding agent") + c.gray("   ·   v0.0.1"),
    c.gray(rule),
    c.cyan("  /help") + c.dim(" commands   ·   ") + c.cyan("/models") + c.dim(" setup   ·   press ") + c.cyan("/") + c.dim(" for menu"), // model shown once, below
    "",
  ].join("\n");
}
