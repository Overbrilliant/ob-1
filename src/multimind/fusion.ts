// Fusion mode (Phase 4) — best-of-N with auto-scoring, merged by a synthesizing judge.
//
// 1. Fan out the task to N workers that all get the SAME prompt (no per-worker "angles") — the
//    only intended variance is sampling, optionally one model per worker. Each produces a
//    complete candidate solution in an isolated context.
// 2. Auto-score each candidate against an OBJECTIVE signal (compile/syntax check, or a
//    configured test command) so the judge is grounded in real signal, not vibes.
// 3. A single judge/synthesizer sees ALL candidates (with their PASS/FAIL verdicts) and builds
//    the final answer by combining the strongest parts of each — never picking one and discarding
//    the rest. If the merged result regresses below a candidate that passed, fall back to it.
import { writeFileSync, rmSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { runWorker, runParallel, readOnlyTools, type WorkerResult, type WorkerEvent } from "./runtime.ts";
import { createWorktree, createWorkspaceCopy, isGitRepo, type Worktree } from "./worktree.ts";
import { wrapCommand } from "../safety/sandbox.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";
import type { ProcRegistry } from "../agent/procs.ts";

export interface CandidateScore {
  ok: boolean;
  exitCode: number;
  output: string;
  checked: boolean;
  /** Worktree real-test scoring only: captured test output + the candidate's diff vs HEAD. */
  testOutput?: string;
  diff?: string;
  targetPath?: string;
}

/** Worktree real-test scoring options: apply `code` to `targetPath` in a fresh worktree at HEAD,
 *  then run `testCmd` (sandboxed per cfg.sandbox) against the project in context. */
export interface WorktreeScore { cfg: Config; testCmd: string; targetPath: string; label?: string }
export interface Candidate extends WorkerResult { model: string; code?: string; score?: CandidateScore }
export interface FusionResult {
  candidates: Candidate[];
  synthesis: string;
  synthesisScore?: CandidateScore; // F4: objective check of the synthesized output
  reverted: boolean;              // F4: synthesis failed the check → fell back to a passing candidate
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Pull the first fenced code block from a model response; fall back to the whole text. */
export function extractCode(text: string): { code: string; lang?: string } {
  const m = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/.exec(text);
  if (m) return { code: m[2].trim(), lang: m[1] || undefined };
  return { code: text.trim() };
}

/** Like extractCode, but also resolves a TARGET FILE PATH for worktree scoring — from the fence
 *  info string (```ts path/to/file.ts) or a leading `// file: path` / `# file: path` comment. */
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

/** Score a candidate against an objective signal. In order of strength:
 *  worktree real-test (apply to a git worktree at HEAD, run the project's tests) →
 *  configured check command → ts/js in-process syntax check (Bun.Transpiler) → py py_compile. */
export async function scoreCandidate(code: string, opts: { langHint?: string; check?: string; cwd: string; worktree?: WorktreeScore }): Promise<CandidateScore> {
  const lang = guessLang(code, opts.langHint);

  // Strongest signal: materialize the candidate in its own worktree and run real tests in context.
  if (opts.worktree) {
    const { cfg, testCmd, targetPath } = opts.worktree;
    if (!isGitRepo(cfg.cwd)) return { ok: false, exitCode: -1, output: "worktree scoring requires a git repo", checked: false };
    // targetPath is untrusted model output — reject absolute paths and any traversal that escapes
    // the worktree (the write below runs in this process, NOT under the sandbox).
    if (isAbsolute(targetPath)) return { ok: false, exitCode: -1, output: `unsafe target path (absolute): ${targetPath}`, checked: false };
    let wt: { path: string; cleanup(): void } | undefined;
    try {
      wt = createWorktree(cfg, opts.worktree.label ?? "cand");
      const wtPath = wt.path;
      // Resolve SYMLINKS, not just lexical path math: a committed symlink in HEAD (e.g. a dir that
      // points outside the repo) could otherwise let the un-sandboxed write below escape the worktree.
      // Canonicalize the root + the nearest existing ancestor of dest (the non-existent tail can't
      // contain symlinks), and require the write to stay within the real worktree root.
      const realRoot = realpathSync(wtPath);
      const dest = resolve(realRoot, targetPath);
      let existing = dest;
      while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
      const realExisting = realpathSync(existing);
      const tail = relative(existing, dest); // lexical remainder past the existing ancestor (no symlinks)
      const finalDest = tail ? join(realExisting, tail) : realExisting;
      const within = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
      if (!within(realExisting) || !within(finalDest)) return { ok: false, exitCode: -1, output: `unsafe target path (escapes worktree): ${targetPath}`, checked: false };
      mkdirSync(dirname(finalDest), { recursive: true });
      writeFileSync(finalDest, code);
      // A linked worktree's git metadata lives OUTSIDE wtPath: the per-worktree dir
      // (.git/worktrees/<name>/, holds the index) and the COMMON dir (.git, holds objects/refs that
      // `git add`/`commit` write). Grant the sandbox write access to both so git-touching tests don't
      // spuriously fail. (The common dir contains the per-worktree dir, but resolve both to be safe.)
      const gitDir = (flag: string) => {
        const d = new TextDecoder().decode(Bun.spawnSync(["git", "-C", wtPath, "rev-parse", flag], { stdout: "pipe", stderr: "ignore" }).stdout).trim();
        return d ? (isAbsolute(d) ? d : resolve(wtPath, d)) : "";
      };
      const extraWrites = [...new Set([gitDir("--absolute-git-dir"), gitDir("--git-common-dir")].filter(Boolean))];
      const argv = wrapCommand(cfg.sandbox, wtPath, testCmd, extraWrites);
      const p = Bun.spawnSync(argv, { cwd: wtPath, env: { ...process.env } });
      const out = (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)).slice(0, 2000);
      // `git add -A -N` (intent-to-add) so NEW files show in the diff too; plain `git diff` skips
      // untracked. -N records intent only (no staged content), so modified tracked files still diff.
      Bun.spawnSync(["git", "-C", wt.path, "add", "-A", "-N"], { stdout: "ignore", stderr: "ignore" });
      const diff = new TextDecoder().decode(Bun.spawnSync(["git", "-C", wt.path, "diff"], { stdout: "pipe", stderr: "ignore" }).stdout).slice(0, 2000);
      return { ok: p.exitCode === 0, exitCode: p.exitCode ?? -1, output: out || "(no output)", checked: true, testOutput: out, diff, targetPath };
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
      return { ok: p.exitCode === 0, exitCode: p.exitCode ?? -1, output: out || "(no output)", checked: true };
    } finally { rmSync(file, { force: true }); }
  }

  if (lang === "ts" || lang === "js") {
    try {
      new Bun.Transpiler({ loader: lang === "ts" ? "tsx" : "jsx" }).transformSync(code);
      return { ok: true, exitCode: 0, output: "syntax ok", checked: true };
    } catch (e) {
      return { ok: false, exitCode: 1, output: String((e as Error).message).slice(0, 600), checked: true };
    }
  }

  if (lang === "py") {
    const file = join(tmpdir(), `ob1-fusion-${process.pid}-${Math.floor(performance.now())}.py`);
    writeFileSync(file, code);
    try {
      const p = Bun.spawnSync(["python3", "-m", "py_compile", file]);
      const out = new TextDecoder().decode(p.stderr).slice(0, 600);
      return { ok: p.exitCode === 0, exitCode: p.exitCode ?? -1, output: out || "syntax ok", checked: true };
    } catch { return { ok: false, exitCode: -1, output: "python3 not available", checked: false }; }
    finally { rmSync(file, { force: true }); }
  }

  return { ok: false, exitCode: -1, output: "no check available for this language", checked: false };
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

export async function runFusion(opts: {
  task: string;
  cfg: Config;
  tools: Map<string, Tool>;
  n?: number;             // number of candidates (default 3; raised to models.length when more models given)
  models?: string[];      // one per worker (round-robin); default all = cfg.model
  check?: string;         // objective check command ($OB1_FILE = candidate path)
  concurrency?: number;
  moa?: boolean;          // F3: one Mixture-of-Agents refine layer (candidates see peers) — opt-in
  judgeModel?: string;    // model for the judge/synthesizer (default cfg.model)
  worktree?: boolean;     // F: score each candidate in its own git worktree by running real tests
  testCmd?: string;       // test command run in the worktree (default "bun test"); requires worktree
  targetPath?: string;    // default file path to apply a candidate to when it omits one
  /** Build a fresh tool map scoped to a given cwd (buildTools({...cfg, cwd})). When wired, each candidate
   *  runs with the FULL toolset inside its OWN writable copy of the workspace, so the parallel candidates
   *  can edit/run/test without ever overwriting each other's work. Omitted ⇒ read-only in the shared cwd. */
  mkTools?: (cwd: string) => Map<string, Tool>;
  procs?: ProcRegistry;   // when wired, reap any background proc a candidate left in its throwaway copy
                          // (kill-by-cwd) BEFORE the copy is torn down, so it never orphans
  planMode?: boolean;     // read-only investigation only — no writable copies (mirrors Solo Plan mode)
  onEvent?: (ev: WorkerEvent) => void; // live per-worker progress (candidates / synthesizer) for the UI
  signal?: AbortSignal;                // external cancellation (ESC) — propagated to every worker
  _run?: typeof runWorker; // injectable for deterministic tests
}): Promise<FusionResult> {
  const baseRun = opts._run ?? runWorker;
  let inTok = 0, outTok = 0;
  const run: typeof runWorker = async (o) => { const w = await baseRun({ ...o, onEvent: opts.onEvent, signal: opts.signal }); inTok += w.inputTokens; outTok += w.outputTokens; return w; };
  const roTools = readOnlyTools(opts.tools);
  const baseModels = opts.models?.length ? opts.models : [opts.cfg.model];
  const n = Math.max(opts.n ?? 3, opts.models?.length ?? 0, 1);
  const specs = Array.from({ length: n }, (_, i) => ({ model: baseModels[i % baseModels.length] }));
  // Score a candidate. Worktree mode (opt-in) applies the code to its target file in a fresh
  // worktree at HEAD and runs the project's real tests; otherwise fall back to isolated scoring.
  const useWorktree = opts.worktree === true;
  const testCmd = opts.testCmd ?? "bun test";
  const score = (text: string, label: string, fallbackTarget?: string): Promise<CandidateScore> | undefined => {
    const { code, lang, path } = extractCandidateFile(text);
    if (!code) return undefined;
    const targetPath = path || fallbackTarget;
    if (useWorktree) {
      // No resolvable file path → cannot real-test in a worktree. Mark UNSCORED (checked:false)
      // rather than silently downgrading to a weak syntax check that would be mislabeled PASS/FAIL
      // alongside real-test verdicts and could mislead the judge / F4 revert gate.
      if (!targetPath) return Promise.resolve({ ok: false, exitCode: -1, output: "no target path — not real-tested (put the path on the fence info line or set OB1_FUSION_TARGET)", checked: false });
      return scoreCandidate(code, { langHint: lang, cwd: opts.cfg.cwd, worktree: { cfg: opts.cfg, testCmd, targetPath, label } });
    }
    return scoreCandidate(code, { langHint: lang, check: opts.check, cwd: opts.cfg.cwd });
  };

  // Each candidate works in its OWN writable copy when mkTools is wired (and not Plan mode): full tools,
  // isolated, so the parallel candidates never clobber each other. Copies are created SEQUENTIALLY (git
  // worktree add contends on .git in parallel) but the workers themselves run concurrently, and every
  // copy is cleaned up in the finally below. A copy that fails to materialize falls back to read-only.
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

  let raw: WorkerResult[];
  try {
    // 1. Generate candidates in parallel from the SAME prompt (isolated contexts/copies, possibly different models).
    raw = await runParallel(
      specs,
      (s, i) => run({
        label: `cand-${i + 1}`,
        task: opts.task,
        system: candSystem(i),
        cfg: candCfg(i),
        tools: candTools(i),
        model: s.model,
      }),
      opts.concurrency ?? n,
    );

    // F3. Optional Mixture-of-Agents refine layer: each candidate sees the peers' drafts and improves once
    //     (continuing in its own copy, so it can re-run/test the grafted result).
    if (opts.moa) {
      const peers = raw.map((r, i) => `### candidate ${i + 1}\n\`\`\`\n${extractCode(r.text).code}\n\`\`\``).join("\n\n");
      raw = await runParallel(
        specs,
        (s, i) => run({
          label: `cand-${i + 1}-moa`,
          task: `Task:\n${opts.task}\n\nPeer candidate solutions:\n\n${peers}\n\nGraft the strongest parts of the peers and fix their mistakes. Output your improved COMPLETE solution as a single fenced code block. No prose outside it.`,
          system: `${candSystem(i)} You are in the refinement layer (Mixture-of-Agents): aggregate the best peer ideas; do not regress correctness; ignore verbosity.`,
          cfg: candCfg(i),
          tools: candTools(i),
          model: s.model,
        }),
        opts.concurrency ?? n,
      );
    }
  } finally {
    // Reap any background proc a candidate left running INSIDE its copy (kill-by-cwd) BEFORE removing the
    // dir, so a dev server/watcher started in a throwaway workspace copy never orphans. Then remove the copy.
    for (const w of copies) { if (w) { opts.procs?.killByCwd(w.path); w.cleanup(); } }
  }

  // 2. Auto-score each candidate against an objective signal. Under worktree mode, derive one
  //    run-level target (explicit OB1_FUSION_TARGET, else the first path any candidate declared) so
  //    candidates that omitted the path — and the synthesis — are graded by the SAME real-test tier.
  const resolvedTarget = opts.targetPath ?? raw.map((r) => extractCandidateFile(r.text).path).find(Boolean);
  const candidates: Candidate[] = [];
  for (let i = 0; i < raw.length; i++) {
    const { code } = extractCandidateFile(raw[i].text);
    candidates.push({ ...raw[i], model: specs[i].model, code, score: await score(raw[i].text, raw[i].label, resolvedTarget) });
  }

  // 3. Judge/synthesize: ONE pass over ALL candidates, grounded in their objective verdicts (and,
  //    under worktree scoring, their real test output + diff), combining the strongest parts of each.
  const block = candidates.map((c, i) => {
    const verdict = !c.score?.checked ? "UNSCORED" : c.score.ok ? "PASS" : "FAIL";
    const checkOut = c.score && !c.score.ok ? `(check: ${c.score.output})\n` : "";
    const tests = c.score?.testOutput ? `<test-output>\n${c.score.testOutput}\n</test-output>\n` : "";
    const diff = c.score?.diff ? `<diff>\n${c.score.diff}\n</diff>\n` : "";
    return `## ${c.label} [${c.model}] — ${verdict}\n${checkOut}${tests}${diff}\`\`\`\n${c.code ?? c.text}\n\`\`\``;
  }).join("\n\n");
  const synth = await run({
    label: "synthesizer",
    task: `Fusion generated ${candidates.length} independent candidate solution(s) to the SAME task, each with an objective check verdict:\n\n${block}\n\nProduce the single best final solution by combining the strongest parts of every candidate. Prefer code the check marked PASS; never ship an approach the check marked FAIL. Output one fenced code block + a one-line rationale. Prefer the simplest correct code; do not pad.`,
    system: "You are OB-1's Fusion judge and synthesizer. Merge the candidates into one best answer, grounded in the objective checks; prefer points multiple candidates agree on. Be concise; never reward verbosity.",
    cfg: opts.cfg,
    tools: new Map(),
    model: opts.judgeModel,
    // not streamed — fusionTurn prints the synthesis once (streaming would duplicate it)
  });

  // F4. Verify the synthesis with the SAME scoring tier as the candidates (real tests when worktree
  //     mode is on, via resolvedTarget); if it regressed below a candidate that passed, fall back.
  const synthScore = await score(synth.text, "synthesizer", resolvedTarget);
  const passing = candidates.find((c) => c.score?.checked && c.score.ok);
  let synthesis = synth.text;
  let reverted = false;
  if (synthScore?.checked && !synthScore.ok && passing) {
    synthesis = "```\n" + (passing.code ?? "") + "\n```\n(reverted to a passing candidate — the synthesis failed the objective check)";
    reverted = true;
  }

  return { candidates, synthesis, synthesisScore: synthScore, reverted, totalInputTokens: inTok, totalOutputTokens: outTok };
}
