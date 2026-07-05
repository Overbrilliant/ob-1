// `ob1 login` / `ob1 signup` / `ob1 logout` — connect the CLI to the managed OB-1 server. Authentication
// happens ENTIRELY ON THE WEB: the CLI opens the server's sign-in page in the browser, the user logs in
// (email + password, or Google) there, and the server hands a per-user bearer token back to a one-shot
// loopback listener the CLI is running. That token is the ONLY credential the open-source CLI ever holds;
// the real provider keys stay on the server. No passwords are ever typed into the terminal.
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ob1ServerUrl, globalSettingsDir } from "../config.ts";

function authFile(): string { return join(globalSettingsDir(), "auth.json"); }

// ── attribution ────────────────────────────────────────────────────────────────
/** The SINGLE source of truth for the `source` attribution tag added to every browser-opened auth /
 *  checkout URL, so the managed server can attribute the new account / checkout to the CLI (paired with
 *  server-side capture). Callers pass a more specific variant built from this base (e.g.
 *  `${CLI_SOURCE}_onboarding`, `${CLI_SOURCE}_upgrade`). */
export const CLI_SOURCE = "cli";

/** Append the `source` attribution param to a URL WITHOUT clobbering existing query params (idempotent —
 *  a repeated call just overwrites the same key). Used for URLs we build AND ones the server hands back
 *  from the web-login handoff, so attribution is present no matter which branch produced the URL. */
export function withSource(url: string, source: string = CLI_SOURCE): string {
  try { const u = new URL(url); u.searchParams.set("source", source); return u.toString(); }
  catch { return url + (url.includes("?") ? "&" : "?") + "source=" + encodeURIComponent(source); }
}

export function writeAuthToken(token: string): void {
  const dir = globalSettingsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(authFile(), JSON.stringify({ token }, null, 2), { mode: 0o600 });
}

export function clearAuthToken(): void {
  try { rmSync(authFile(), { force: true }); } catch { /* nothing to remove */ }
}

/** Best-effort: open a URL in the user's browser (never throws). */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch { /* user opens it manually */ }
}

/** A tiny success/closing page shown in the browser tab after the loopback callback fires. */
function callbackPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>OB-1</title>
     <style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;
       background:#0b0b0c;color:#e7e7e9}.c{text-align:center;max-width:24rem;padding:2rem}
       h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#a0a0a8;margin:0}</style></head>
     <body><div class="c"><h1>${title}</h1><p>${body}</p></div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to finish in the browser

/** Connect the CLI by signing in ON THE WEB. We open the server's sign-in page in the browser and run a
 *  one-shot loopback HTTP listener; once the user authenticates, the server redirects the browser to that
 *  listener with a freshly-minted token, which we save. mode:"signup" just preselects the Create-account
 *  tab. No credentials are entered in the terminal. */
export async function runLogin(opts: { mode?: "signup" | "login"; source?: string } = {}): Promise<void> {
  const server = ob1ServerUrl();
  const mode = opts.mode ?? "login";
  const source = opts.source ?? CLI_SOURCE;
  const state = crypto.randomUUID();

  let resolveToken!: (t: string | null) => void;
  const tokenP = new Promise<string | null>((r) => { resolveToken = r; });

  let srv: ReturnType<typeof Bun.serve>;
  try {
    srv = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
        const token = u.searchParams.get("token");
        const ok = !!token && u.searchParams.get("state") === state;
        // Resolve only AFTER this response has had a moment to flush to the browser. Resolving inline lets
        // the caller stop the server before the bytes are sent, truncating the page (browser shows a
        // connection error). The small delay guarantees the ✓/✗ page actually renders.
        setTimeout(() => resolveToken(ok ? token! : null), 200);
        return ok
          ? callbackPage("✓ Connected", "You’re signed in. Go back to your terminal to finish setup — you can close this tab.")
          : callbackPage("✗ Sign-in didn’t match", "Please re-run <code>ob1 login</code> in your terminal.");
      },
    });
  } catch (e) {
    console.error(`\n  ✗ Could not start the local sign-in listener (${(e as Error).message}). Run \`ob1 login\` to try again.`);
    process.exitCode = 1;
    return;
  }

  const url = `${server}/activate?port=${srv.port}&state=${encodeURIComponent(state)}&mode=${mode}&source=${encodeURIComponent(source)}`;
  console.log(`\n  ${mode === "signup" ? "Create your account" : "Sign in"} in your browser to connect the CLI.`);
  console.log(`  If it doesn’t open automatically, visit:\n\n    ${url}\n`);
  openBrowser(url);
  process.stdout.write("  Waiting for you to finish in the browser…  (Ctrl-C to cancel)");

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const token = await Promise.race([
    tokenP,
    new Promise<null>((r) => { timeoutId = setTimeout(() => r(null), LOGIN_TIMEOUT_MS); }),
  ]);
  clearTimeout(timeoutId); // don't leave a 5-min timer pending the event loop (runOnboarding / in-TUI re-auth continue running)
  srv.stop(true); // safe to force now: the 200ms resolve delay already flushed the success page

  if (!token) {
    console.error("\n\n  ✗ Login didn’t complete (timed out or cancelled). Run `ob1 login` to try again.");
    process.exitCode = 1;
    return;
  }
  writeAuthToken(token);
  console.log(`\n\n  ✓ Signed in. Token saved to ${authFile()}\n    You're ready — run \`ob1\`.`);
}

export function runLogout(): void {
  clearAuthToken();
  console.log("✓ Signed out (removed the local OB-1 token).");
}
