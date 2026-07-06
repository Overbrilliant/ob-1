// Fusion mode v2 (multimind v2) — best-of-N generation with a REAL selector, grounded in an auto verifier
// signal. Research (2026-07-06) is unambiguous for coding agents: the multi-agent mechanisms with measured
// gains are execution-feedback and best-of-N with a REAL selector (test execution ≫ judge ≫ voting), while
// committee summarization LOSES (a weak member poisons the mix — Self-MoA). So v2 SELECTS a winner over
// merging, and only falls back to judge-synthesis when NOTHING passed.
//
// 1. Fan out the task to N workers that all get the SAME prompt (the only intended variance is sampling,
//    optionally one frontier model per worker). Each works in its OWN writable copy of the project (full
//    tools when mkTools is wired) and produces a complete candidate solution in an isolated context.
// 2. SCORE each candidate against the strongest available objective signal (evaluate.ts): its real final
//    state in its copy (copy-checks) ▸ worktree-at-HEAD real tests ▸ a $OB1_FILE check ▸ syntax. Scoring
//    of a copy happens BEFORE teardown; teardown ALWAYS runs (even on ESC/throw).
// 3. SELECT — never merge — when ≥1 candidate passes: similarity vote ▸ smallest diff ▸ judge PICKS a
//    rating. The winner is returned VERBATIM. Only when 0 candidates pass does a judge SYNTHESIZE a merge
//    (then re-scored, with the revert-to-best guard); if the final artifact still fails, the result is
//    flagged FAILING so the UI can say so out loud — never a silent fail.
import { writeFileSync, rmSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { runWorker, runParallel, readOnlyTools, type WorkerResult, type WorkerEvent } from "./runtime.ts";
import { createWorktree, createWorkspaceCopy, isGitRepo, type Worktree } from "./worktree.ts";
import { detectSignal, evaluateInDir, ensembleModels, type CandidateScore } from "./evaluate.ts";
import { wrapCommand } from "../safety/sandbox.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";
import type { ProcRegistry } from "../agent/procs.ts";

// The shared verdict shape now lives in evaluate.ts (it is the auto-signal's output); re-exported here so
// existing importers (eval/harness.ts, smokes) keep resolving CandidateScore from the fusion module.
export type { CandidateScore } from "./evaluate.ts";

/** Which objective tier actually graded the candidates this run — printed by the UI so the user knows how
 *  much to trust the PASS/FAIL. copy-checks (real state incl. multi-file) is strongest; syntax the weakest. */
export type FusionSignalTier = "copy-checks" | "worktree-tests" | "check" | "syntax" | "none";

/** Worktree real-test scoring options: apply `code` to `targetPath` in a fresh worktree at HEAD, then run
 *  `testCmd` (sandboxed per cfg.sandbox) against the project in context. */
export interface WorktreeScore { cfg: Config; testCmd: string; targetPath: string; label?: string }
export interface Candidate extends WorkerResult { model: string; code?: string; score?: CandidateScore }
export interface FusionResult {
  candidates: Candidate[];
  synthesis: string;
  synthesisScore?: CandidateScore; // objective verdict of the RETURNED artifact (winner's, or the merge's)
  reverted: boolean; // fallback merge failed the check → fell back to the best candidate
  failing: boolean; // the RETURNED artifact still fails the objective signal — the UI must announce it loudly
  /** Set when a candidate was SELECTED verbatim (the winning path). Undefined ⇒ a judge-synthesis fallback. */
  selected?: { label: string; model: string; method: "vote" | "diff" | "judge" };
  signalTier: FusionSignalTier;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Pull the first fenced code block from a model response; fall back to the whole text. */
export function extractCode(text: string): { code: string; lang?: string } {
  const m = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/.exec(text);
  if (m) return { code: m[2].trim(), lang: m[1] || undefined };
  return { code: text.trim() };
}

/** Like extractCode, but also resolves a TARGET FILE PATH for worktree scoring — from the fence info string
 *  (```ts path/to/file.ts) or a leading `// file: path` / `# file: path` comment. */
export function extractCandidateFile(text: string): { code: string; lang?: string; path?: string } {
  const m = /```([a-zA-Z0-9_+-]*)([^\n]*)\n([\s\S]*?)```/.exec(text);
  if (!m) return { code: text.trim() };
  const lang = m[1] || undefined;
  let path: string | undefined = m[2].trim() || undefined; // info string after the language tag
  let code = m[3].trim();
  if (!path) {
    const first = code.split("\n")[0] ?? "";
    const fc = /^(?:\/\/|#)\s*file:\s*(.+)$/i.exec(first);
    if (fc) { path = fc[1].trim(); code = code.split("\n").slice(1).join("\n").trim(); }
  }
  return { code, lang, path };
}

function guessLang(code: string, hint?: string): string {
  if (hint) {
    if (/^(ts|typescript|tsx)$/i.test(hint)) return "ts";
    if (/^(js|javascript|jsx)$/i.test(hint)) return "js";
    if (/^(py|python)$/i.test(hint)) return "py";
  }
  if (/^\s*(def |class .+:|import \w+$)/m.test(code) && !/[;{]\s*$/m.test(code)) return "py";
  return "ts";
}

/** Score a candidate against an objective signal. In order of strength: worktree real-test (apply to a git
 *  worktree at HEAD, run the project's tests) → configured check command → ts/js in-process syntax check
 *  (Bun.Transpiler) → py py_compile. (evaluate.ts handles the STRONGER copy-checks tier; this is the
 *  no-copy fallback and stays the same substrate the eval harness grades single-file artifacts with.) */
export async function scoreCandidate(code: string, opts: { langHint?: string; check?: string; cwd: string; worktree?: WorktreeScore }): Promise<CandidateScore> {
  const lang = guessLang(code, opts.langHint);

  // Strongest signal: materialize the candidate in its own worktree and run real tests in context.
  if (opts.worktree) {
    const { cfg, testCmd, targetPath } = opts.worktree;
    if (!isGitRepo(cfg.cwd)) return { ok: false, exitCode: -1, output: "worktree scoring requires a git repo", checked: false };
    // targetPath is untrusted model output — reject absolute paths and any traversal that escapes the
    // worktree (the write below runs in this process, NOT under the sandbox).
    if (isAbsolute(targetPath)) return { ok: false, exitCode: -1, output: `unsafe target path (absolute): ${targetPath}`, checked: false };
    let wt: { path: string; cleanup(): void } | undefined;
    try {
      wt = createWorktree(cfg, opts.worktree.label ?? "cand");
      const wtPath = wt.path;
      // Resolve SYMLINKS, not just lexical path math: a committed symlink in HEAD (e.g. a dir that points
      // outside the repo) could otherwise let the un-sandboxed write below escape the worktree. Canonicalize
      // the root + the nearest existing ancestor of dest (the non-existent tail can't contain symlinks),
      // and require the write to stay within the real worktree root.
      const realRoot = realpathSync(wtPath);
      const dest = resolve(realRoot, targetPath);
      let existing = dest;
      while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
      const realExisting = realpathSync(existing);
      const tailRel = relative(existing, dest); // lexical remainder past the existing ancestor (no symlinks)
      const finalDest = tailRel ? join(realExisting, tailRel) : realExisting;
      const within = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
      if (!within(realExisting) || !within(finalDest)) return { ok: false, exitCode: -1, output: `unsafe target path (escapes worktree): ${targetPath}`, checked: false };
      mkdirSync(dirname(finalDest), { recursive: true });
      writeFileSync(finalDest, code);
      // A linked worktree's git metadata lives OUTSIDE wtPath: the per-worktree dir (.git/worktrees/<name>/,
      // holds the index) and the COMMON dir (.git, holds objects/refs that `git add`/`commit` write). Grant
      // the sandbox write access to both so git-touching tests don't spuriously fail.
      const gitDir = (flag: string) => {
        const d = new TextDecoder().decode(Bun.spawnSync(["git", "-C", wtPath, "rev-parse", flag], { stdout: "pipe", stderr: "ignore" }).stdout).trim();
        return d ? (isAbsolute(d) ? d : resolve(wtPath, d)) : "";
      };
      const extraWrites = [...new Set([gitDir("--absolute-git-dir"), gitDir("--git-common-dir")].filter(Boolean))];
      const argv = wrapCommand(cfg.sandbox, wtPath, testCmd, extraWrites);
      const p = Bun.spawnSync(argv, { cwd: wtPath, env: { ...process.env } });
      const out = (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)).slice(0, 2000);
      // `git add -A -N` (intent-to-add) so NEW files show in the diff too; plain `git diff` skips untracked.
      Bun.spawnSync(["git", "-C", wt.path, "add", "-A", "-N"], { stdout: "ignore", stderr: "ignore" });
      const diff = new TextDecoder().decode(Bun.spawnSync(["git", "-C", wt.path, "diff"], { stdout: "pipe", stderr: "ignore" }).stdout).slice(0, 2000);
      return { ok: p.exitCode === 0, exitCode: p.exitCode ?? -1, output: out || "(no output)", checked: true, score: p.exitCode === 0 ? 1 : 0, testOutput: out, diff, targetPath };
    } catch (e) {
      return { ok: false, exitCode: -1, output: `worktree scoring error: ${(e as Error).message}`, checked: false };
    } finally {
      wt?.cleanup();
    }
  }

  if (opts.check) {
    const ext = lang === "py" ? "py" : lang === "js" ? "js" : "ts";
    const file = join(tmpdir(), `ob1-fusion-${process.pid}-${Math.floor(performance.now())}.${ext}`);
    writeFileSync(file, code);
    try {
      const p = Bun.spawnSync(["bash", "-lc", opts.check], { cwd: opts.cwd, env: { ...process.env, OB1_FILE: file } });
      const out = (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)).slice(0, 600);
      return { ok: p.exitCode === 0, exitCode: p.exitCode ?? -1, output: out || "(no output)", checked: true, score: p.exitCode === 0 ? 1 : 0 };
    } finally { rmSync(file, { force: true }); }
  }

  if (lang === "ts" || lang === "js") {
    try {
      new Bun.Transpiler({ loader: lang === "ts" ? "tsx" : "jsx" }).transformSync(code);
      return { ok: true, exitCode: 0, output: "syntax ok", checked: true, score: 1 };
    } catch (e) {
      return { ok: false, exitCode: 1, output: String((e as Error).message).slice(0, 600), checked: true, score: 0 };
    }
  }

  if (lang === "py") {
    const file = join(tmpdir(), `ob1-fusion-${process.pid}-${Math.floor(performance.now())}.py`);
    writeFileSync(file, code);
    try {
      const p = Bun.spawnSync(["python3", "-m", "py_compile", file]);
      const out = new TextDecoder().decode(p.stderr).slice(0, 600);
      return { ok: p.exitCode === 0, exitCode: p.exitCode ?? -1, output: out || "syntax ok", checked: true, score: p.exitCode === 0 ? 1 : 0 };
    } catch { return { ok: false, exitCode: -1, output: "python3 not available", checked: false }; }
    finally { rmSync(file, { force: true }); }
  }

  return { ok: false, exitCode: -1, output: "no check available for this language", checked: false };
}

// ── Selection (pure helpers — unit-tested; no model/subprocess) ─────────────────

/** Normalize code/diff for a similarity comparison: strip comments, collapse whitespace, lowercase — so two
 *  solutions that differ only in formatting/comments compare equal. Cheap and language-agnostic. */
export function normalizeCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1") // line comments (the [^:] guard avoids eating `http://`)
    .replace(/(^|\s)#.*$/gm, "$1") // hash comments (py/sh)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Character-trigram Jaccard similarity in [0,1] — robust for "near-identical" code without a parser. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const shingles = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
    if (!set.size && s) set.add(s);
    return set;
  };
  const A = shingles(a), B = shingles(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 1;
}

/** Greedily group items whose similarity to a group's first member is ≥ threshold; returns groups of the
 *  input indices (largest-group-wins is the caller's call). Agentless-style majority voting. */
export function groupBySimilarity(keys: string[], threshold = 0.9): number[][] {
  const groups: number[][] = [];
  const reps: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    let placed = false;
    for (let g = 0; g < groups.length; g++) {
      if (similarity(keys[i], reps[g]) >= threshold) { groups[g].push(i); placed = true; break; }
    }
    if (!placed) { groups.push([i]); reps.push(keys[i]); }
  }
  return groups;
}

/** Parse a judge's 0–5 ratings per candidate label from free-form text. Strict on the NUMBER (0–5 only),
 *  tolerant of surrounding garbage; a `\b<label>\b` token match keeps `cand-1` from matching `cand-10`.
 *  Missing/unparseable labels are simply absent → the caller falls back to the first passing candidate. */
export function parseJudgePicks(text: string, labels: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const lines = text.split("\n");
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${esc}\\b[^\\n\\d]*?([0-5])(?!\\d)`, "i");
    for (const line of lines) {
      const m = re.exec(line);
      if (m) { out[label] = Number(m[1]); break; }
    }
  }
  return out;
}

/** How much a candidate CHANGED — the real diff length when we have one, else the normalized code length as
 *  a proxy for "least change / simplest". Used for the smallest-diff tie-break (prefer the minimal edit). */
function changeSize(c: Candidate): number {
  return c.score?.diff != null ? c.score.diff.length : normalizeCode(c.code ?? c.text).length;
}

/** The comparison key for the similarity vote: a candidate's real diff when available (captures multi-file
 *  edits), else its emitted code block. */
function voteKey(c: Candidate): string {
  return normalizeCode(c.score?.diff || c.code || c.text);
}

/** Fractional score of a candidate/verdict for the revert-to-best guard (a full pass is 1). */
function fracOf(s: CandidateScore | undefined): number {
  return s?.ok ? 1 : s?.score ?? 0;
}

/** PURE selection over the PASSING candidates, up to the point a judge is needed (best-of-N with a REAL
 *  selector — never merging when something passed):
 *   a. similarity vote — a UNIQUE largest group of near-identical solutions wins ("vote");
 *   b. tie → smallest change / least edit ("diff");
 *   c. STILL tied → the caller must run the judge over the returned tied set ("judge").
 *  Returns the winning INDEX (into `passing`) for a/b, or the tied indices for c. */
export function chooseByVoteOrDiff(passing: Candidate[]): { method: "vote" | "diff"; index: number } | { method: "judge"; tied: number[] } {
  if (passing.length === 1) return { method: "vote", index: 0 };
  const groups = groupBySimilarity(passing.map(voteKey), 0.9).sort((a, b) => b.length - a.length);
  const top = groups[0];
  if (top.length >= 2 && (groups.length < 2 || groups[1].length < top.length)) {
    // Within the winning group, the smallest change is the representative (simplest of the agreeing solutions).
    const index = top.reduce((a, b) => (changeSize(passing[b]) < changeSize(passing[a]) ? b : a));
    return { method: "vote", index };
  }
  const sizes = passing.map(changeSize);
  const min = Math.min(...sizes);
  const smallest = passing.map((_, i) => i).filter((i) => sizes[i] === min);
  if (smallest.length === 1) return { method: "diff", index: smallest[0] };
  return { method: "judge", tied: smallest };
}

/** PURE 0-passing fallback decision: keep the judge's merge UNLESS it regressed below the best candidate's
 *  fractional score, in which case revert to that candidate verbatim. Returns the artifact to ship, whether
 *  we reverted, and the verdict that grades the shipped artifact (which drives the FAILING flag). */
export function pickFallback(
  merge: { text: string; score?: CandidateScore },
  best: Candidate | undefined,
): { synthesis: string; reverted: boolean; finalScore?: CandidateScore } {
  const ms = merge.score;
  if (ms?.checked && !ms.ok && best && fracOf(best.score) > fracOf(ms)) {
    return { synthesis: best.text, reverted: true, finalScore: best.score };
  }
  return { synthesis: merge.text, reverted: false, finalScore: ms };
}

// Every candidate gets this exact prompt — sampling (and optionally the model) is the only variance.
const CANDIDATE_SYSTEM =
  "You are an OB-1 Fusion candidate. Investigate with the read-only tools if needed, then output a " +
  "COMPLETE, self-contained solution as a SINGLE fenced code block (full file content if a file is " +
  "targeted). When the solution targets a specific file, put its path on the fence info line " +
  "(```ts path/to/file.ts) so it can be applied and tested. No prose outside the code block.";

// When each candidate has its own writable COPY of the project (mkTools wired), it gets the FULL toolset
// and can actually edit/run/test its way to a working answer before committing to the code block.
const CANDIDATE_SYSTEM_COPY =
  "You are an OB-1 Fusion candidate working in your OWN private, writable COPY of the project with the " +
  "FULL toolset (read, edit, write, run_bash, verify). Implement your solution IN the copy and RUN/TEST " +
  "it until you're confident it works — your copy is isolated, so experiment freely; it is discarded " +
  "after, only your final answer is kept. Then output your COMPLETE, self-contained solution as a SINGLE " +
  "fenced code block (full file content if a file is targeted). When it targets a specific file, put its " +
  "path on the fence info line (```ts path/to/file.ts) so it can be applied and tested. No prose outside the code block.";

const SCORE_TIMEOUT_MS = 120_000; // bound a copy's checks so a hanging test can't freeze fusion

/** Capture a candidate's diff vs the pre-fusion baseline for the judge/selector/apply. A git-worktree copy
 *  diffs vs its HEAD checkout (`add -A -N` so NEW files show); a plain temp-dir copy diffs vs the live
 *  original (excluding heavy/irrelevant trees). Best-effort — a diff is context, never load-bearing. */
function captureCopyDiff(cfg: Config, copyPath: string): string {
  try {
    if (isGitRepo(cfg.cwd)) {
      Bun.spawnSync(["git", "-C", copyPath, "add", "-A", "-N"], { stdout: "ignore", stderr: "ignore" });
      return new TextDecoder().decode(Bun.spawnSync(["git", "-C", copyPath, "diff"], { stdout: "pipe", stderr: "ignore" }).stdout).slice(0, 4000);
    }
    const p = Bun.spawnSync(["diff", "-ruN", "-x", "node_modules", "-x", ".git", "-x", ".ob1", cfg.cwd, copyPath], { stdout: "pipe", stderr: "ignore" });
    return new TextDecoder().decode(p.stdout).slice(0, 4000);
  } catch { return ""; }
}

const TIER_ORDER: FusionSignalTier[] = ["copy-checks", "worktree-tests", "check", "syntax", "none"];
function strongestTier(tiers: Iterable<FusionSignalTier>): FusionSignalTier {
  const set = new Set(tiers);
  return TIER_ORDER.find((t) => set.has(t)) ?? "none";
}

export async function runFusion(opts: {
  task: string;
  cfg: Config;
  tools: Map<string, Tool>;
  n?: number;             // number of candidates (default 3; raised to models.length when more models given)
  models?: string[];      // one per worker (round-robin); default ensembleModels(cfg) (diversity gate)
  check?: string;         // objective check command ($OB1_FILE = candidate path) — the weakest opt-in tier
  concurrency?: number;
  moa?: boolean;          // one Mixture-of-Agents refine layer (candidates see peers) — opt-in
  judgeModel?: string;    // model for the selector/synthesizer (default cfg.model)
  worktree?: boolean;     // explicitly score each candidate in its own git worktree by running real tests
  testCmd?: string;       // test command for the explicit worktree tier (default "bun test")
  targetPath?: string;    // default file path to apply a candidate to when it omits one
  /** Verified-escalation context: prepended to every candidate's task so they FIX a prior failure rather
   *  than restart from scratch. (Wired by the Wave-3 escalation path; harmless when unset.) */
  escalationContext?: string;
  /** Build a fresh tool map scoped to a given cwd (buildTools({...cfg, cwd})). When wired, each candidate
   *  runs with the FULL toolset inside its OWN writable copy of the workspace. Omitted ⇒ read-only shared cwd. */
  mkTools?: (cwd: string) => Map<string, Tool>;
  procs?: ProcRegistry;   // reap any background proc a candidate left in its throwaway copy before teardown
  planMode?: boolean;     // read-only investigation only — no writable copies (mirrors Solo Plan mode)
  onEvent?: (ev: WorkerEvent) => void; // live per-worker progress (candidates / selector) for the UI
  signal?: AbortSignal;                // external cancellation (ESC) — propagated to every worker
  _run?: typeof runWorker; // injectable for deterministic tests
}): Promise<FusionResult> {
  const baseRun = opts._run ?? runWorker;
  let inTok = 0, outTok = 0;
  const run: typeof runWorker = async (o) => { const w = await baseRun({ ...o, onEvent: opts.onEvent, signal: opts.signal }); inTok += w.inputTokens; outTok += w.outputTokens; return w; };
  const roTools = readOnlyTools(opts.tools);
  // Models default to the diversity gate (frontier ensemble on the free router; else the single model). n
  // stays 3 by default, round-robin over however many models the gate returned (as today).
  const baseModels = opts.models?.length ? opts.models : ensembleModels(opts.cfg);
  const n = Math.max(opts.n ?? 3, opts.models?.length ?? 0, 1);
  const specs = Array.from({ length: n }, (_, i) => ({ model: baseModels[i % baseModels.length] }));

  // The strongest objective signal for THIS project — detected once, ZERO env vars required (evaluate.ts).
  const signal = detectSignal(opts.cfg);
  const useWorktree = opts.worktree === true;

  // Verified-escalation: prepend the prior failure so candidates FIX rather than restart. (Spec wording.)
  const escalationPreamble = opts.escalationContext
    ? `A previous single-agent attempt failed verification. Failure report:\n${opts.escalationContext}\nFix the failures; keep what already works.\n\n`
    : "";
  const candidateTask = escalationPreamble + opts.task;

  // Each candidate works in its OWN writable copy when mkTools is wired (and not Plan mode): full tools,
  // isolated, so parallel candidates never clobber each other. Copies are created SEQUENTIALLY (git worktree
  // add contends on .git) but the workers run concurrently; every copy is cleaned up in the finally below.
  const useCopy = !!opts.mkTools && !opts.planMode;
  const copies: (Worktree | undefined)[] = [];
  if (useCopy) {
    for (let i = 0; i < specs.length; i++) {
      try { copies.push(createWorkspaceCopy(opts.cfg, `cand-${i + 1}`)); }
      catch (e) {
        copies.push(undefined);
        opts.onEvent?.({ label: `cand-${i + 1}`, phase: "tool", tool: "(workspace copy failed — read-only fallback)", input: { error: (e as Error).message } });
      }
    }
  }
  const candCfg = (i: number) => (copies[i] ? { ...opts.cfg, cwd: copies[i]!.path } : opts.cfg);
  const candTools = (i: number) => (copies[i] && opts.mkTools ? opts.mkTools(copies[i]!.path) : roTools);
  const candSystem = (i: number) => (copies[i] ? CANDIDATE_SYSTEM_COPY : CANDIDATE_SYSTEM);

  // Resolve a run-level target for the no-copy real-test/fallback tiers (explicit, else the first path any
  // candidate declared) — filled once candidates exist, below.
  let resolvedTarget: string | undefined;

  /** No-copy scoring: the strongest tier available WITHOUT a live workspace copy. Explicit worktree opt-in
   *  ▸ auto worktree-at-HEAD (only when a copy was INTENDED — so eval's single-file grading never runs the
   *  host's suite) ▸ $OB1_FILE check ▸ syntax. Returns the tier used alongside the score. */
  const scoreArtifact = async (text: string, label: string, autoWorktree: boolean): Promise<{ score?: CandidateScore; tier: FusionSignalTier }> => {
    const { code, lang, path } = extractCandidateFile(text);
    if (!code) return { score: undefined, tier: "none" };
    const target = path || resolvedTarget;
    if (useWorktree) {
      // No resolvable path → cannot real-test in a worktree. Mark UNSCORED (checked:false) rather than
      // silently downgrading to a syntax check mislabeled PASS/FAIL alongside real-test verdicts.
      if (!target) return { score: { ok: false, exitCode: -1, output: "no target path — not real-tested (put the path on the fence info line or set OB1_FUSION_TARGET)", checked: false }, tier: "worktree-tests" };
      return { score: await scoreCandidate(code, { langHint: lang, cwd: opts.cfg.cwd, worktree: { cfg: opts.cfg, testCmd: opts.testCmd ?? signal.testCmd ?? "bun test", targetPath: target, label } }), tier: "worktree-tests" };
    }
    if (autoWorktree && signal.tier === "test" && signal.testCmd && target && isGitRepo(opts.cfg.cwd)) {
      return { score: await scoreCandidate(code, { langHint: lang, cwd: opts.cfg.cwd, worktree: { cfg: opts.cfg, testCmd: signal.testCmd, targetPath: target, label } }), tier: "worktree-tests" };
    }
    return { score: await scoreCandidate(code, { langHint: lang, check: opts.check, cwd: opts.cfg.cwd }), tier: opts.check ? "check" : "syntax" };
  };

  const candidates: Candidate[] = [];
  const usedTiers = new Set<FusionSignalTier>();
  try {
    // 1. Generate candidates in parallel from the SAME prompt (isolated contexts/copies, maybe different models).
    let raw = await runParallel(
      specs,
      (s, i) => run({ label: `cand-${i + 1}`, task: candidateTask, system: candSystem(i), cfg: candCfg(i), tools: candTools(i), model: s.model }),
      opts.concurrency ?? n,
    );

    // Optional Mixture-of-Agents refine layer: each candidate sees the peers' drafts and improves once
    // (continuing in its own copy, so it can re-run/test the grafted result). Escalation context carries through.
    if (opts.moa) {
      const peers = raw.map((r, i) => `### candidate ${i + 1}\n\`\`\`\n${extractCode(r.text).code}\n\`\`\``).join("\n\n");
      raw = await runParallel(
        specs,
        (s, i) => run({
          label: `cand-${i + 1}-moa`,
          task: `Task:\n${candidateTask}\n\nPeer candidate solutions:\n\n${peers}\n\nGraft the strongest parts of the peers and fix their mistakes. Output your improved COMPLETE solution as a single fenced code block. No prose outside it.`,
          system: `${candSystem(i)} You are in the refinement layer (Mixture-of-Agents): aggregate the best peer ideas; do not regress correctness; ignore verbosity.`,
          cfg: candCfg(i),
          tools: candTools(i),
          model: s.model,
        }),
        opts.concurrency ?? n,
      );
    }

    resolvedTarget = opts.targetPath ?? raw.map((r) => extractCandidateFile(r.text).path).find(Boolean);

    // 2. SCORE each candidate against the strongest available signal — INSIDE its copy when it has one, so
    //    multi-file edits are graded on the real final state. This MUST run before the finally tears the
    //    copies down; the finally still ALWAYS reaps + removes them (including on the ESC/throw paths).
    for (let i = 0; i < raw.length; i++) {
      const { code, path } = extractCandidateFile(raw[i].text);
      let score: CandidateScore | undefined;
      let tier: FusionSignalTier;
      if (copies[i] && signal.tier !== "none") {
        const diff = captureCopyDiff(opts.cfg, copies[i]!.path); // snapshot the edit BEFORE tests add artifacts
        score = await evaluateInDir(copies[i]!.path, opts.cfg, signal, { signal: opts.signal, timeoutMs: SCORE_TIMEOUT_MS });
        score.diff = diff;
        score.targetPath = path ?? resolvedTarget;
        tier = "copy-checks";
      } else {
        const r = await scoreArtifact(raw[i].text, raw[i].label, useCopy);
        score = r.score;
        tier = r.tier;
      }
      usedTiers.add(tier);
      candidates.push({ ...raw[i], model: specs[i].model, code, score });
    }
  } finally {
    // Reap any background proc a candidate left running INSIDE its copy (kill-by-cwd) BEFORE removing the
    // dir, so a dev server/watcher started in a throwaway copy never orphans. Then remove the copy.
    for (const w of copies) { if (w) { opts.procs?.killByCwd(w.path); w.cleanup(); } }
  }

  const signalTier = strongestTier(usedTiers);

  // ESC after generation: don't spend a selector/synthesizer call on a run the user cancelled.
  if (opts.signal?.aborted) {
    return { candidates, synthesis: "", reverted: false, failing: true, signalTier, totalInputTokens: inTok, totalOutputTokens: outTok };
  }

  // 3. SELECTION-FIRST: if ≥1 candidate PASSED the objective signal, SELECT one verbatim — never merge.
  const passing = candidates.filter((c) => c.score?.checked && c.score.ok);
  if (passing.length) {
    const choice = chooseByVoteOrDiff(passing);
    let winner: Candidate;
    let method: "vote" | "diff" | "judge";
    if (choice.method === "judge") {
      // The vote + smallest-diff couldn't break the tie → the judge PICKS by rating (0–5 per candidate,
      // authors no new code). Parsed strictly; garbage tolerated by falling back to the first passing.
      const tied = choice.tied.map((i) => passing[i]);
      const block = tied.map((c) => `## ${c.label} [${c.model}]\n\`\`\`\n${c.code ?? c.text}\n\`\`\``).join("\n\n");
      const j = await run({
        label: "judge",
        task: `${tied.length} candidate solutions ALL passed the objective check. Rate each 0-5 for correctness and overall quality (do NOT write any new code). Output exactly one line per candidate: \`<label>: <score>\`.\n\n${block}`,
        system: "You are OB-1's Fusion selector. You do NOT author code; you only RATE the given candidates 0-5 and pick the best. Be terse.",
        cfg: opts.cfg, tools: new Map(), model: opts.judgeModel,
      });
      const scores = parseJudgePicks(j.text, tied.map((c) => c.label));
      winner = tied[0];
      let bestScore = -1;
      for (const c of tied) { const s = scores[c.label] ?? -1; if (s > bestScore) { bestScore = s; winner = c; } }
      method = "judge";
    } else {
      winner = passing[choice.index];
      method = choice.method;
    }
    return {
      candidates, synthesis: winner.text, synthesisScore: winner.score, reverted: false, failing: false,
      selected: { label: winner.label, model: winner.model, method },
      signalTier, totalInputTokens: inTok, totalOutputTokens: outTok,
    };
  }

  // 4. FALLBACK (0 passed): the judge MERGES the candidates (the one place synthesis is allowed), grounded
  //    in their verdicts / test output / diffs and instructed to FIX what they failed.
  const block = candidates.map((c) => {
    const verdict = !c.score?.checked ? "UNSCORED" : c.score.ok ? "PASS" : "FAIL";
    const checkOut = c.score && !c.score.ok && c.score.checked ? `(check: ${c.score.output})\n` : "";
    const tests = c.score?.testOutput ? `<test-output>\n${c.score.testOutput}\n</test-output>\n` : "";
    const diff = c.score?.diff ? `<diff>\n${c.score.diff}\n</diff>\n` : "";
    return `## ${c.label} [${c.model}] — ${verdict}\n${checkOut}${tests}${diff}\`\`\`\n${c.code ?? c.text}\n\`\`\``;
  }).join("\n\n");
  const synth = await run({
    label: "synthesizer",
    task: `Fusion generated ${candidates.length} candidate solution(s) to the SAME task, NONE of which passed the objective check:\n\n${block}\n\nProduce the single best FINAL solution by combining the strongest parts and FIXING the failures the checks reported. Output one fenced code block + a one-line rationale. Prefer the simplest correct code; do not pad.`,
    system: "You are OB-1's Fusion judge and synthesizer. Merge the candidates into one CORRECT answer, grounded in the objective checks; fix what they failed; prefer points multiple candidates agree on. Be concise; never reward verbosity.",
    cfg: opts.cfg, tools: new Map(), model: opts.judgeModel,
  });

  // Re-score the merge with the SAME (non-copy) tier the candidates used, then apply the revert-to-best
  // guard (pure): if the merge regressed below the best candidate's fractional score, fall back to it.
  const synthScore = (await scoreArtifact(synth.text, "synthesizer", useCopy || useWorktree)).score;
  const best = [...candidates].filter((c) => c.score?.checked).sort((a, b) => fracOf(b.score) - fracOf(a.score))[0];
  const fb = pickFallback({ text: synth.text, score: synthScore }, best);
  const failing = !(fb.finalScore?.checked && fb.finalScore.ok); // final artifact still fails → UI must say so
  return { candidates, synthesis: fb.synthesis, synthesisScore: fb.finalScore, reverted: fb.reverted, failing, signalTier, totalInputTokens: inTok, totalOutputTokens: outTok };
}
