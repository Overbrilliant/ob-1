// Write-capable parallel subagents — PLAN-V2 item #2 / SUBAGENTS-PLAN Phase C. OPT-IN, default OFF
// (OB1_SUBAGENTS_WRITE) and the riskiest feature in the codebase: parallel writes are the survey's
// #1 footgun (a "clean merge into a broken build"), so this is built loud and refuses rather than
// guesses. Subagents stay read-only by default (see subagents.ts); this path is only taken when the
// flag is on AND the caller declares an explicit disjoint file assignment per agent.
//
// Safety model (from web research — Cline agent-teams + the git merge-tree preflight pattern):
//   1. DISJOINT BY CONSTRUCTION — each agent gets an explicit file set; if any two sets intersect we
//      refuse to spawn (partition check) — the cheapest, loudest guard, before any work happens.
//   2. ISOLATED WORKTREES — each agent works in its own git worktree at HEAD (reuses worktree.ts), so
//      there is never a shared-filesystem race.
//   3. PATH-OVERLAP DETECTION (primary) — after work, recompute each agent's ACTUAL changed-file set;
//      if two agents touched the same file (e.g. one wrote out of its lane), that's a conflict even if
//      git could auto-merge. This catches the dangerous "clean-but-wrong" case the textual merge misses.
//   4. ABORT, NEVER CLOBBER — on ANY conflict the whole batch aborts, the overlap is surfaced, and the
//      real working tree is left untouched. No auto-resolve, no take-theirs.
//   5. GATED SEQUENTIAL APPLY — the merge is a single approval-gated step applied to the real tree.
// Source: zylos.ai git-worktree parallel-AI research (merge-tree preflight) + Cline agent teams.
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runWorker, type WorkerEvent, type WorkerResult } from "./runtime.ts";
import { createWorktree, isGitRepo, type Worktree } from "./worktree.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";

export interface WriteAssignment { label: string; task: string; files: string[] }
export interface FileConflict { file: string; labels: string[] }
export interface WriteChange { file: string; content: string }
export interface WriteSubagentsResult {
  ok: boolean;
  conflicts: FileConflict[];
  changes: WriteChange[];      // the proposed merge (empty when ok=false) — applied via a gated step
  results: WorkerResult[];
  reason?: string;             // why ok=false (refused / not-a-repo / overlap)
  totalInputTokens: number;
  totalOutputTokens: number;
}

const norm = (f: string) => f.replace(/^\.\//, "").replace(/\\/g, "/").trim();

/** Pre-spawn partition check: which files appear in more than one agent's DECLARED set. Empty ⇒ the
 *  assignment is a clean partition and it's safe to spawn. (Pure.) */
export function partitionConflicts(assignments: WriteAssignment[]): FileConflict[] {
  const owners = new Map<string, string[]>();
  for (const a of assignments) for (const f of a.files.map(norm)) {
    (owners.get(f) ?? owners.set(f, []).get(f)!).push(a.label);
  }
  return [...owners].filter(([, labels]) => labels.length > 1).map(([file, labels]) => ({ file, labels }));
}

/** Post-work overlap check: which files were ACTUALLY changed by more than one agent (catches an agent
 *  that wrote outside its declared lane). Empty ⇒ the real changes are disjoint. (Pure.) */
export function overlappingChanges(changedByLabel: Map<string, string[]>): FileConflict[] {
  const owners = new Map<string, string[]>();
  for (const [label, files] of changedByLabel) for (const f of files.map(norm)) {
    (owners.get(f) ?? owners.set(f, []).get(f)!).push(label);
  }
  return [...owners].filter(([, labels]) => labels.length > 1).map(([file, labels]) => ({ file, labels }));
}

/** Files changed in a worktree vs its HEAD (porcelain: handles new `??`, modified ` M`, etc.). */
export function gitChangedFiles(dir: string): string[] {
  const p = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"], { stdout: "pipe", stderr: "ignore" });
  if (p.exitCode !== 0) return [];
  return new TextDecoder().decode(p.stdout).split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    // A rename/copy entry renders as "old -> new"; the DESTINATION path is the one that exists in the
    // worktree (and the one we read for the merge). Without this, "old -> new" is treated as one bogus
    // path, corrupting overlap detection and silently dropping the renamed file from the proposed merge.
    .map((path) => { const i = path.indexOf(" -> "); return i >= 0 ? path.slice(i + 4) : path; })
    .filter(Boolean).map(norm);
}

/** Run write-capable subagents in isolated worktrees with full conflict guarding. Returns the proposed
 *  merge (for a gated apply) or a conflict report — it NEVER touches the real working tree itself. */
export async function runWriteSubagents(opts: {
  assignments: WriteAssignment[];
  cfg: Config;
  tools: Map<string, Tool>;
  onEvent?: (ev: WorkerEvent) => void;
  signal?: AbortSignal;
  _run?: typeof runWorker;
  _worktree?: (cfg: Config, label: string) => Worktree; // injectable for tests
}): Promise<WriteSubagentsResult> {
  const empty = { changes: [], results: [], conflicts: [], totalInputTokens: 0, totalOutputTokens: 0 };
  if (opts.assignments.length === 0) return { ok: true, ...empty };

  // Guard 1: declared sets must be a clean partition.
  const declared = partitionConflicts(opts.assignments);
  if (declared.length) return { ok: false, ...empty, conflicts: declared, reason: "declared file sets overlap — refusing to spawn (assign each file to exactly one agent)" };

  // Worktrees need a git repo.
  if (!isGitRepo(opts.cfg.cwd)) return { ok: false, ...empty, reason: "write-subagents need a git repository (worktree isolation)" };

  const run = opts._run ?? runWorker;
  const mkWt = opts._worktree ?? createWorktree;
  const worktrees: Worktree[] = [];
  const results: WorkerResult[] = [];
  const changedByLabel = new Map<string, string[]>();
  let inTok = 0, outTok = 0;
  try {
    // Each agent works in its OWN worktree (sequential here — isolation, not speed, is the point; the
    // worktrees could run in parallel but the merge is what we're protecting).
    for (const a of opts.assignments) {
      if (opts.signal?.aborted) break;
      const wt = mkWt(opts.cfg, a.label);
      worktrees.push(wt);
      const res = await run({
        label: a.label,
        task: `${a.task}\n\nYou MAY edit ONLY these files (your assigned lane): ${a.files.join(", ")}. Do not touch any other file.`,
        system: "You are a write-capable subagent in an ISOLATED git worktree. Make the change to your assigned files using your tools, then report what you did — no preamble.",
        cfg: { ...opts.cfg, cwd: wt.path }, // tools operate inside the worktree
        tools: opts.tools,
        onEvent: opts.onEvent, signal: opts.signal,
      });
      results.push(res);
      inTok += res.inputTokens; outTok += res.outputTokens;
      changedByLabel.set(a.label, gitChangedFiles(wt.path));
    }

    // Aborted (ESC) mid-dispatch: some agents never ran, so the changes we DID gather are only a partial
    // slice of the batch. Returning ok:true here would let the caller apply a half-finished merge — exactly
    // the "clean but wrong" footgun this module exists to prevent. Refuse: nothing is applied.
    if (opts.signal?.aborted || worktrees.length < opts.assignments.length) {
      return { ok: false, changes: [], conflicts: [], results, reason: "aborted before all subagents finished — nothing applied", totalInputTokens: inTok, totalOutputTokens: outTok };
    }

    // Guard 3: actual changes must be disjoint (an agent may have written out of its lane).
    const overlap = overlappingChanges(changedByLabel);
    if (overlap.length) {
      return { ok: false, conflicts: overlap, changes: [], results, reason: "agents changed overlapping files — aborted, working tree untouched", totalInputTokens: inTok, totalOutputTokens: outTok };
    }

    // Clean: gather the proposed changes (read each changed file from its worktree). Disjoint by the
    // checks above, so this is a safe union — applied later through the gated step.
    const changes: WriteChange[] = [];
    for (const wt of worktrees) {
      const a = opts.assignments[worktrees.indexOf(wt)];
      for (const f of changedByLabel.get(a.label) ?? []) {
        try { changes.push({ file: f, content: readFileSync(join(wt.path, f), "utf8") }); } catch { /* deleted/binary — skip */ }
      }
    }
    return { ok: true, conflicts: [], changes, results, totalInputTokens: inTok, totalOutputTokens: outTok };
  } finally {
    for (const wt of worktrees) wt.cleanup(); // always remove the throwaway worktrees
  }
}

/** Apply an approved merge to the real working tree (the single gated write step). `approve` gates the
 *  whole batch — the human sees the file list before anything lands. Returns the files written. */
export async function applyMerge(cwd: string, changes: WriteChange[], approve?: (desc: string) => Promise<boolean>): Promise<string[]> {
  if (changes.length === 0) return [];
  if (approve && !(await approve(`apply ${changes.length} file change(s) from write-subagents: ${changes.map((c) => c.file).join(", ")}`))) return [];
  const written: string[] = [];
  for (const ch of changes) {
    const dest = join(cwd, ch.file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, ch.content);
    written.push(ch.file);
  }
  return written;
}
