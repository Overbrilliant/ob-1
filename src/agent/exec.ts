// Shared, injectable command runner for the delivery tools (create_pr, pr_checks, expose_port). Keeping
// the spawn behind a `CmdRunner` interface is what makes those tools testable WITHOUT a real `gh` /
// `cloudflared` / network: a smoke passes a scripted fake runner and asserts the exact argv sequence and
// the parsing of canned output, while production passes `spawnCapture` (real Bun.spawn). A spawn that
// fails to start (binary missing → ENOENT) is normalized to {code:127, spawnError} rather than throwing,
// so callers can emit actionable "X isn't installed" guidance instead of a stack trace.

export interface CmdResult { code: number; stdout: string; stderr: string; spawnError?: string }
export type CmdRunner = (argv: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<CmdResult>;

export const spawnCapture: CmdRunner = async (argv, opts = {}) => {
  try {
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: opts.input != null ? new TextEncoder().encode(opts.input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, opts.timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      return { code, stdout, stderr };
    } finally { if (timer) clearTimeout(timer); }
  } catch (e) {
    // Bun throws (ENOENT) when the binary doesn't exist — surface it as a non-zero result, not a throw.
    const msg = (e as Error).message ?? String(e);
    return { code: 127, stdout: "", stderr: msg, spawnError: msg };
  }
};

/** True when a binary is on PATH. Uses the runner so it's mockable in tests. */
export async function hasBinary(bin: string, run: CmdRunner = spawnCapture): Promise<boolean> {
  const r = await run(["bash", "-lc", `command -v ${bin.replace(/[^\w.-]/g, "")} >/dev/null 2>&1 && echo __yes__ || echo __no__`]);
  return /__yes__/.test(r.stdout);
}
