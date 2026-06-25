// Dual-ledger orchestration with stall detection + bounded re-plan — PLAN-V2 item #11.
//
// The existing modes (fanout/Fusion/Council/Personas) run a FIXED number of rounds with no error
// recovery: if the workers thrash or make no progress, nothing notices. This adds the Magentic-One
// orchestration pattern as an OPTIONAL controller:
//   • Task Ledger    — the orchestrator's understanding: given facts, educated guesses, and the plan.
//   • Progress Ledger— assessed each round: is the request satisfied? is progress being made? is the
//     team looping? what's the next step and who does it?
//   • Stall detection— a counter that increments on a no-progress / looping round and resets on real
//     progress; when it crosses a threshold the orchestrator RE-PLANS (revises the task ledger) and
//     resets — bounded by a max-replan count so it can't loop forever.
//
// Pure state machine + an injected model (for assess/replan) so it's deterministically testable.
// Source: Magentic-One (Fourney et al. / Microsoft AutoGen) — the two-ledger orchestrator.
import { runWorker, type WorkerEvent, type WorkerResult } from "./runtime.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";

export interface TaskLedger {
  task: string;
  facts: string[];   // what we know for sure
  guesses: string[]; // educated guesses to verify
  plan: string[];    // ordered steps
}

export interface ProgressLedger {
  satisfied: boolean;   // is the overall request complete?
  progress: boolean;    // was forward progress made this round?
  inLoop: boolean;      // is the team repeating itself?
  nextStep: string;     // the instruction for the next round
  nextAssignee: string; // who acts next (a worker label / role)
}

// Defaults match AutoGen's shipped MagenticOneGroupChat: re-plan on the 3rd consecutive stall, hard-stop
// at 20 total rounds; cap replans so re-planning can't recur unboundedly inside the round budget.
export const STALL_THRESHOLD = 3;
export const MAX_REPLANS = 3;
export const MAX_ROUNDS = 20;

function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const s = body.indexOf("{"), e = body.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("no JSON object");
  return JSON.parse(body.slice(s, e + 1));
}
const arr = (v: any): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

/** Parse the model's progress assessment. Failure is treated as a no-progress round (conservative —
 *  an unreadable assessment shouldn't be mistaken for success, and it nudges toward a re-plan). */
export function parseProgress(raw: string): ProgressLedger {
  let o: any;
  try { o = extractJson(raw); } catch { return { satisfied: false, progress: false, inLoop: false, nextStep: "", nextAssignee: "" }; }
  return {
    satisfied: o?.satisfied === true || o?.is_request_satisfied === true,
    progress: o?.progress === true || o?.is_progress_being_made === true,
    inLoop: o?.inLoop === true || o?.is_in_loop === true,
    nextStep: String(o?.nextStep ?? o?.instruction ?? "").trim(),
    nextAssignee: String(o?.nextAssignee ?? o?.next_speaker ?? "worker").trim() || "worker",
  };
}

/** Parse a revised task ledger from a re-plan call; falls back to the prior ledger on a parse miss. */
export function parseReplan(raw: string, prior: TaskLedger): TaskLedger {
  let o: any;
  try { o = extractJson(raw); } catch { return prior; }
  return {
    task: prior.task,
    facts: arr(o?.facts).length ? arr(o.facts) : prior.facts,
    guesses: arr(o?.guesses).length ? arr(o.guesses) : prior.guesses,
    plan: arr(o?.plan).length ? arr(o.plan) : prior.plan,
  };
}

/** Stall counter transition: reset on genuine progress (and not looping), else increment. */
export function nextStall(stall: number, pl: ProgressLedger): number {
  return pl.progress && !pl.inLoop ? 0 : stall + 1;
}
export function shouldReplan(stall: number, threshold = STALL_THRESHOLD): boolean {
  return stall >= threshold;
}

export interface LedgerOutcome {
  ledger: TaskLedger;
  finalText: string;
  rounds: number;
  replans: number;
  satisfied: boolean;
  stalledOut: boolean; // stopped because it exhausted replans while still stalled
  totalInputTokens: number;
  totalOutputTokens: number;
}

export type AssessFn = (ledger: TaskLedger, lastResult: string) => Promise<string>;
export type ReplanFn = (ledger: TaskLedger, reason: string) => Promise<string>;

/** Production progress assessor: a one-shot reasoning call that returns the Progress Ledger JSON. */
async function liveAssess(ledger: TaskLedger, lastResult: string, cfg: Config, run: typeof runWorker): Promise<string> {
  const r = await run({
    label: "assess",
    task: `Task: ${ledger.task}\nPlan:\n${ledger.plan.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nThe worker just reported:\n${lastResult || "(nothing)"}\n\nAssess progress.`,
    system: 'You are an orchestrator assessing a team\'s progress. Respond with ONLY JSON: {"satisfied":<bool, is the whole task done?>,"progress":<bool, was forward progress made this round?>,"inLoop":<bool, is the team repeating itself?>,"nextStep":"<instruction for the next round>","nextAssignee":"worker"}',
    cfg, tools: new Map(),
  });
  return r.text;
}

/** Production re-planner: reflect on the stall and revise the task ledger. */
async function liveReplan(ledger: TaskLedger, reason: string, cfg: Config, run: typeof runWorker): Promise<string> {
  const r = await run({
    label: "replan",
    task: `The team has STALLED (${reason}) on this task.\nTask: ${ledger.task}\nKnown facts:\n${ledger.facts.map((f) => "- " + f).join("\n") || "(none)"}\nCurrent plan:\n${ledger.plan.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nReflect on what went wrong and produce a DIFFERENT plan.`,
    system: 'You revise a stalled plan. Respond with ONLY JSON: {"facts":["verified facts incl. what was just learned"],"guesses":["unverified guesses"],"plan":["a revised ordered step", "..."]}',
    cfg, tools: new Map(),
  });
  return r.text;
}

/** Drive a task through the dual-ledger loop: act → assess → (re-plan on stall) until satisfied,
 *  rounds exhausted, or replans exhausted while stalled. Injected `_run`/`_assess`/`_replan` make it
 *  deterministically testable; in production they call the model. Emits WorkerEvents for the live UI. */
export async function runLedger(opts: {
  ledger: TaskLedger;
  cfg: Config;
  tools: Map<string, Tool>;
  maxRounds?: number;
  stallThreshold?: number;
  maxReplans?: number;
  onEvent?: (ev: WorkerEvent) => void;
  signal?: AbortSignal;
  _run?: typeof runWorker;
  _assess?: AssessFn;
  _replan?: ReplanFn;
}): Promise<LedgerOutcome> {
  const run = opts._run ?? runWorker;
  const assess = opts._assess ?? ((l: TaskLedger, last: string) => liveAssess(l, last, opts.cfg, run));
  const replan = opts._replan ?? ((l: TaskLedger, reason: string) => liveReplan(l, reason, opts.cfg, run));
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const stallThreshold = opts.stallThreshold ?? STALL_THRESHOLD;
  const maxReplans = opts.maxReplans ?? MAX_REPLANS;
  let ledger = opts.ledger;
  let stall = 0, replans = 0, inTok = 0, outTok = 0;
  let finalText = "", satisfied = false, stalledOut = false, rounds = 0;
  let lastOutput: string | null = null; // deterministic loop backstop

  for (rounds = 1; rounds <= maxRounds; rounds++) {
    if (opts.signal?.aborted) break;
    const step = ledger.plan[0] || ledger.task;
    const res: WorkerResult = await run({
      label: `ledger-r${rounds}`,
      task: `Task: ${ledger.task}\nCurrent step: ${step}\nKnown facts:\n${ledger.facts.map((f) => "- " + f).join("\n") || "(none)"}`,
      system: "You are a worker executing one step of a larger plan in an isolated context. Do the step with the read-only tools and report concrete results — no preamble.",
      cfg: opts.cfg, tools: opts.tools, onEvent: opts.onEvent, signal: opts.signal,
    });
    inTok += res.inputTokens; outTok += res.outputTokens;
    finalText = res.text || finalText;

    const pl = parseProgress(await assess(ledger, res.text));
    if (pl.satisfied) { satisfied = true; break; }
    // Cheap deterministic loop backstop: an identical worker output two rounds running is a loop, no
    // matter what the assessor said (the paper drives inLoop from the LLM; this catches a thrashing
    // worker without trusting it).
    if (res.text && res.text === lastOutput) pl.inLoop = true;
    lastOutput = res.text;

    stall = nextStall(stall, pl);
    if (shouldReplan(stall, stallThreshold)) {
      if (replans >= maxReplans) { stalledOut = true; break; } // exhausted recovery → give up gracefully
      ledger = parseReplan(await replan(ledger, pl.inLoop ? "looping" : "no progress"), ledger);
      replans++; stall = 0;
    } else if (pl.nextStep) {
      // advance: drop the done step, queue the assessor's next instruction
      ledger = { ...ledger, plan: [pl.nextStep, ...ledger.plan.slice(1)] };
    } else {
      ledger = { ...ledger, plan: ledger.plan.slice(1) };
    }
  }

  return { ledger, finalText, rounds: Math.min(rounds, maxRounds), replans, satisfied, stalledOut, totalInputTokens: inTok, totalOutputTokens: outTok };
}
