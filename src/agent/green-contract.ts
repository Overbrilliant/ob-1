// Graduated "green contract" (parity with claw-code's green_contract).
//
// "Done" isn't binary. A change can be green at increasing levels of rigor:
//   • targeted_tests — the relevant tests pass            (fastest)
//   • package        — typecheck + tests pass             (default "looks done")
//   • workspace      — typecheck + lint + tests + build   (whole project healthy)
//   • merge_ready    — workspace + NO known flakes allowed (strict gate before shipping)
// A contract names a required level and evaluates a verification run against it, with optional
// known-flake handling (ignore a flaky check below merge_ready; never ignore it at merge_ready).
// Pure — it consumes the Check/CheckResult types from verify.ts; the tool layer runs the commands.
import type { Check, CheckKind, CheckResult } from "./verify.ts";

export type GreenLevel = "targeted_tests" | "package" | "workspace" | "merge_ready";
export const GREEN_LEVELS: GreenLevel[] = ["targeted_tests", "package", "workspace", "merge_ready"];

// Which check KINDS each level requires. merge_ready requires the same kinds as workspace but adds
// flake-strictness (see evaluateContract).
const LEVEL_KINDS: Record<GreenLevel, CheckKind[]> = {
  targeted_tests: ["test"],
  package: ["typecheck", "test"],
  workspace: ["typecheck", "lint", "test", "build"],
  merge_ready: ["typecheck", "lint", "test", "build"],
};

export function isGreenLevel(s: string): s is GreenLevel { return (GREEN_LEVELS as string[]).includes(s); }
export function levelKinds(level: GreenLevel): CheckKind[] { return LEVEL_KINDS[level]; }

/** Select which DETECTED checks to run for a level (the project may not have all kinds). */
export function checksForLevel(level: GreenLevel, available: Check[]): Check[] {
  const want = new Set(LEVEL_KINDS[level]);
  return available.filter((c) => want.has(c.kind));
}

export interface ContractOpts {
  knownFlakes?: string[];     // check NAMES known to be flaky
  blockKnownFlakes?: boolean; // force a flaky failure to count (defaults true at merge_ready, false below)
}

export interface ContractResult {
  level: GreenLevel;
  satisfied: boolean;
  ranKinds: CheckKind[];
  missingKinds: CheckKind[];     // required kinds the project has no check for (a coverage gap, not a failure)
  failing: CheckResult[];        // checks that genuinely block the contract
  flakesIgnored: CheckResult[];  // failing checks ignored as known flakes (below merge_ready)
  report: string;
}

/** Evaluate a verification run against a target green level. */
export function evaluateContract(level: GreenLevel, results: CheckResult[], opts: ContractOpts = {}): ContractResult {
  const required = LEVEL_KINDS[level];
  const ranKinds = [...new Set(results.map((r) => r.kind))];
  const missingKinds = required.filter((k) => !ranKinds.includes(k));
  const flakes = new Set((opts.knownFlakes ?? []).map((s) => s.toLowerCase()));
  // merge_ready never tolerates a flake; below it, a known-flaky failure can be set aside.
  const blockFlakes = opts.blockKnownFlakes ?? (level === "merge_ready");

  const failed = results.filter((r) => !r.ok);
  const flakesIgnored: CheckResult[] = [];
  const failing: CheckResult[] = [];
  for (const r of failed) {
    if (!blockFlakes && flakes.has(r.name.toLowerCase())) flakesIgnored.push(r);
    else failing.push(r);
  }
  // Satisfied = nothing genuinely failing AND no required kind is missing (incomplete coverage can't be
  // "green"). targeted_tests is lenient about missing kinds only if SOME check ran.
  const coverageOk = level === "targeted_tests" ? results.length > 0 : missingKinds.length === 0;
  const satisfied = failing.length === 0 && coverageOk;

  const bits: string[] = [];
  bits.push(`${satisfied ? "✓" : "✗"} green contract: ${level} — ${satisfied ? "SATISFIED" : "NOT met"}`);
  if (failing.length) bits.push(`failing: ${failing.map((r) => r.name).join(", ")}`);
  if (missingKinds.length && !satisfied) bits.push(`missing required check(s): ${missingKinds.join(", ")} (no command detected)`);
  if (flakesIgnored.length) bits.push(`tolerated known flake(s) below merge_ready: ${flakesIgnored.map((r) => r.name).join(", ")}`);
  return { level, satisfied, ranKinds, missingKinds, failing, flakesIgnored, report: bits.join("\n") };
}
