// reviewer.ts — the refute-reviewer (Cursor Bugbot pattern), the ONE durable production use of a second
// agent (research 2026-07-06). A fresh, independent reviewer reading only the DIFF catches two error
// classes the author can't: decorrelated mistakes (a different model reasons differently) and
// fresh-context mistakes (no attachment to the code it just wrote). The whole value is in what it does
// NOT do: it is an ADVERSARIAL REFUTER, not a suggestion machine. For every candidate bug it must first
// try to DISPROVE it (read the surrounding code) and report only what survives with a concrete failure
// scenario — because an ungrounded reviewer that pads with "consider…" nits is measured NOISE, not signal.
//
// It is a single READ-ONLY worker (runtime.ts + readOnlyTools): it can investigate to refute, but it never
// writes. Any fix it triggers goes back through the MAIN gated apply loop (index.ts), never from here —
// the same "reviewer/deep never write directly" invariant the spec mandates.
import { runWorker, readOnlyTools, type WorkerEvent } from "./runtime.ts";
import { ensembleModels } from "./evaluate.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";

/** One surviving finding: a real correctness bug the reviewer could not refute. `line` is optional — a
 *  finding is still useful (and still parsed) when the model cites a file but no exact line. `scenario` is
 *  the load-bearing field: the concrete inputs/state → wrong-behavior story that proves it's real, not a nit. */
export interface Finding {
  file: string;
  line?: number;
  summary: string;
  scenario: string;
}

/** Never surface more than this many findings — a refuter that returns a wall of items has stopped
 *  refuting (Self-MoA / signal-not-noise); cap it so the output stays reviewable and the fix turn bounded. */
export const MAX_FINDINGS = 8;
/** Bound the diff we hand the model. Reviews run on the current change, which is usually small; a runaway
 *  diff (generated files, a vendored lockfile) would blow the context and the token budget for no signal. */
export const DIFF_CAP = 20_000;

// The shipped reviewer prompt. Deliberately narrow: correctness bugs ONLY, refute-before-report, concrete
// scenario + citation, exactly `NONE` when nothing survives. No style/naming/formatting opinions — those
// are the padding that makes a second agent net-negative.
export const REVIEWER_SYS =
  "You are an adversarial code reviewer inspecting a diff for REAL correctness bugs only — logic errors, " +
  "broken edge cases, wrong APIs, off-by-one errors, null/undefined hazards, race conditions, resource " +
  "leaks, data loss, and security holes. For EACH candidate bug you spot, FIRST actively try to REFUTE it: " +
  "read the surrounding code with your tools to check whether a guard, caller, type, or invariant elsewhere " +
  "already makes it safe. Report ONLY the findings that SURVIVE that refutation — each one backed by a " +
  "concrete failure scenario (the specific inputs or state that lead to the wrong behavior) and a file:line " +
  "citation. NO style nits, NO naming or formatting opinions, NO speculation, NO 'you could consider…' " +
  "suggestions, NO padding — a short report of real bugs beats a long one. If nothing survives scrutiny, " +
  "output exactly NONE.";

// The strict output contract, appended to the TASK (the system prompt states the policy; the task states
// the shape + the material). One finding per line so parsing is line-oriented and robust.
const OUTPUT_FORMAT =
  "\n\nOutput format — one finding per line, and NOTHING else:\n" +
  "FINDING: <file>:<line> — <one-line summary> — <concrete failure scenario: specific inputs/state → wrong behavior>\n" +
  "(omit `:<line>` only if you truly cannot localize it.)\n" +
  "If no finding survives refutation, output exactly:\nNONE";

/** Bound the diff to `cap` chars, reporting whether we truncated so the caller can add an HONEST note (a
 *  silent cut would let the reviewer confidently clear a bug living in the part it never saw). */
export function boundDiff(diff: string, cap = DIFF_CAP): { text: string; truncated: boolean } {
  if (diff.length <= cap) return { text: diff, truncated: false };
  return { text: diff.slice(0, cap), truncated: true };
}

/** Assemble the worker's task: optional original-task context (so the reviewer judges against INTENT, not
 *  just the code), the bounded diff with a truncation note when cut, and the strict output format. */
export function buildReviewTask(diff: string, task?: string): string {
  const { text, truncated } = boundDiff(diff);
  const parts: string[] = [];
  if (task?.trim()) parts.push(`The change was trying to accomplish this task:\n${task.trim()}\n`);
  parts.push("Review the following diff for correctness bugs:\n\n" + text);
  if (truncated)
    parts.push(
      `\n[diff truncated to ${DIFF_CAP} of ${diff.length} chars — review ONLY what is shown above; do not clear or claim anything about the omitted portion]`,
    );
  parts.push(OUTPUT_FORMAT);
  return parts.join("\n");
}

/** Choose the reviewer model: the FIRST ensemble model that DIFFERS from `current` (an independent model
 *  catches decorrelated errors), falling back to `current` when none differ (a same-model reviewer still
 *  catches fresh-context errors — reading the diff cold, unattached to code it just wrote). Pure + injectable
 *  so the choice is unit-testable without touching live free-router state. */
export function pickReviewerModel(models: string[], current: string): string {
  return models.find((m) => m && m !== current) ?? current;
}

// One FINDING line. The location, summary, and scenario are separated by a spaced dash (em/en/hyphen — models
// are inconsistent). Requiring WHITESPACE around the separator is load-bearing: it stops a hyphen inside a
// path ("src/my-file.ts") or a word from being mistaken for a field boundary. Leading markdown list/quote
// noise ("- ", "* ", "> ") is tolerated. Non-greedy first two groups → the split lands on the FIRST spaced
// dash after the location, then after the summary; the scenario runs to end-of-line.
const FINDING_RE = /^[\s>*+-]*FINDING:\s*(.+?)\s+[—–-]\s+(.+?)\s+[—–-]\s+(.+?)\s*$/i;
// `location` is `<file>:<line>` or just `<file>`. Line optional (tolerated per spec). Anchored to the END so
// only a trailing `:<digits>` is treated as the line — a colon inside the path stays part of the file.
const LOC_RE = /^(.+):(\d+)$/;
// A standalone NONE — the model's "nothing survived" verdict. Tolerates markdown emphasis / trailing
// punctuation (**NONE**, `NONE.`) but nothing else on the line (an explanatory "NONE, but…" would NOT match,
// which is correct: it was told to output EXACTLY NONE, so anything else is treated as a real/garbled report).
const isNoneLine = (line: string): boolean => line.trim().replace(/[^a-zA-Z]/g, "").toUpperCase() === "NONE";

/** Parse the reviewer's raw text into findings, STRICTLY. Three outcomes the caller distinguishes:
 *   • ≥1 well-formed FINDING line  → { findings (capped), none:false }
 *   • an explicit NONE (and no findings) → { findings:[], none:true } — genuinely clean
 *   • neither (garbled prose)          → { findings:[], none:false } — the caller prints `raw` dimmed as
 *     UNPARSED rather than pretending the diff is clean (a false green is the dangerous failure here). */
export function parseFindings(raw: string): { findings: Finding[]; none: boolean } {
  const findings: Finding[] = [];
  for (const line of raw.split("\n")) {
    const m = FINDING_RE.exec(line);
    if (!m) continue;
    const loc = m[1].trim();
    const locM = LOC_RE.exec(loc);
    findings.push({
      file: locM ? locM[1].trim() : loc,
      line: locM ? Number(locM[2]) : undefined,
      summary: m[2].trim(),
      scenario: m[3].trim(),
    });
    if (findings.length >= MAX_FINDINGS) break; // cap: stop scanning once we have the max
  }
  if (findings.length) return { findings, none: false };
  const none = raw.split("\n").some(isNoneLine);
  return { findings: [], none };
}

/** Run ONE read-only refute-reviewer over a diff. Returns the parsed findings, the `none` verdict, the RAW
 *  text (so a garbled response can be surfaced verbatim), and token totals. `_run` is the injectable worker
 *  seam for deterministic tests. Tokens accrue via `onEvent` step events at the call site (like every other
 *  worker) — the caller must NOT also add these totals or it double-counts. */
export async function runReview(opts: {
  cfg: Config;
  tools: Map<string, Tool>;
  diff: string;
  task?: string;
  model?: string;
  onEvent?: (ev: WorkerEvent) => void;
  signal?: AbortSignal;
  _run?: typeof runWorker;
}): Promise<{ findings: Finding[]; none: boolean; raw: string; totalInputTokens: number; totalOutputTokens: number }> {
  const run = opts._run ?? runWorker;
  const model = opts.model ?? pickReviewerModel(ensembleModels(opts.cfg), opts.cfg.model);
  const tools = readOnlyTools(opts.tools);
  // Anchor the worker to the workspace root (same rationale as subagents.ts): the diff shows relative paths,
  // so tell the reviewer to read files RELATIVE to the root instead of burning its step budget guessing at
  // absolute/~ forms. This is operational glue around the shipped REVIEWER_SYS policy, kept out of the
  // exported constant so the prompt stays pure/quotable.
  const system = `${REVIEWER_SYS}\n\nWorkspace root: ${opts.cfg.cwd}. When you open a file to refute a finding, pass its path RELATIVE to this root (e.g. "src/agent/loop.ts") — never an absolute or ~ path.`;
  const res = await run({
    label: "reviewer",
    task: buildReviewTask(opts.diff, opts.task),
    system,
    cfg: opts.cfg,
    tools,
    model,
    signal: opts.signal,
    onEvent: opts.onEvent,
  });
  const { findings, none } = parseFindings(res.text);
  return { findings, none, raw: res.text, totalInputTokens: res.inputTokens, totalOutputTokens: res.outputTokens };
}
