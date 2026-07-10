// create_pr / pr_checks — git PR workflow + CI gate (gaps 8.2, 8.3). A first-class PR primitive over the
// `gh` CLI: derive a branch name, push, and open the PR with a real title/body; then poll `gh pr checks`
// until CI settles so "done" can mean "CI is green". The pure helpers (slugifyBranch, buildGhCreateArgs,
// parsePrChecks) are exported and exhaustively unit-tested; the orchestration takes an injected CmdRunner
// so the whole flow is exercised in a smoke without a real repo, `gh`, or network.
import { type CmdRunner, spawnCapture, hasBinary } from "./exec.ts";

// ── pure helpers ──────────────────────────────────────────────────────────────

/** A git-safe branch from a PR title: `ob1/kebab-title`, ascii, deduped dashes, length-capped. */
export function slugifyBranch(title: string, prefix = "ob1"): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "change";
  return `${prefix}/${slug}`;
}

export interface PrInput { title: string; body?: string; base?: string; branch?: string; draft?: boolean }

/** The `gh pr create` argv (body is passed on stdin via --body-file - to avoid shell-escaping issues). */
export function buildGhCreateArgs(input: { title: string; base: string; head: string; draft?: boolean }): string[] {
  const args = ["gh", "pr", "create", "--title", input.title, "--body-file", "-", "--base", input.base, "--head", input.head];
  if (input.draft) args.push("--draft");
  return args;
}

export type CheckState = "pass" | "fail" | "pending" | "skip";
export interface PrChecksSummary { total: number; passed: number; failed: number; pending: number; skipped: number; failures: string[]; state: "pass" | "fail" | "pending" | "none" }

/** Parse `gh pr checks` output. gh prints TSV rows: name \t state \t elapsed \t url. State words vary by
 *  gh version / provider, so we bucket them. A pending bucket keeps "wait" honest. */
export function parsePrChecks(text: string): PrChecksSummary {
  const s: PrChecksSummary = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, failures: [], state: "none" };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const name = cols[0];
    const word = (cols[1] || "").toLowerCase();
    let bucket: CheckState;
    if (/^(pass|success|completed|neutral)$/.test(word)) bucket = "pass";
    else if (/^(fail|failure|error|cancelled|canceled|timed_out|action_required)$/.test(word)) bucket = "fail";
    else if (/^(skip|skipping|skipped)$/.test(word)) bucket = "skip";
    else if (/^(pending|queued|in_progress|in-progress|waiting|expected)$/.test(word)) bucket = "pending";
    else continue; // a header/summary line, not a check row
    s.total++;
    if (bucket === "pass") s.passed++;
    else if (bucket === "fail") { s.failed++; s.failures.push(name); }
    else if (bucket === "skip") s.skipped++;
    else s.pending++;
  }
  s.state = s.total === 0 ? "none" : s.failed ? "fail" : s.pending ? "pending" : "pass";
  return s;
}

// ── orchestration (uses the injectable runner) ──────────────────────────────────

export interface PrCtx { cwd: string; run?: CmdRunner }

async function git(run: CmdRunner, cwd: string, ...args: string[]) { return run(["git", ...args], { cwd, timeoutMs: 60_000 }); }

async function defaultBase(run: CmdRunner, cwd: string): Promise<string> {
  const r = await git(run, cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
  const m = r.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
  if (m) return m[1];
  // Fall back to whichever of main/master exists locally.
  for (const b of ["main", "master"]) {
    const v = await git(run, cwd, "rev-parse", "--verify", "--quiet", b);
    if (v.code === 0) return b;
  }
  return "main";
}

/** Create a PR for the current work. Does NOT commit — the agent stages/commits via run_bash; this pushes
 *  the branch and opens the PR. Returns a human/agent-readable status (the PR URL on success). */
export async function createPr(input: PrInput, ctx: PrCtx): Promise<string> {
  const run = ctx.run ?? spawnCapture;
  const { cwd } = ctx;
  if (!input?.title?.trim()) throw new Error("create_pr needs a non-empty `title`");
  if (!(await hasBinary("gh", run))) return "create_pr: the GitHub CLI `gh` is not installed (or not on PATH). Install it (https://cli.github.com) and run `gh auth login`, then retry. Meanwhile you can open a PR manually with git + the web UI.";

  const top = await git(run, cwd, "rev-parse", "--show-toplevel");
  if (top.code !== 0) return `create_pr: not inside a git repository (${(top.stderr || top.spawnError || "").trim()}). Run \`git init\` and add a remote first.`;

  const base = (input.base || (await defaultBase(run, cwd))).trim();
  const cur = (await git(run, cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
  let head = (input.branch || (cur && cur !== "HEAD" && cur !== base ? cur : slugifyBranch(input.title))).trim();

  // Move onto the target feature branch if we're not already on it (carries the working changes).
  if (head !== cur) {
    const exists = await git(run, cwd, "rev-parse", "--verify", "--quiet", head);
    const sw = exists.code === 0 ? await git(run, cwd, "checkout", head) : await git(run, cwd, "checkout", "-b", head);
    if (sw.code !== 0) return `create_pr: could not switch to branch "${head}": ${(sw.stderr || "").trim()}`;
  }

  // Refuse to open an empty PR — there must be commits ahead of base. (We never auto-commit.)
  const ahead = await git(run, cwd, "rev-list", "--count", `${base}..HEAD`);
  if (ahead.code === 0 && Number(ahead.stdout.trim()) === 0) {
    return `create_pr: branch "${head}" has no commits ahead of "${base}". Commit your changes first (run_bash: \`git add -A && git commit -m "…"\`), then call create_pr again — it does not auto-commit.`;
  }

  const push = await git(run, cwd, "push", "-u", "origin", "HEAD");
  if (push.code !== 0) return `create_pr: \`git push\` failed: ${(push.stderr || "").trim()}`;

  const body = input.body?.trim() || `Automated change by OB-1.\n\n## Summary\n- ${input.title}`;
  const args = buildGhCreateArgs({ title: input.title, base, head, draft: input.draft });
  const pr = await run(args, { cwd, input: body, timeoutMs: 60_000 });
  if (pr.code !== 0) return `create_pr: \`gh pr create\` failed: ${(pr.stderr || pr.spawnError || "").trim()}`;
  const url = (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || pr.stdout.trim();
  return `Opened PR for "${head}" → "${base}": ${url}`;
}

export interface PrChecksOpts { pr?: number | string; wait?: boolean; timeoutS?: number }

/** Poll `gh pr checks`. With wait:true, re-poll (every 10s) until no checks are pending or timeout. The
 *  sleep is injectable so the wait loop is testable without real time. */
export async function prChecks(opts: PrChecksOpts, ctx: PrCtx, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  const run = ctx.run ?? spawnCapture;
  const { cwd } = ctx;
  if (!(await hasBinary("gh", run))) return "pr_checks: the GitHub CLI `gh` is not installed. Install it and `gh auth login` to poll CI status.";
  const deadline = Date.now() + Math.max(0, Math.min(1800, Number(opts.timeoutS) || 600)) * 1000;
  const argv = ["gh", "pr", "checks", ...(opts.pr != null ? [String(opts.pr)] : [])];
  for (;;) {
    const r = await run(argv, { cwd, timeoutMs: 60_000 });
    // gh exits non-zero when checks have failed OR when there are none — distinguish via the parse.
    const sum = parsePrChecks(r.stdout || r.stderr);
    if (sum.total === 0 && r.code !== 0 && /no checks/i.test(r.stdout + r.stderr)) return "pr_checks: no CI checks are configured for this PR.";
    if (!opts.wait || sum.state !== "pending" || Date.now() >= deadline) {
      const head = sum.state === "pass" ? "✓ all checks passed" : sum.state === "fail" ? "✗ checks FAILED" : sum.state === "pending" ? "… checks still pending (timed out waiting)" : "no checks";
      const detail = `${sum.passed}/${sum.total} passed` + (sum.failed ? `, ${sum.failed} failed` : "") + (sum.pending ? `, ${sum.pending} pending` : "") + (sum.skipped ? `, ${sum.skipped} skipped` : "");
      const fails = sum.failures.length ? `\nfailed: ${sum.failures.join(", ")}` : "";
      const gate = sum.state === "pass" ? "" : "\n(NOT green — do not consider the task done until CI passes.)";
      return `pr_checks: ${head} — ${detail}.${fails}${gate}`;
    }
    await sleep(10_000);
  }
}
