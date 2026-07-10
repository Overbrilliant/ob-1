// Git worktree helper for Fusion real-test scoring (Phase 4). Each candidate is materialized in
// its OWN detached worktree at HEAD so the project's real tests can run against the applied change
// in context — not against an isolated snippet. Worktrees live under .ob1/worktrees (gitignored)
// and MUST be cleaned up by the caller (try/finally) to avoid leaking checkouts.
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, cpSync, mkdtempSync } from "node:fs";
import type { Config } from "../config.ts";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Is `cwd` inside a git work tree? (Worktree scoring needs one; callers fall back otherwise.) */
export function isGitRepo(cwd: string): boolean {
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd, stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 && dec(p.stdout).trim() === "true";
  } catch { return false; }
}

export interface Worktree { path: string; cleanup(): void }

/** Create a detached worktree at HEAD. Note: this snapshots committed HEAD, not the dirty working
 *  tree — uncommitted local changes are not present in the candidate checkout. */
export function createWorktree(cfg: Config, label: string): Worktree {
  const dir = join(cfg.dataDir, "worktrees", `fusion-${process.pid}-${label}-${Math.floor(performance.now())}`);
  const add = Bun.spawnSync(["git", "worktree", "add", "--detach", "--quiet", dir, "HEAD"], {
    cwd: cfg.cwd, stdout: "pipe", stderr: "pipe",
  });
  if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${dec(add.stderr).slice(0, 200)}`);
  return {
    path: dir,
    cleanup() {
      try { Bun.spawnSync(["git", "worktree", "remove", "--force", dir], { cwd: cfg.cwd, stdout: "ignore", stderr: "ignore" }); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      // Drop any stale registration left in .git/worktrees/<name>/ if `remove` failed (idempotent).
      try { Bun.spawnSync(["git", "worktree", "prune"], { cwd: cfg.cwd, stdout: "ignore", stderr: "ignore" }); } catch { /* ignore */ }
    },
  };
}

/** A writable, isolated COPY of the workspace for a worker to edit/run in (Fusion candidates each get
 *  their own, so parallel candidates can't overwrite each other's work). Prefers a git worktree at HEAD
 *  when `cwd` is a repo (cheap, copy-on-write-ish, gitignored under dataDir); otherwise falls back to a
 *  plain recursive directory copy of the live working tree. The copy EXCLUDES the OB-1 data dir (so it
 *  doesn't recurse into its own worktrees/db) and any nested `.git`. Cleanup is the caller's (try/finally).
 *
 *  Caveats: the git-worktree path snapshots committed HEAD (uncommitted edits are absent); the temp-copy
 *  path copies the live tree verbatim (node_modules included — heavier, but correct for running tests). */
export function createWorkspaceCopy(cfg: Config, label: string): Worktree {
  if (isGitRepo(cfg.cwd)) return createWorktree(cfg, label);

  // Copy into the OS temp dir, NOT under cwd/dataDir: cpSync refuses to copy a dir into its own subtree
  // (the check runs before the filter). Still skip the data dir (memory.db etc.) and any stray .git.
  const dir = mkdtempSync(join(tmpdir(), `ob1-copy-${label}-`));
  const data = resolve(cfg.dataDir);
  const gitDir = resolve(cfg.cwd, ".git");
  const skip = (p: string) => p === data || p.startsWith(data + sep) || p === gitDir || p.startsWith(gitDir + sep);
  cpSync(resolve(cfg.cwd), dir, {
    recursive: true, dereference: false, errorOnExist: false, force: true,
    filter: (src) => !skip(resolve(src)),
  });
  return {
    path: dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
