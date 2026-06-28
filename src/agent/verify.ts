// Self-verification: detect a project's own checks (typecheck/compile, lint, tests, build) and run them
// so the agent can confirm its changes actually work — and self-correct when they don't. Detection is by
// ecosystem marker files; the COMMANDS are the project's own (package.json scripts, cargo, go, etc.), so
// we run what the user already trusts rather than inventing tool invocations. Pure detection + an
// injectable executor keep this deterministically testable (no spawning in the unit tests).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { wrapCommand } from "../safety/sandbox.ts";
import type { SandboxMode } from "../config.ts";

export type CheckKind = "typecheck" | "lint" | "test" | "build";
export interface Check {
  name: string;     // display name, e.g. "typecheck"
  kind: CheckKind;
  command: string;  // the shell command to run
  /** Run in the AUTOMATIC self-fix loop. Only fast, side-effect-free compile gates (typecheck / `cargo
   *  check` / `go build`) — never tests/build/lint, which are slower or noisier and are left to the agent's
   *  judgment via the `verify` tool. */
  auto: boolean;
}

function readMaybe(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function listDir(cwd: string): string[] { try { return readdirSync(cwd); } catch { return []; } }

/** Which JS package manager the project uses (by lockfile), so scripts run the way the user expects. */
function pkgManager(cwd: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}
const runScript = (pm: string, s: string): string => (pm === "npm" ? `npm run ${s}` : `${pm} run ${s}`);
const dlx = (pm: string, c: string): string =>
  pm === "bun" ? `bunx ${c}` : pm === "pnpm" ? `pnpm dlx ${c}` : pm === "yarn" ? `yarn dlx ${c}` : `npx ${c}`;

/** Detect the checks available for the project rooted at cwd. Empty when none are recognized. The agent
 *  chooses which to run (by kind/name) via the `verify` tool; the auto-loop runs only the `auto` ones. */
export function detectChecks(cwd: string): Check[] {
  const checks: Check[] = [];

  // ── JavaScript / TypeScript ──
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    let scripts: Record<string, string> = {};
    try { scripts = (JSON.parse(readMaybe(pkgPath))?.scripts as Record<string, string>) ?? {}; } catch { /* malformed package.json */ }
    const pm = pkgManager(cwd);
    if (scripts.typecheck) checks.push({ name: "typecheck", kind: "typecheck", command: runScript(pm, "typecheck"), auto: true });
    else if (existsSync(join(cwd, "tsconfig.json"))) checks.push({ name: "typecheck", kind: "typecheck", command: dlx(pm, "tsc --noEmit"), auto: true });
    if (scripts.lint) checks.push({ name: "lint", kind: "lint", command: runScript(pm, "lint"), auto: false });
    if (scripts.test) checks.push({ name: "test", kind: "test", command: pm === "npm" ? "npm test" : runScript(pm, "test"), auto: false });
    if (scripts.build) checks.push({ name: "build", kind: "build", command: runScript(pm, "build"), auto: false });
    return checks;
  }

  // ── Rust ──
  if (existsSync(join(cwd, "Cargo.toml"))) {
    checks.push({ name: "check", kind: "typecheck", command: "cargo check", auto: true });
    checks.push({ name: "clippy", kind: "lint", command: "cargo clippy", auto: false });
    checks.push({ name: "test", kind: "test", command: "cargo test", auto: false });
    return checks;
  }

  // ── Go ──
  if (existsSync(join(cwd, "go.mod"))) {
    checks.push({ name: "build", kind: "typecheck", command: "go build ./...", auto: true });
    checks.push({ name: "vet", kind: "lint", command: "go vet ./...", auto: false });
    checks.push({ name: "test", kind: "test", command: "go test ./...", auto: false });
    return checks;
  }

  // ── Python (best-effort; commands fail loudly if the tool isn't installed) ──
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py")) || existsSync(join(cwd, "setup.cfg"))) {
    const py = readMaybe(join(cwd, "pyproject.toml"));
    if (py.includes("[tool.ruff") || existsSync(join(cwd, "ruff.toml"))) checks.push({ name: "ruff", kind: "lint", command: "ruff check .", auto: true });
    if (py.includes("[tool.mypy") || existsSync(join(cwd, "mypy.ini"))) checks.push({ name: "mypy", kind: "typecheck", command: "mypy .", auto: true });
    checks.push({ name: "pytest", kind: "test", command: "pytest -q", auto: false });
    return checks;
  }

  // ── No ecosystem manifest matched: recognize BARE test files run with a language's built-in runner.
  // Small scripts/repos often carry tests with no package.json/pyproject — without this the `verify` tool
  // and explicit-check detection stay blind to them (reporting "no checks" right after the tests passed).
  const files = listDir(cwd);
  const any = (re: RegExp) => files.some((f) => re.test(f));
  if (any(/\.test\.(?:ts|tsx|mts|cts)$/)) checks.push({ name: "test", kind: "test", command: "bun test", auto: false });
  else if (any(/\.(?:test|spec)\.(?:js|mjs|cjs)$/)) checks.push({ name: "test", kind: "test", command: "node --test", auto: false });
  if (any(/^test_.*\.py$/) || any(/_test\.py$/)) checks.push({ name: "pytest", kind: "test", command: "pytest -q", auto: false });

  return checks;
}

/** Scope: "auto" (the fast compile gate), "all", or specific kinds/names (e.g. ["typecheck","test"]). */
export type Scope = "auto" | "all" | string[];

export function selectChecks(all: Check[], scope: Scope): Check[] {
  if (scope === "auto") return all.filter((c) => c.auto);
  if (scope === "all") return all;
  const want = new Set(scope.map((s) => s.toLowerCase()));
  return all.filter((c) => want.has(c.kind) || want.has(c.name.toLowerCase()));
}

/** Parse the `verify` tool's free-form `checks` argument into a Scope. */
export function parseScope(arg: unknown): Scope {
  const s = String(arg ?? "auto").trim().toLowerCase();
  if (!s || s === "auto" || s === "fast") return "auto";
  if (s === "all") return "all";
  return s.split(/[,\s]+/).filter(Boolean);
}

export interface CheckResult { name: string; kind: CheckKind; ok: boolean; output: string; command: string; timedOut: boolean; }
// `timedOut` is true when ANY check was killed by its timeout (code 124) rather than failing on its own
// merits. The caller distinguishes "we couldn't verify in time" from "verification proved a failure" — a
// timeout must NOT feed the self-correct loop (re-running a hanging check just re-hangs). See loop.ts.
export interface VerifyResult { ran: boolean; ok: boolean; results: CheckResult[]; report: string; timedOut: boolean; }

function formatReport(results: CheckResult[]): string {
  return results.map((r) => {
    if (r.ok) return `✓ ${r.name} passed (${r.command})`;
    const tail = r.output.replace(/\s+$/, "").split("\n").slice(-30).join("\n");
    const label = r.timedOut ? "TIMED OUT" : "FAILED";
    return `✗ ${r.name} ${label} (${r.command}):\n${tail || "(no output)"}`;
  }).join("\n\n");
}

export type Exec = (command: string) => Promise<{ code: number; output: string }>;

/** Detect + run the selected checks via the injected executor. Returns each result + a formatted report.
 *  ran:false when nothing matched the scope (no false sense of "verified"). */
export async function runVerification(cwd: string, exec: Exec, scope: Scope = "auto"): Promise<VerifyResult> {
  const all = detectChecks(cwd);
  const picked = selectChecks(all, scope);
  if (!picked.length) {
    return { ran: false, ok: true, results: [], timedOut: false, report: all.length ? "no checks matched that scope (available: " + all.map((c) => c.name).join(", ") + ")" : "no checks detected for this project" };
  }
  const results: CheckResult[] = [];
  for (const c of picked) {
    const { code, output } = await exec(c.command);
    // shellExec returns 124 when it kills a check that blew its timeout — a hang, not a real failure.
    results.push({ name: c.name, kind: c.kind, ok: code === 0, output, command: c.command, timedOut: code === 124 });
  }
  return { ran: true, ok: results.every((r) => r.ok), results, timedOut: results.some((r) => r.timedOut), report: formatReport(results) };
}

/** Real executor: run a check command (sandbox-wrapped), capturing combined stdout+stderr. Killable via
 *  the signal (ESC). A generous default timeout (builds can be slow); a stuck check is killed, not hung. */
export async function shellExec(opts: { cwd: string; sandbox: SandboxMode; command: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ code: number; output: string }> {
  const argv = wrapCommand(opts.sandbox, opts.cwd, opts.command);
  const proc = Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const onAbort = () => { try { proc.kill(); } catch { /* gone */ } };
  opts.signal?.addEventListener("abort", onAbort);
  let out = "";
  const dec = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); } }
    catch { /* torn down on kill */ } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
  };
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 300_000);
  try {
    const drained = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); });
    const outcome = await Promise.race([proc.exited.then(() => "exited" as const), timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      try { proc.kill(); } catch { /* gone */ }
      await Promise.race([drained, new Promise((r) => setTimeout(r, 200))]);
      return { code: 124, output: `${out}\n[check timed out after ${Math.round(timeoutMs / 1000)}s — killed]`.slice(0, 20_000) };
    }
    const code = await proc.exited;
    await Promise.race([drained, new Promise((r) => setTimeout(r, 150))]);
    return { code, output: out.slice(0, 20_000) };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
