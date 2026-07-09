// Unit tests for the refute-reviewer's PURE surface (reviewer.ts) — parsing, diff bounding, and the
// model-choice helper. No worker runs; no network. Run: bun test src/multimind/reviewer.test.ts
import { test, expect } from "bun:test";
import {
  parseFindings,
  boundDiff,
  buildReviewTask,
  pickReviewerModel,
  MAX_FINDINGS,
  DIFF_CAP,
} from "./reviewer.ts";

// ── parseFindings: clean findings ──────────────────────────────────────────────
test("parseFindings — a single clean FINDING line", () => {
  const r = parseFindings("FINDING: src/a.ts:42 — off-by-one in the loop bound — items of length 1 skip the last element");
  expect(r.none).toBe(false);
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0]).toEqual({
    file: "src/a.ts",
    line: 42,
    summary: "off-by-one in the loop bound",
    scenario: "items of length 1 skip the last element",
  });
});

test("parseFindings — multiple findings, ignoring surrounding prose/markdown noise", () => {
  const raw = [
    "Here is what I found after refuting the weak ones:",
    "- FINDING: src/net.ts:10 — unhandled null socket — a closed connection dereferences sock.write",
    "FINDING: src/parse.ts:88 — quote not escaped — input `a\"b` produces malformed output",
    "That's all.",
  ].join("\n");
  const r = parseFindings(raw);
  expect(r.none).toBe(false);
  expect(r.findings.map((f) => f.file)).toEqual(["src/net.ts", "src/parse.ts"]);
  expect(r.findings[0].line).toBe(10);
  expect(r.findings[1].summary).toBe("quote not escaped");
});

// ── parseFindings: NONE ─────────────────────────────────────────────────────────
test("parseFindings — bare NONE is a clean verdict", () => {
  const r = parseFindings("NONE");
  expect(r.none).toBe(true);
  expect(r.findings).toHaveLength(0);
});

test("parseFindings — NONE tolerant of markdown emphasis / trailing punctuation", () => {
  expect(parseFindings("**NONE**").none).toBe(true);
  expect(parseFindings("NONE.").none).toBe(true);
  expect(parseFindings("Reviewed the diff.\n\nNONE").none).toBe(true);
});

// ── parseFindings: garbled (neither NONE nor any FINDING) ───────────────────────
test("parseFindings — garbled prose → none:false, no findings (caller prints it unparsed)", () => {
  const r = parseFindings("The diff looks reasonable to me and I did not find issues worth flagging.");
  expect(r.none).toBe(false);
  expect(r.findings).toHaveLength(0);
});

test("parseFindings — an almost-FINDING line missing its scenario does NOT parse (strict)", () => {
  const r = parseFindings("FINDING: src/a.ts:1 — something looks off");
  expect(r.findings).toHaveLength(0);
  expect(r.none).toBe(false); // not NONE, not a valid finding → garbled/unparsed
});

// ── parseFindings: cap at MAX_FINDINGS ──────────────────────────────────────────
test("parseFindings — caps at MAX_FINDINGS", () => {
  const many = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => `FINDING: f${i}.ts:${i} — bug ${i} — scenario ${i}`).join("\n");
  const r = parseFindings(many);
  expect(r.findings).toHaveLength(MAX_FINDINGS);
  expect(r.none).toBe(false);
  expect(r.findings[0].file).toBe("f0.ts"); // kept the FIRST N, in order
});

// ── parseFindings: missing line number tolerated ────────────────────────────────
test("parseFindings — tolerates a missing :line (file-only citation)", () => {
  const r = parseFindings("FINDING: src/util/helpers.ts — leaks a file handle — the early return skips fh.close()");
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0].file).toBe("src/util/helpers.ts");
  expect(r.findings[0].line).toBeUndefined();
  expect(r.findings[0].scenario).toBe("the early return skips fh.close()");
});

test("parseFindings — a colon inside the path is not mistaken for a line number", () => {
  const r = parseFindings("FINDING: a/b:c.ts — bad key — lookup misses the entry");
  expect(r.findings[0].file).toBe("a/b:c.ts");
  expect(r.findings[0].line).toBeUndefined();
});

// ── boundDiff + buildReviewTask: the truncation note ────────────────────────────
test("boundDiff — passes short diffs through, cuts long ones with a truncated flag", () => {
  expect(boundDiff("short").truncated).toBe(false);
  expect(boundDiff("short").text).toBe("short");
  const big = "x".repeat(DIFF_CAP + 500);
  const b = boundDiff(big);
  expect(b.truncated).toBe(true);
  expect(b.text).toHaveLength(DIFF_CAP);
});

test("buildReviewTask — includes the diff + output format, and a truncation note only when cut", () => {
  const shortTask = buildReviewTask("diff --git a/x b/x\n+hi");
  expect(shortTask).toContain("+hi");
  expect(shortTask).toContain("FINDING:");
  expect(shortTask).toContain("NONE");
  expect(shortTask).not.toContain("truncated");

  const longTask = buildReviewTask("y".repeat(DIFF_CAP + 100));
  expect(longTask).toContain("truncated");
  expect(longTask).toContain(String(DIFF_CAP));
});

test("buildReviewTask — folds in the original task context when provided", () => {
  const t = buildReviewTask("diff body", "add a debounce helper");
  expect(t).toContain("add a debounce helper");
  expect(t).toContain("diff body");
});

// ── pickReviewerModel: pick-different-from ──────────────────────────────────────
test("pickReviewerModel — picks the first ensemble model that differs from the current one", () => {
  expect(pickReviewerModel(["m1", "m2", "m3"], "m1")).toBe("m2");
  expect(pickReviewerModel(["m2", "m1"], "m1")).toBe("m2"); // first differing, regardless of position
});

test("pickReviewerModel — falls back to current when none differ (or the list is empty)", () => {
  expect(pickReviewerModel(["m1"], "m1")).toBe("m1");
  expect(pickReviewerModel(["m1", "m1"], "m1")).toBe("m1");
  expect(pickReviewerModel([], "m1")).toBe("m1");
});

test("pickReviewerModel — skips empty entries", () => {
  expect(pickReviewerModel(["", "m1", "m2"], "m1")).toBe("m2");
});
