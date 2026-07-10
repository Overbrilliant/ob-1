// /rewind checkpointing — modeled on Claude Code's checkpoints, but built on a SHADOW git repo so it can
// revert the whole project worktree reliably.
//
// How it works (and why this shape):
//   • A SEPARATE git repository (its own GIT_DIR under the OB-1 data dir) with the project root as its
//     work-tree. Every command runs against that git dir, so we NEVER touch the user's real .git —
//     no commits, branches, staging, or reflog in their repo. The project need not be a git repo at all.
//   • Before each user prompt we snapshot the entire worktree: `git add -A` (which respects the project's
//     own .gitignore and always skips any `.git` directory) then `commit --allow-empty`. The data dir is
//     excluded via the shadow repo's info/exclude so we never snapshot the db / worktrees / the shadow
//     repo itself. allow-empty means every prompt yields a checkpoint even when nothing changed.
//   • Restore reverts the worktree to a snapshot with `git add -A` (stage anything created since, incl.
//     untracked) then `git reset --hard <sha>` — so files created after the snapshot are removed, deleted
//     files are restored, and modifications are reverted. Ignored files (node_modules, …) are never tracked
//     and so are never touched. Unlike Claude Code's tool-only file history, this also reverts changes made
//     by `run_bash` (rm/mv/sed/…), since it snapshots the actual filesystem state.
//
// Conversation rewind (truncating the in-memory history) is handled by the caller — this module owns only
// the code side + the checkpoint log. Per-checkpoint metadata is appended to a JSONL log next to the repo.
import { join, dirname, relative, isAbsolute } from "node:path";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";

export interface Checkpoint {
  id: string;          // short, human-facing id (sha prefix)
  sha: string;         // shadow-repo commit sha
  ts: string;          // ISO timestamp
  label: string;       // the user prompt this checkpoint precedes (what /rewind lists)
  historyLen: number;  // conversation length BEFORE that prompt — the truncation point for convo restore
  session: string;     // session id; conversation restore is only meaningful within the same session
}

/** Just the slice of Config the store needs — keeps it unit-testable without a full Config. */
export interface CheckpointEnv { cwd: string; dataDir: string }

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export class CheckpointStore {
  private gitDir: string;
  private logPath: string;
  private inited = false;

  constructor(private env: CheckpointEnv, private session: string) {
    this.gitDir = join(env.dataDir, "checkpoints", "git");
    this.logPath = join(env.dataDir, "checkpoints", "log.jsonl");
  }

  /** Run a git command against the SHADOW repo (separate git dir, project root as work-tree). */
  private git(args: string[]): { code: number; stdout: string; stderr: string } {
    const p = Bun.spawnSync(
      ["git", "--git-dir", this.gitDir, "--work-tree", this.env.cwd,
        "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...args],
      { cwd: this.env.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: this.env.cwd } },
    );
    return { code: p.exitCode ?? -1, stdout: dec(p.stdout), stderr: dec(p.stderr) };
  }

  /** Is the `git` binary usable? (Checkpointing degrades to a no-op when it isn't.) */
  available(): boolean {
    try { return (Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode ?? -1) === 0; }
    catch { return false; }
  }

  /** Create the shadow repo on first use (idempotent). Sets info/exclude to skip the OB-1 data dir. */
  private ensureInit(): boolean {
    if (this.inited) return true;
    if (existsSync(join(this.gitDir, "HEAD"))) { this.inited = true; return true; }
    mkdirSync(this.gitDir, { recursive: true });
    if (this.git(["init", "-q"]).code !== 0) return false;
    // Exclude the data dir (it lives inside cwd and holds this very repo + the db) from snapshots. git
    // already skips any nested `.git`, so we don't need to list that. Best-effort.
    try {
      const rel = relative(this.env.cwd, this.env.dataDir);
      const lines = ["# OB-1 checkpoint excludes"];
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) lines.push("/" + rel.replace(/\\/g, "/") + "/");
      mkdirSync(join(this.gitDir, "info"), { recursive: true });
      appendFileSync(join(this.gitDir, "info", "exclude"), "\n" + lines.join("\n") + "\n");
    } catch { /* exclude is best-effort */ }
    this.inited = true;
    return true;
  }

  /** Snapshot the whole worktree before a prompt. Returns the checkpoint, or null if git is unavailable
   *  / the snapshot failed (caller treats null as "checkpointing not active this turn"). Best-effort. */
  snapshot(label: string, historyLen: number, now = new Date()): Checkpoint | null {
    if (!this.available() || !this.ensureInit()) return null;
    this.git(["add", "-A"]); // respects the project .gitignore; skips .git; tolerate partial failures
    const msg = `ckpt: ${label.replace(/\s+/g, " ").trim().slice(0, 100) || "(empty)"}`;
    const commit = this.git([
      "-c", "user.name=ob1", "-c", "user.email=ob1@local", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "--no-verify", "-q", "-m", msg,
    ]);
    if (commit.code !== 0) return null;
    const sha = this.git(["rev-parse", "HEAD"]).stdout.trim();
    if (!sha) return null;
    const ck: Checkpoint = { id: sha.slice(0, 8), sha, ts: now.toISOString(), label: label.trim(), historyLen, session: this.session };
    try { mkdirSync(dirname(this.logPath), { recursive: true }); appendFileSync(this.logPath, JSON.stringify(ck) + "\n"); }
    catch { /* the commit is the source of truth; a log-append failure just hides it from the list */ }
    return ck;
  }

  /** All checkpoints, oldest → newest (the order prompts were made). Reads the JSONL log; tolerates
   *  corrupt lines. Filters to checkpoints whose commit still exists in the shadow repo. */
  list(): Checkpoint[] {
    let raw = "";
    try { raw = readFileSync(this.logPath, "utf8"); } catch { return []; }
    const out: Checkpoint[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { const c = JSON.parse(s) as Checkpoint; if (c.sha) out.push(c); } catch { /* skip a torn line */ }
    }
    return out;
  }

  /** True if `sha` is a real commit object in the shadow repo. */
  has(sha: string): boolean {
    return this.inited || existsSync(join(this.gitDir, "HEAD"))
      ? this.git(["cat-file", "-e", `${sha}^{commit}`]).code === 0
      : false;
  }

  /** How many files differ between the current worktree and the snapshot (for a pre-restore preview).
   *  -1 if it can't be computed. */
  changeCount(sha: string): number {
    if (!existsSync(join(this.gitDir, "HEAD"))) return -1;
    this.git(["add", "-A"]); // make untracked files show in the diff too
    const r = this.git(["diff", "--name-only", sha]);
    if (r.code !== 0) return -1;
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).length;
  }

  /** Revert the project worktree to the snapshot `sha`. Stages everything first so files created since the
   *  snapshot are removed by the reset; ignored files are never tracked, so they're left alone. Returns
   *  true on success. The caller should have confirmed with the user — this overwrites uncommitted work. */
  restoreCode(sha: string): boolean {
    if (!this.has(sha)) return false;
    this.git(["add", "-A"]);
    return this.git(["reset", "--hard", sha]).code === 0;
  }
}
