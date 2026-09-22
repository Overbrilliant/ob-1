// Test-edit guard for the self-fix loop.
//
// The auto-verify loop feeds failing checks back to the model and lets it fix them. The obvious way to
// "make the checks pass" is to weaken the assertion or patch the test instead of the bug — the one trust
// question people ask about an auto-fix-until-green loop. This module makes that path visible:
//   • During a self-correction round (the loop has fed a failure back and is waiting to re-verify), a
//     write to a file that matches a test pattern is REFUSED by default. The model is told to fix the
//     source, or to say plainly that the test itself is wrong and leave it for the user.
//   • Outside a fix round, a test-file write that follows a failing check in the same turn is allowed but
//     FLAGGED: a loud line in the run output, a review finding in the quality ledger, and a reminder next
//     to the final "verified" outcome so a green result never hides a rewritten test.
// OB1_TEST_EDIT_GUARD selects the posture: `refuse` (default), `flag` (never refuse, always flag), `off`.
// Pure: no filesystem, no model — the loop supplies the state and this decides.

export type TestEditGuardMode = "refuse" | "flag" | "off";

/** Path fragments that mark a file as a test. Matched against the workspace-relative path with forward
 *  slashes. Directory names anywhere in the path; file-name patterns on the basename only. */
const TEST_DIRS = new Set(["test", "tests", "spec", "specs", "__tests__", "__test__"]);
const TEST_BASENAMES = [
  /\.test\.[^./]+$/i,    // foo.test.ts, foo.test.tsx, foo.test.py
  /\.spec\.[^./]+$/i,    // foo.spec.js
  /_test\.[^./]+$/i,     // foo_test.go, foo_test.py
  /^test_[^/]+\.[^./]+$/i, // test_foo.py
  /\.tests?\.[^./]+$/i,  // foo.tests.js
  /_spec\.[^./]+$/i,     // foo_spec.rb
];

export function isTestPath(path: string): boolean {
  const norm = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm) return false;
  const parts = norm.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => TEST_DIRS.has(d.toLowerCase()))) return true;
  return TEST_BASENAMES.some((re) => re.test(base));
}

/** The file path(s) a tool call would write. write_file / edit_file take `path`; architect_edit takes
 *  `file`. Non-writing tools (and bash) return [] — a shell command that rewrites a test is out of scope
 *  here and stays visible through the normal diff/approval path. */
export function writtenPaths(name: string, input: any): string[] {
  if (name === "write_file" || name === "edit_file") {
    const p = input?.path;
    return typeof p === "string" && p ? [p] : [];
  }
  if (name === "architect_edit") {
    const f = input?.file;
    return typeof f === "string" && f ? [f] : [];
  }
  return [];
}

export function parseGuardMode(raw: string | undefined): TestEditGuardMode {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "flag" || s === "warn") return "flag";
  if (s === "off" || s === "0" || s === "false" || s === "allow") return "off";
  return "refuse";
}

export interface TestEditContext {
  name: string;
  input: any;
  /** The loop has fed a failing check back and is waiting on the fix (fixRounds > 0). */
  inFixRound: boolean;
  /** Some check (auto-verify, the verify tool, or a known test command) already failed this turn. */
  afterFailedCheck: boolean;
  mode?: TestEditGuardMode;
}

export interface TestEditDecision {
  /** Test-pattern paths this call writes. Empty ⇒ nothing to do. */
  paths: string[];
  /** Block the call (tool_result is_error with `reason`). */
  refuse: boolean;
  /** Let it through but flag it loudly. */
  flag: boolean;
  reason?: string;
}

const NONE: TestEditDecision = { paths: [], refuse: false, flag: false };

export function guardTestEdit(ctx: TestEditContext): TestEditDecision {
  const mode = ctx.mode ?? "refuse";
  if (mode === "off") return NONE;
  const paths = writtenPaths(ctx.name, ctx.input).filter(isTestPath);
  if (!paths.length) return NONE;
  if (ctx.inFixRound && mode === "refuse") {
    return {
      paths, refuse: true, flag: false,
      reason:
        `Refused: ${paths.join(", ")} matches a test pattern and this is a self-correction round. The loop does not edit tests to make failing checks pass. ` +
        "Fix the source code the check is exercising instead. If the TEST itself is genuinely wrong or out of date (e.g. it references an API you were asked to rename), do not work around it: say so explicitly in your reply, leave the test for the user, and finish. " +
        "(The user can set OB1_TEST_EDIT_GUARD=flag to allow flagged test edits during self-correction.)",
    };
  }
  if (ctx.inFixRound || ctx.afterFailedCheck) {
    return { paths, refuse: false, flag: true, reason: `test file modified after a failing check: ${paths.join(", ")}` };
  }
  return NONE;
}

/** One-line summary for the verification outcome and the quality ledger. */
export function describeTestEdits(paths: Iterable<string>): string {
  const list = [...new Set(paths)];
  return `test file${list.length === 1 ? "" : "s"} modified after a failing check: ${list.join(", ")} — review the test change before trusting a green result`;
}
