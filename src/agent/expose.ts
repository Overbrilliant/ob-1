// expose_port — public hosting for a local server (gap 8.4). Background servers from run_bash are
// localhost-only; this opens a public tunnel to one so the work can be tested via a real URL (and shared).
// It auto-selects whichever tunnel client is installed — cloudflared (anonymous quick tunnel, no account),
// localtunnel (via npx), or localhost.run (ssh, no install) — launches it as a tracked background process
// (so it shows in the footer and is reaped on exit), and waits for the public URL to appear in its output.
// The provider table, command construction, and URL extraction are pure + exported for tests; the live
// launch reuses the ProcRegistry the same way run_bash(background:true) does.
import { type CmdRunner, spawnCapture, hasBinary } from "./exec.ts";
import type { ProcRegistry } from "./procs.ts";
import { makeProcKiller } from "./procs.ts";

export type TunnelProvider = "cloudflared" | "localtunnel" | "localhost.run";

interface ProviderSpec {
  /** PATH binary that must exist for this provider (localhost.run needs ssh; localtunnel needs npx). */
  bin: string;
  argv: (port: number) => string[];
  /** Pull the public URL out of a chunk of the tunnel's stdout/stderr. */
  match: (text: string) => string | null;
}

const PROVIDERS: Record<TunnelProvider, ProviderSpec> = {
  cloudflared: {
    bin: "cloudflared",
    argv: (port) => ["cloudflared", "tunnel", "--url", `http://localhost:${port}`],
    match: (t) => (t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i) || [])[0] ?? null,
  },
  localtunnel: {
    bin: "npx",
    argv: (port) => ["npx", "--yes", "localtunnel", "--port", String(port)],
    match: (t) => (t.match(/https:\/\/[a-z0-9-]+\.loca\.lt/i) || [])[0] ?? null,
  },
  "localhost.run": {
    bin: "ssh",
    argv: (port) => ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-R", `80:localhost:${port}`, "nokey@localhost.run"],
    match: (t) => (t.match(/https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/i) || [])[0] ?? null,
  },
};

export const TUNNEL_ORDER: TunnelProvider[] = ["cloudflared", "localtunnel", "localhost.run"];

/** The argv for a provider+port (pure). */
export function tunnelCommand(provider: TunnelProvider, port: number): string[] { return PROVIDERS[provider].argv(port); }

/** Extract the public URL a provider prints (pure). */
export function extractTunnelUrl(provider: TunnelProvider, text: string): string | null { return PROVIDERS[provider].match(text); }

/** First installed provider (honors an explicit preference first), or null. Detection is injectable. */
export async function pickProvider(prefer?: TunnelProvider, run: CmdRunner = spawnCapture): Promise<TunnelProvider | null> {
  const order = prefer ? [prefer, ...TUNNEL_ORDER.filter((p) => p !== prefer)] : TUNNEL_ORDER;
  for (const p of order) if (await hasBinary(PROVIDERS[p].bin, run)) return p;
  return null;
}

export interface ExposeCtx { cwd: string; procs?: ProcRegistry; run?: CmdRunner; signal?: AbortSignal; waitMs?: number }

/** Open a public tunnel to localhost:<port>. Launches the tunnel detached (tracked in procs), drains its
 *  output, and resolves once the public URL appears (or after waitMs). Returns an agent-readable status. */
export async function exposePort(port: number, ctx: ExposeCtx, prefer?: TunnelProvider): Promise<string> {
  const run = ctx.run ?? spawnCapture;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`expose_port needs a valid port (1-65535), got ${port}`);
  if (!ctx.procs) return "expose_port: no process registry available in this context (it works in the interactive CLI). Use run_bash to start a tunnel manually.";
  const provider = await pickProvider(prefer, run);
  if (!provider) return "expose_port: no tunnel client found. Install one of: `cloudflared` (recommended, anonymous quick tunnels), or ensure `npx` (localtunnel) or `ssh` (localhost.run) is available — then retry.";

  const argv = tunnelCommand(provider, port);
  const proc = Bun.spawn(argv, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  const command = `expose_port :${port} (${provider})`;
  const id = ctx.procs.add(command, makeProcKiller(proc.pid, (sig) => proc.kill(sig as any), true), proc.pid, true, ctx.cwd);
  const dec = new TextDecoder();
  let url: string | null = null;
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; const chunk = dec.decode(value, { stream: true }); if (id !== undefined) ctx.procs!.appendOutput(id, chunk); if (!url) url = extractTunnelUrl(provider, chunk); } }
    catch { /* torn down on kill */ } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
  };
  void drain(proc.stdout); void drain(proc.stderr);
  void proc.exited.then(() => { if (id !== undefined) ctx.procs!.remove(id); });

  // Poll the buffered output for the URL until it appears or we time out (the tunnel keeps running either way).
  const deadline = Date.now() + (ctx.waitMs ?? 30_000);
  while (!url && Date.now() < deadline && !ctx.signal?.aborted) {
    url = extractTunnelUrl(provider, ctx.procs.tail(id ?? -1, 16_000));
    if (url) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (ctx.signal?.aborted) { try { ctx.procs.kill(id ?? -1); } catch { /* ignore */ } return "expose_port: aborted."; }
  if (!url) return `expose_port: started ${provider} (process #${id}) for localhost:${port}, but no public URL appeared within ${(ctx.waitMs ?? 30_000) / 1000}s. Check list_bash(#${id}) for its output; it may still come up.`;
  return `Public URL for localhost:${port} → ${url}  (via ${provider}, background process #${id}; kill_bash(${id}) to stop). This is a temporary tunnel — test against it, but don't treat it as production hosting.`;
}
