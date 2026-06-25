// Stale-branch / stale-base detection (parity with claw-code's stale_branch / stale_base / branch_lock).
//
// Before an agent edits or pushes, it helps to know the branch is current: a branch BEHIND its upstream
// is working on a stale base (edits may conflict / duplicate upstream work); a DIVERGED branch needs a
// rebase/merge before pushing. analyzeBranch() is pure; readGitState() parses git via an injected exec
// so it's deterministically testable.

export type BranchStatus = "current" | "ahead" | "behind" | "diverged" | "no-upstream" | "detached" | "not-a-repo";

export interface GitState {
  branch?: string;     // current branch name; undefined when detached
  ahead: number;       // commits ahead of upstream
  behind: number;      // commits behind upstream
  hasUpstream: boolean;
  detached: boolean;
  isRepo: boolean;
}

export interface BranchAnalysis {
  status: BranchStatus;
  stale: boolean;          // working on a stale base (behind or diverged) → fetch/rebase before editing
  recommendation: string;
}

/** Classify a git state. `stale` is true when the branch is behind or diverged from its upstream. */
export function analyzeBranch(s: GitState): BranchAnalysis {
  if (!s.isRepo) return { status: "not-a-repo", stale: false, recommendation: "" };
  if (s.detached) return { status: "detached", stale: false, recommendation: "Detached HEAD — checkout a branch before committing." };
  if (!s.hasUpstream) return { status: "no-upstream", stale: false, recommendation: "No upstream set for this branch." };
  if (s.ahead > 0 && s.behind > 0) return { status: "diverged", stale: true, recommendation: `Branch has diverged (${s.ahead} ahead, ${s.behind} behind) — rebase/merge upstream before pushing.` };
  if (s.behind > 0) return { status: "behind", stale: true, recommendation: `Branch is ${s.behind} commit(s) behind upstream — \`git pull --rebase\` to work on a current base.` };
  if (s.ahead > 0) return { status: "ahead", stale: false, recommendation: `Branch is ${s.ahead} commit(s) ahead — push when ready.` };
  return { status: "current", stale: false, recommendation: "" };
}

export type GitExec = (command: string) => Promise<{ code: number; output: string }>;

/** Read the git state via an injected executor (so tests don't shell out). Returns isRepo:false outside
 *  a repo. Uses `git status -b --porcelain=v2` which prints `# branch.ab +A -B` and `# branch.head NAME`. */
export async function readGitState(_cwd: string, exec: GitExec): Promise<GitState> {
  const blank: GitState = { ahead: 0, behind: 0, hasUpstream: false, detached: false, isRepo: false };
  const inside = await exec("git rev-parse --is-inside-work-tree");
  if (inside.code !== 0 || !/true/.test(inside.output)) return blank;
  const st = await exec("git status -b --porcelain=v2");
  if (st.code !== 0) return { ...blank, isRepo: true };
  return { ...parseStatusV2(st.output), isRepo: true };
}

/** Parse `git status -b --porcelain=v2` header lines. Pure + exported for testing. */
export function parseStatusV2(output: string): Omit<GitState, "isRepo"> {
  let branch: string | undefined;
  let ahead = 0, behind = 0, hasUpstream = false, detached = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length).trim();
      if (name === "(detached)") detached = true; else branch = name;
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(-?\d+)\s+-(-?\d+)/);
      if (m) { ahead = Math.max(0, Number(m[1])); behind = Math.max(0, Number(m[2])); hasUpstream = true; }
    }
  }
  return { branch, ahead, behind, hasUpstream, detached };
}
