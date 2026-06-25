// Recovery recipes (parity with claw-code's recovery_recipes).
//
// Common failures have KNOWN fixes. classifyFailure() maps an error string to a scenario; recipeFor()
// returns the structured recovery (summary + steps + whether it's auto-attemptable). A RecoveryLedger
// enforces ONE automatic recovery attempt per (scenario, key) before escalating to the user, and records
// each attempt as a structured event. Pure + dependency-free.

export type FailureScenario =
  | "rate_limited"      // 429 — back off / slow down
  | "provider_failure"  // 5xx / stream drop / empty body — transient upstream
  | "auth_failure"      // 401/403 — token expired / wrong account
  | "mcp_handshake"     // an MCP server failed to connect / initialize
  | "missing_tool"      // a CLI the command needs isn't installed
  | "stale_branch"      // local git branch is behind / diverged from upstream
  | "compile_red";      // typecheck / build / test failed after an edit

export interface RecoveryRecipe {
  scenario: FailureScenario;
  summary: string;
  steps: string[];
  /** True when OB-1 can attempt the fix itself (retry/back-off/self-correct) before asking the user. */
  autoAttemptable: boolean;
}

const RECIPES: Record<FailureScenario, Omit<RecoveryRecipe, "scenario">> = {
  rate_limited: {
    summary: "Rate-limited by the provider (429).",
    steps: ["Back off and retry with exponential delay (the gateway does this automatically).", "If it persists, slow the request rate or switch to a less-loaded model."],
    autoAttemptable: true,
  },
  provider_failure: {
    summary: "Transient upstream/provider failure (5xx, dropped stream, or empty body).",
    steps: ["Retry the request (the gateway retries transient failures with backoff).", "If it keeps failing, switch provider/model or check the provider's status page."],
    autoAttemptable: true,
  },
  auth_failure: {
    summary: "Authentication failed (401/403) — token expired or wrong account.",
    steps: ["Re-authenticate with `ob1 login`.", "Confirm the CLI is signed into the account that holds your plan."],
    autoAttemptable: false,
  },
  mcp_handshake: {
    summary: "An MCP server failed to connect or initialize.",
    steps: ["Retry the connection once.", "Verify the server command/URL and that its process is running.", "Disable the failing server so the rest of the session proceeds."],
    autoAttemptable: true,
  },
  missing_tool: {
    summary: "A required command-line tool isn't installed.",
    steps: ["Install it via the project's package manager / your OS package manager (run_bash).", "Re-run the command after installing."],
    autoAttemptable: true,
  },
  stale_branch: {
    summary: "The local git branch is behind or has diverged from its upstream.",
    steps: ["Fetch and rebase/merge the upstream (`git pull --rebase`).", "Resolve any conflicts, then retry the push/operation."],
    autoAttemptable: false,
  },
  compile_red: {
    summary: "Verification failed after an edit (typecheck/build/test).",
    steps: ["Read the failing output, fix the cause, and re-verify (OB-1's self-correct loop does this).", "If the failure is pre-existing/unrelated, say so explicitly."],
    autoAttemptable: true,
  },
};

export function recipeFor(scenario: FailureScenario): RecoveryRecipe {
  return { scenario, ...RECIPES[scenario] };
}

/** Map an error/output string to a known failure scenario, or null if unrecognized. Order matters:
 *  the most specific signals are checked first. */
export function classifyFailure(message: string): FailureScenario | null {
  const m = String(message ?? "");
  const api = m.match(/\bAPI\s+(\d{3})\b/);
  if (api) {
    const s = Number(api[1]);
    if (s === 429) return "rate_limited";
    if (s === 401 || s === 403) return "auth_failure";
    if (s >= 500) return "provider_failure";
  }
  if (/\b(401|unauthorized|invalid api key|token (expired|invalid))\b/i.test(m)) return "auth_failure";
  if (/\b429\b|rate.?limit|too many requests/i.test(m)) return "rate_limited";
  if (/\bmcp\b/i.test(m) && /(handshake|initialize|connect|spawn|transport|server)/i.test(m)) return "mcp_handshake";
  if (/command not found|not found:|: not found|ENOENT|no such file or directory|is not recognized as an internal/i.test(m)) return "missing_tool";
  if (/non-fast-forward|fetch first|behind .* commits|have diverged|tip of your current branch is behind|updates were rejected/i.test(m)) return "stale_branch";
  if (/\b(type|compil)\w*\s+error|error TS\d+|cannot find name|test(s)? failed|\d+ failing|build failed|exit (1|2|101)\b/i.test(m)) return "compile_red";
  if (/stream (idle|error|interrupted)|request failed after|empty body|bad gateway|502|503|504|5\d\d/i.test(m)) return "provider_failure";
  return null;
}

export interface RecoveryEvent {
  scenario: FailureScenario;
  key: string;        // dedupe key (e.g. server name, command, "turn") — distinguishes independent failures
  attempt: number;    // 1-based attempt count for this (scenario,key)
  action: string;     // what was tried
  ok?: boolean;       // outcome, if known
  ts?: string;        // ISO; stamped by the caller (keeps this module Date-free)
}

/** Tracks recovery attempts and enforces a budget of ONE automatic attempt per (scenario, key) before
 *  escalation. Records every attempt as a structured event for surfacing/telemetry. */
export class RecoveryLedger {
  private attempts = new Map<string, number>();
  private log: RecoveryEvent[] = [];
  constructor(private readonly maxAuto = 1) {}

  private k(scenario: FailureScenario, key: string): string { return `${scenario}:${key}`; }

  /** Should OB-1 auto-attempt recovery now? Only if the recipe is auto-attemptable AND we're under budget. */
  shouldAutoRecover(scenario: FailureScenario, key = "default"): boolean {
    if (!RECIPES[scenario].autoAttemptable) return false;
    return (this.attempts.get(this.k(scenario, key)) ?? 0) < this.maxAuto;
  }

  /** Record an attempt; returns the structured event (also appended to the ledger). */
  record(scenario: FailureScenario, key: string, action: string, ok?: boolean, ts?: string): RecoveryEvent {
    const n = (this.attempts.get(this.k(scenario, key)) ?? 0) + 1;
    this.attempts.set(this.k(scenario, key), n);
    const ev: RecoveryEvent = { scenario, key, attempt: n, action, ok, ts };
    this.log.push(ev);
    return ev;
  }

  /** True when we should escalate to the user: a non-auto-attemptable scenario goes straight to the user;
   *  an auto-attemptable one escalates once its attempt budget is spent. */
  escalated(scenario: FailureScenario, key = "default"): boolean {
    if (!RECIPES[scenario].autoAttemptable) return true;
    return (this.attempts.get(this.k(scenario, key)) ?? 0) >= this.maxAuto;
  }

  events(): RecoveryEvent[] { return [...this.log]; }
}

/** A short, user-facing recovery hint for an error — appended to the friendly error block. "" if unknown. */
export function recoveryHint(message: string): string {
  const sc = classifyFailure(message);
  if (!sc) return "";
  const r = recipeFor(sc);
  return `Recovery (${sc}): ${r.summary} ${r.steps[0]}`;
}
