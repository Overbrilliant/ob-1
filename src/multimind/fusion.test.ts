// Unit tests for Fusion v2's PURE selection/fallback logic + a few injected-seam runFusion paths (fake
// workers, no real models/subprocesses beyond the in-process syntax check). Run: bun test src/multimind/fusion.test.ts
import { test, expect } from "bun:test";
import {
  runFusion,
  chooseByVoteOrDiff,
  pickFallback,
  parseJudgePicks,
  normalizeCode,
  similarity,
  groupBySimilarity,
  type Candidate,
  type CandidateScore,
} from "./fusion.ts";
import { loadConfig } from "../config.ts";
import type { WorkerResult } from "./runtime.ts";

const mkCand = (label: string, code: string, score?: Partial<CandidateScore>): Candidate => ({
  label, text: "```ts\n" + code + "\n```", code, model: "m",
  inputTokens: 0, outputTokens: 0, ok: true,
  score: score ? { ok: true, checked: true, exitCode: 0, output: "", ...score } : undefined,
});

// ── normalize / similarity / grouping ──────────────────────────────────────────
test("normalizeCode — strips comments + collapses whitespace runs, so formatting-only diffs compare equal", () => {
  const a = normalizeCode("export const x = 1;   // a comment\n");
  const b = normalizeCode("export   const x = 1;\n/* block */");
  expect(a).toBe("export const x = 1;");
  expect(b).toBe(a); // comments gone, whitespace runs collapsed → identical
});

test("similarity — identical 1, disjoint low, near-identical high", () => {
  expect(similarity("abcdef", "abcdef")).toBe(1);
  expect(similarity("aaaaaaaa", "zzzzzzzz")).toBeLessThan(0.1);
  expect(similarity("return a + b + c", "return a + b + c ")).toBeGreaterThan(0.9);
});

test("groupBySimilarity — near-identical group; distinct → singletons", () => {
  const groups = groupBySimilarity(["return a+b", "return a+b", "totally other code zzz"], 0.9);
  const sizes = groups.map((g) => g.length).sort();
  expect(sizes).toEqual([1, 2]);
});

// ── chooseByVoteOrDiff: vote → smallest diff → judge ────────────────────────────
test("choose — single passing candidate is the trivial vote winner", () => {
  const r = chooseByVoteOrDiff([mkCand("cand-1", "return 1", { ok: true })]);
  expect(r).toEqual({ method: "vote", index: 0 });
});

test("choose — majority group wins by vote", () => {
  const passing = [
    mkCand("cand-1", "return a + b", { ok: true }),
    mkCand("cand-2", "return a + b", { ok: true }),
    mkCand("cand-3", "return zzz_totally_different_here()", { ok: true }),
  ];
  const r = chooseByVoteOrDiff(passing);
  expect(r.method).toBe("vote");
  expect(passing[(r as { index: number }).index].code).toBe("return a + b"); // an A, not the outlier
});

test("choose — no majority → smallest change (least edit) wins", () => {
  const passing = [
    mkCand("cand-1", "export const alpha = 1;", { ok: true }),
    mkCand("cand-2", "function beta(x){ return x * x * x + 999999; }", { ok: true }),
  ];
  const r = chooseByVoteOrDiff(passing);
  expect(r.method).toBe("diff");
  expect(passing[(r as { index: number }).index].label).toBe("cand-1"); // the shorter one
});

test("choose — smallest change uses the real diff length when present", () => {
  const passing = [
    mkCand("cand-1", "x", { ok: true, diff: "a".repeat(500) }), // big diff
    mkCand("cand-2", "yyyyyyyyyyyyyyyyyyyyyyyy", { ok: true, diff: "b".repeat(10) }), // tiny diff, but longer code
  ];
  const r = chooseByVoteOrDiff(passing);
  expect(r.method).toBe("diff");
  expect(passing[(r as { index: number }).index].label).toBe("cand-2"); // smallest DIFF, not smallest code
});

test("choose — dissimilar + equal size → judge tie", () => {
  const passing = [
    mkCand("cand-1", "xxxxxxxxxxxxxxxx", { ok: true }),
    mkCand("cand-2", "yyyyyyyyyyyyyyyy", { ok: true }), // same normalized length, no shared trigrams
  ];
  const r = chooseByVoteOrDiff(passing);
  expect(r.method).toBe("judge");
  expect((r as { tied: number[] }).tied.sort()).toEqual([0, 1]);
});

// ── parseJudgePicks: strict number, garbage tolerance, label-boundary safety ─────
test("parseJudgePicks — clean ratings", () => {
  expect(parseJudgePicks("cand-1: 4\ncand-2: 5\ncand-3: 2", ["cand-1", "cand-2", "cand-3"]))
    .toEqual({ "cand-1": 4, "cand-2": 5, "cand-3": 2 });
});
test("parseJudgePicks — tolerates prose / '3/5' style / missing labels", () => {
  const r = parseJudgePicks("I rate cand-1 = 3/5. cand-2 is unclear.", ["cand-1", "cand-2"]);
  expect(r["cand-1"]).toBe(3);
  expect(r["cand-2"]).toBeUndefined(); // unparseable → absent → caller falls back to first passing
});
test("parseJudgePicks — out-of-range digit ignored; label boundary (cand-1 ≠ cand-10)", () => {
  expect(parseJudgePicks("cand-1: 9", ["cand-1"])).toEqual({}); // 9 not in 0-5
  expect(parseJudgePicks("cand-10: 5", ["cand-1"])).toEqual({}); // must not match the longer label
});

// ── pickFallback: the revert-to-best guard ──────────────────────────────────────
const scored = (ok: boolean, score: number): CandidateScore => ({ ok, checked: true, exitCode: ok ? 0 : 1, output: "", score });

test("pickFallback — merge regressed below best → revert to best verbatim", () => {
  const best = mkCand("cand-2", "good enough", scored(false, 0.6));
  const r = pickFallback({ text: "```\nmerge\n```", score: scored(false, 0.3) }, best);
  expect(r.reverted).toBe(true);
  expect(r.synthesis).toBe(best.text);
  expect(r.finalScore?.score).toBe(0.6);
});
test("pickFallback — merge passes → keep the merge (no revert)", () => {
  const best = mkCand("cand-1", "x", scored(false, 0.4));
  const r = pickFallback({ text: "MERGE", score: scored(true, 1) }, best);
  expect(r.reverted).toBe(false);
  expect(r.synthesis).toBe("MERGE");
});
test("pickFallback — merge fails but best is no better → keep the merge", () => {
  const best = mkCand("cand-1", "x", scored(false, 0.1));
  const r = pickFallback({ text: "MERGE", score: scored(false, 0.2) }, best);
  expect(r.reverted).toBe(false);
  expect(r.synthesis).toBe("MERGE");
});
test("pickFallback — no scorable candidate / unscored merge → keep the merge", () => {
  expect(pickFallback({ text: "MERGE", score: scored(false, 0.5) }, undefined).reverted).toBe(false);
  expect(pickFallback({ text: "MERGE", score: undefined }, mkCand("c", "x", scored(false, 0.9))).reverted).toBe(false);
});

// ── runFusion via injected workers (syntax tier; no models/worktrees) ────────────
const cfg = loadConfig();
const block = (code: string) => "```ts\n" + code + "\n```";
const W = (label: string, text: string): WorkerResult => ({ label, text, inputTokens: 1, outputTokens: 1, ok: true });

test("runFusion — unanimous valid candidates → selected by vote, verbatim, not failing", async () => {
  const labels: string[] = [];
  const r = await runFusion({
    task: "t", cfg, tools: new Map(),
    _run: (async (o: { label: string }) => { labels.push(o.label); return W(o.label, block("export const x = 1;")); }) as any,
  });
  expect(r.candidates.length).toBe(3);
  expect(r.selected?.method).toBe("vote");
  expect(r.failing).toBe(false);
  expect(r.signalTier).toBe("syntax");
  expect(labels).not.toContain("synthesizer"); // selection path — no merge
});

test("runFusion — 0 passing → synthesizer merge fallback; a valid merge is not failing", async () => {
  const labels: string[] = [];
  const r = await runFusion({
    task: "t", cfg, tools: new Map(),
    _run: (async (o: { label: string }) => {
      labels.push(o.label);
      if (o.label === "synthesizer") return W(o.label, block("export const ok = 1;"));
      return W(o.label, block("export const bad = ;")); // broken TS → syntax FAIL
    }) as any,
  });
  expect(labels).toContain("synthesizer");
  expect(r.selected).toBeUndefined();
  expect(r.failing).toBe(false);
});

test("runFusion — 0 passing AND merge still broken → FAILING flag set", async () => {
  const r = await runFusion({
    task: "t", cfg, tools: new Map(),
    _run: (async (o: { label: string }) => W(o.label, block("export const bad = ;"))) as any, // candidates + merge fail
  });
  expect(r.selected).toBeUndefined();
  expect(r.failing).toBe(true);
});

test("runFusion — escalationContext preamble prepended to every candidate task", async () => {
  let seen = "";
  await runFusion({
    task: "IMPLEMENT THING", cfg, tools: new Map(), n: 1, escalationContext: "typecheck: TS2322 nope",
    _run: (async (o: { label: string; task: string }) => { if (o.label === "cand-1") seen = o.task; return W(o.label, block("export const x = 1;")); }) as any,
  });
  expect(seen).toMatch(/previous single-agent attempt failed verification/i);
  expect(seen).toContain("TS2322 nope");
  expect(seen).toContain("IMPLEMENT THING");
});
