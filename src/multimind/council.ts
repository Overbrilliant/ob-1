// Council mode (Phase 5) — two models in an open back-and-forth, then a comprehensive finalizer
// (R5 + plan Diagram 6).
//
// Unlike Fusion (N independent candidates judged by an objective check), Council improves a
// SINGLE evolving draft through open-ended revision — no fixed review lenses:
//   1. An author (model A) drafts a complete solution in an isolated context.
//   2. A reviewer (model B — a distinct model when a second one is given) openly reviews the draft
//      for ANYTHING that would make it more correct, complete, robust, or simpler, and returns a
//      critique + a BLOCK/OK verdict. Two models going back and forth gives genuinely independent eyes.
//   3. If the reviewer blocks, the author revises against the review. The review→revise loop repeats
//      for up to `rounds` rounds, stopping early once a round raises no blocking issue.
//   4. A finalizer (arbiter) integrates the final draft + the last review into one comprehensive,
//      complete final answer, with an ACCEPT/REVISE verdict.
//
// Author, reviewer, reviser and finalizer run as isolated workers (Phase 3 runtime) with the FULL
// toolset against the REAL workspace — they investigate, edit, run and TEST directly. Council is
// sequential (no parallel-clobber risk), so it works on the real tree rather than a copy; each mutating
// action is gated by the same per-action approval the main loop uses (autopilot never prompts; ask
// prompts). In Plan mode the workers are read-only. There is no separate apply step — the council IS
// the apply (its edits land as it goes).
import { runWorker, readOnlyTools, type WorkerResult, type WorkerEvent } from "./runtime.ts";
import { extractCode, scoreCandidate, type CandidateScore } from "./fusion.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";

export interface CouncilRound {
  round: number;
  draft: string;            // the draft the reviewer saw this round
  review: string;           // the reviewer's critique (verdict line stripped)
  blocking: boolean;        // reviewer raised at least one must-fix issue
  revised: string;          // draft after revision (== draft when nothing was revised)
  revisedThisRound: boolean;
  score?: CandidateScore;   // objective check of the draft, when a check command is configured
}
export interface CouncilResult {
  rounds: CouncilRound[];
  final: string;
  verdict: string;
  accepted: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Parse the reviewer's trailing `VERDICT: BLOCK|OK` line. Last marker wins; absent ⇒ non-blocking. */
export function parseBlocking(text: string): boolean {
  const re = /VERDICT:\s*(BLOCK|OK)/gi;
  let last: string | undefined, m: RegExpExecArray | null;
  while ((m = re.exec(text))) last = m[1];
  return last ? /block/i.test(last) : false;
}

/** Parse the arbiter's `VERDICT: ACCEPT|REVISE` line. Last marker wins; absent ⇒ accepted
 *  (the draft survived every revise round, so default to shipping rather than looping forever). */
export function parseAccepted(text: string): boolean {
  const re = /VERDICT:\s*(ACCEPT|REVISE)/gi;
  let last: string | undefined, m: RegExpExecArray | null;
  while ((m = re.exec(text))) last = m[1];
  return last ? /accept/i.test(last) : true;
}

const PROVIDER_BLOCK_RE = /```[a-zA-Z0-9_+-]*\n[\s\S]*?```/;
/** Strip the final `VERDICT:` line so the review prose stays clean when shown to the author. */
function reviewBody(text: string): string {
  return text.replace(/\n?VERDICT:\s*(BLOCK|OK)\s*$/i, "").trim();
}

export async function runCouncil(opts: {
  task: string;
  cfg: Config;
  tools: Map<string, Tool>;
  rounds?: number;        // max review→revise loops (default 3); stops early when a round is clean
  /** Two models going back and forth: models[0] authors/revises, models[1] reviews. A single
   *  entry (or none) uses cfg.model for both — diverse models give genuinely independent review (R5). */
  models?: string[];
  /** Objective check command ($OB1_FILE = draft path). Grounds the review/revise loop in real
   *  signal; intrinsic self-correction without it can DEGRADE quality (Huang et al. 2023). */
  check?: string;
  /** Distinct model for the final arbiter (≠ the author's model) to curb self-preference bias. */
  arbiterModel?: string;
  /** Per-action gate for the workers' mutating tools (write/edit/run_bash on the REAL tree). Wire the
   *  same gate Solo uses; omit to run ungated. Ignored in Plan mode (workers are read-only there). */
  approve?: (desc: string) => Promise<boolean>;
  /** Plan mode: workers are read-only (investigate + propose, never write/run) — mirrors Solo Plan mode. */
  planMode?: boolean;
  /** Live per-worker progress (drafting / reviewing / revising / finalizing) for the UI. */
  onEvent?: (ev: WorkerEvent) => void;
  /** External cancellation (ESC) — propagated to every worker. */
  signal?: AbortSignal;
  /** Injectable for deterministic tests; defaults to the real isolated-worker runner. */
  _run?: typeof runWorker;
}): Promise<CouncilResult> {
  const baseRun = opts._run ?? runWorker;
  const run: typeof runWorker = (o) => baseRun({ ...o, onEvent: opts.onEvent, signal: opts.signal, approve: opts.approve });
  // Full toolset against the real workspace (Plan mode → read-only). Capability is set by THIS map.
  const workerTools = opts.planMode ? readOnlyTools(opts.tools) : opts.tools;
  const maxRounds = Math.max(1, opts.rounds ?? 3);
  const authorModel = opts.models?.[0];                       // undefined ⇒ cfg.model
  const reviewerModel = opts.models?.[1] ?? opts.models?.[0]; // second model reviews; falls back to the first
  let inTok = 0, outTok = 0;
  const tally = (r: WorkerResult) => { inTok += r.inputTokens; outTok += r.outputTokens; };

  // Objective grounding: score a draft's code and turn it into oracle feedback for the loop.
  const scoreDraft = async (text: string): Promise<CandidateScore | undefined> => {
    const { code, lang } = extractCode(text);
    return code ? scoreCandidate(code, { langHint: lang, check: opts.check, cwd: opts.cfg.cwd }) : undefined;
  };
  const checkNote = (s?: CandidateScore): string =>
    s?.checked
      ? `\n\nAn OBJECTIVE check of this draft reports **${s.ok ? "PASS" : "FAIL"}**${s.ok ? "" : ` — ${s.output}`}. ` +
        "Treat this as ground truth: never claim correctness the check contradicts, and make fixing any FAIL the priority."
      : "";

  // 0. Author the initial draft.
  const draft = await run({
    label: "author",
    task: opts.task,
    system:
      "You are OB-1 Council's author. Produce a complete, concrete solution to the task. You have the FULL " +
      "toolset against the real workspace: investigate, then APPLY your solution directly to the project " +
      "files with your tools (edit/write) and run/verify it when code is involved. Then report the solution — " +
      "full file content in a single fenced code block when a file is targeted, otherwise a direct answer — " +
      "so the reviewer can see it. No preamble.",
    cfg: opts.cfg,
    tools: workerTools,
    model: authorModel,
    // Intermediate drafts are NOT streamed to the screen — otherwise every author/reviser draft
    // dumps its full (often near-identical) text to scrollback. Progress still shows via onEvent.
  });
  tally(draft);

  const rounds: CouncilRound[] = [];
  let current = draft.text;

  for (let r = 1; r <= maxRounds; r++) {
    // 1. Reviewer openly reviews the current draft — grounded in the objective check when present.
    const draftScore = await scoreDraft(current);
    const reviewW = await run({
      label: `reviewer:r${r}`,
      task:
        `Task given to the author:\n${opts.task}\n\nThe author's current draft:\n\n${current}${checkNote(draftScore)}\n\n` +
        "Review it openly and thoroughly. List concrete, actionable issues — correctness bugs, missing cases or " +
        "requirements, unsafe operations, gaps in completeness, and needless complexity are all in scope (cite " +
        "file/line where you can). If there's nothing that must change, say so. End with exactly one line: " +
        '"VERDICT: BLOCK" if at least one issue must be fixed before shipping, otherwise "VERDICT: OK".',
      system:
        "You are OB-1 Council's reviewer — independent eyes on the author's work, which has been applied to the " +
        "real workspace. Judge the WHOLE change against the task: correctness, completeness, safety, and simplicity, " +
        "all at once (no single fixed lens). Use your tools to verify claims against the real codebase — read the " +
        "actual files and run the project's checks/tests rather than guessing. Don't rewrite it yourself; report " +
        "issues for the author to fix. Be specific and terse.",
      cfg: opts.cfg,
      tools: workerTools,
      model: reviewerModel,
    });
    tally(reviewW);
    const blocking = parseBlocking(reviewW.text);
    const review = reviewBody(reviewW.text);

    // 2. Nothing must change ⇒ the draft is good; stop early without spending a revise round.
    if (!blocking) {
      rounds.push({ round: r, draft: current, review, blocking, revised: current, revisedThisRound: false, score: draftScore });
      break;
    }

    // 3. Author revises against the review.
    const revised = await run({
      label: `reviser:r${r}`,
      task:
        `Task:\n${opts.task}\n\nYour current draft:\n\n${current}${checkNote(draftScore)}\n\nThe reviewer raised these issues:\n\n${review}\n\n` +
        "Produce a revised solution that resolves every issue without regressing what already worked. APPLY the " +
        "revision directly to the real files with your tools and re-verify, then report the full solution the same " +
        "way you first drafted it (single fenced code block for file content). No preamble.",
      system:
        "You are OB-1 Council's author, revising your own work against the reviewer's feedback. You have the full " +
        "toolset: edit the real files to address the substance of each issue (don't merely restate it) and re-run " +
        "the checks. Investigate with your tools as needed.",
      cfg: opts.cfg,
      tools: workerTools,
      model: authorModel,
      // not streamed — see the author note above (avoids dumping every revised draft to scrollback)
    });
    tally(revised);
    rounds.push({ round: r, draft: current, review, blocking, revised: revised.text, revisedThisRound: true, score: draftScore });
    current = revised.text;
  }

  // 4. Finalizer (arbiter): comprehensive final answer over the last draft + its outstanding review.
  const lastRound = rounds[rounds.length - 1];
  const finalScore = await scoreDraft(current); // ground the arbiter in the final draft's check
  const arb = await run({
    label: "arbiter",
    task:
      `Task:\n${opts.task}\n\nFinal draft after ${rounds.length} council round(s):\n\n${current}${checkNote(finalScore)}\n\n` +
      `The reviewer's last review:\n\n${lastRound.review} [${lastRound.blocking ? "BLOCK" : "OK"}]\n\n` +
      "Produce the single best final answer: make it comprehensive and complete — fold in anything the review " +
      "raised that the draft still misses, and resolve any remaining disagreement. APPLY any final fixes directly " +
      "to the real files with your tools and verify, so the workspace ends in the shipped state. Then output the " +
      "final solution the same format the author used (fenced code block for file content) followed by a one-line " +
      'rationale. End with exactly one line: "VERDICT: ACCEPT" if it is ready to ship, otherwise "VERDICT: REVISE" noting the top remaining gap.',
    system:
      "You are OB-1 Council's finalizer. Weigh the review against the final draft and ship the best honest answer — " +
      "complete and correct, with nothing important left out, applied to the real files. Do not invent; never claim " +
      "an issue is fixed unless the workspace actually fixes it. Ignore length — never reward verbosity; prefer the shortest complete solution.",
    cfg: opts.cfg,
    tools: workerTools,
    model: opts.arbiterModel, // distinct arbiter model curbs self-preference bias
    // not streamed — councilTurn prints the final answer once (streaming it here would duplicate it)
  });
  tally(arb);

  return {
    rounds,
    final: arb.text,
    verdict: arb.text.match(/VERDICT:\s*(ACCEPT|REVISE)/i)?.[0] ?? "VERDICT: ACCEPT",
    accepted: parseAccepted(arb.text),
    totalInputTokens: inTok,
    totalOutputTokens: outTok,
  };
}

// Re-exported so callers can detect whether the final answer carried a code block.
export const hasCodeBlock = (text: string): boolean => PROVIDER_BLOCK_RE.test(text);
