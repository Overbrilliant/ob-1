// Adaptive difficulty-aware router (cross-cutting improvement — R5 + Snell et al. 2024).
//
// The eval's blunt finding: the multi-mind modes waste tokens on tasks Solo already nails. Snell
// et al. show the compute-optimal move is to MATCH effort to difficulty — try the cheap path first
// and escalate only when a signal says it's needed. runAdaptive runs Solo, scores it against the
// objective check, ships it when it passes (the common case), and only on FAIL escalates to a
// heavier mode (Fusion = parallel best-of-N, the right tool for hard problems; or Council).
//
// Note: the router needs a real correctness signal to know Solo failed. With a meaningful `check`
// it routes well; with only a syntax check (the default for TS/JS) Solo almost always "passes", so
// it conservatively ships Solo — never wasting tokens it can't justify.
import { runWorker, readOnlyTools, type WorkerEvent } from "./runtime.ts";
import { extractCode, scoreCandidate, runFusion } from "./fusion.ts";
import { runCouncil } from "./council.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";

export interface AdaptiveResult {
  path: "solo" | "fusion" | "council";
  soloPassed: boolean;
  soloChecked: boolean;     // whether the difficulty signal could be graded at all
  final: string;
  totalInputTokens: number;
  totalOutputTokens: number;
}

const SOLO_SYS =
  "You are OB-1 Solo — a single, careful coding agent. Solve the task well in one pass; investigate with " +
  "the read-only tools if needed, then output the complete solution as one fenced code block. No preamble.";

/** Lightweight heuristic: detect a hard/high-value task and SUGGEST (never force) an escalation —
 *  the plan's "OB-1 can suggest an escalation when it detects a hard/high-value task" (§06). Pure. */
const ESCALATION_SIGNALS: { re: RegExp; mode: "fusion" | "council" | "personas"; why: string }[] = [
  // High-risk DOMAINS — these words alone warrant a careful, reviewed change.
  { re: /\b(auth|security|secur\w*|crypto|password|secret|token|payment|billing|money|migrat\w*|production|prod)\b/i, mode: "council", why: "correctness/risk-critical" },
  // DESTRUCTIVE DATA ops only — a delete/drop verb aimed at a DATA STORE (table/db/account/records…),
  // NOT an everyday file/line/comment deletion. `delete` used to match here unconditionally, which
  // flagged trivial prompts like "delete the .DS_Store" as risk-critical. The verb must sit within a few
  // words of a data noun (or be the unambiguous `DROP TABLE` / `DELETE FROM`).
  { re: /\bdrop\s+table\b|\bdelete\s+from\b|\b(delete|drop|truncate|wipe|purge)\b[\s\w'"-]{0,24}\b(tables?|databases?|db|schemas?|collections?|accounts?|users?|records?|rows?|customers?|production|everything|all\s+(the\s+)?data)\b/i, mode: "council", why: "correctness/risk-critical" },
  { re: /\b(architect\w*|design|api\s*design|trade-?offs?|approach(es)?|alternativ\w*|review|refactor\w*)\b/i, mode: "personas", why: "open-ended/design" },
  { re: /\b(best|optimal|most\s+(efficient|performant)|fastest|hard|tricky|complex|algorithm)\b/i, mode: "fusion", why: "hard/high-value" },
];

export function suggestMode(input: string): { mode: "fusion" | "council" | "personas"; why: string } | null {
  if (input.length > 800) return { mode: "fusion", why: "long/complex task" };
  for (const s of ESCALATION_SIGNALS) if (s.re.test(input)) return { mode: s.mode, why: s.why };
  return null;
}

type EscalateFn = (task: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

export async function runAdaptive(opts: {
  task: string;
  cfg: Config;
  tools: Map<string, Tool>;
  check?: string;                          // objective signal that decides escalation ($OB1_FILE)
  models?: string[];                       // passed through to the escalated mode
  escalateTo?: "fusion" | "council";       // default fusion (parallel BoN for hard problems — Snell)
  requireDifficultySignal?: boolean;       // escalate ONLY if suggestMode flags the task as warranting it (interactive: true; eval: false)
  approve?: (desc: string) => Promise<boolean>; // per-action gate for Council's mutating tools on the REAL tree (omit ⇒ ungated)
  planMode?: boolean;                      // read-only escalation (Council/Fusion workers never write) — mirrors Solo Plan mode
  onEvent?: (ev: WorkerEvent) => void;     // live per-worker progress (solo probe + escalation) for the UI
  signal?: AbortSignal;                    // external cancellation (ESC)
  _runSolo?: typeof runWorker;             // injectable for tests
  _escalate?: EscalateFn;                  // injectable for tests
}): Promise<AdaptiveResult> {
  const baseRunSolo = opts._runSolo ?? runWorker;
  const runSolo: typeof runWorker = (o) => baseRunSolo({ ...o, onEvent: opts.onEvent, signal: opts.signal });
  let inTok = 0, outTok = 0;
  const tally = (w: { inputTokens: number; outputTokens: number }) => { inTok += w.inputTokens; outTok += w.outputTokens; };

  // 1. Cheap path first: Solo.
  const solo = await runSolo({ label: "solo", task: opts.task, system: SOLO_SYS, cfg: opts.cfg, tools: readOnlyTools(opts.tools), stream: true });
  tally(solo);

  // 2. Difficulty signal: does Solo's output pass the objective check?
  const { code, lang } = extractCode(solo.text);
  const score = code ? await scoreCandidate(code, { langHint: lang, check: opts.check, cwd: opts.cfg.cwd }) : undefined;
  const soloPassed = !!(score?.checked && score.ok);
  // Escalate ONLY when the task itself warrants deeper analysis. Interactive callers set this so an
  // incidental code fence in an otherwise-simple answer can't drag the turn into Fusion; eval leaves
  // it off to measure pure solve-what-Solo-fails.
  const warrantsDeeper = opts.requireDifficultySignal ? !!suggestMode(opts.task) : true;

  // 3. Solo passed, we couldn't grade it, or the task doesn't warrant escalation → ship Solo.
  if (soloPassed || !score?.checked || !warrantsDeeper) {
    return { path: "solo", soloPassed, soloChecked: !!score?.checked, final: solo.text, totalInputTokens: inTok, totalOutputTokens: outTok };
  }

  // 4. Solo demonstrably failed → escalate to a heavier mode.
  const escalateTo = opts.escalateTo ?? "fusion";
  const esc = opts._escalate
    ? await opts._escalate(opts.task)
    : escalateTo === "council"
      // Council edits the REAL tree directly — forward the approval gate AND Plan mode so an escalated
      // turn respects the SAME safety the interactive /council path does (omitting them ran ungated and
      // wrote even in Plan mode).
      ? await runCouncil({ task: opts.task, cfg: opts.cfg, tools: opts.tools, models: opts.models, check: opts.check, approve: opts.approve, planMode: opts.planMode, onEvent: opts.onEvent, signal: opts.signal }).then((r) => ({ text: r.final, inputTokens: r.totalInputTokens, outputTokens: r.totalOutputTokens }))
      : await runFusion({ task: opts.task, cfg: opts.cfg, tools: opts.tools, models: opts.models, check: opts.check, planMode: opts.planMode, onEvent: opts.onEvent, signal: opts.signal }).then((r) => ({ text: r.synthesis, inputTokens: r.totalInputTokens, outputTokens: r.totalOutputTokens }));
  tally(esc);
  return { path: escalateTo, soloPassed: false, soloChecked: true, final: esc.text, totalInputTokens: inTok, totalOutputTokens: outTok };
}
