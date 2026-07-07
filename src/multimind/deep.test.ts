// Unit tests for deep.ts (AB-MCTS-lite): the PURE search core (sampleBeta / armPosterior / selectArm) and a
// few injected-seam runDeep paths (fake _run + _rng, no real models/subprocesses beyond the in-process
// syntax check and a trivial failing $OB1_FILE check). Run: bun test src/multimind/deep.test.ts
import { test, expect } from "bun:test";
import {
  runDeep,
  sampleBeta,
  armPosterior,
  selectArm,
  buildRefineTask,
  deepNodeLine,
  type Arm,
  type DeepNode,
  type Rng,
} from "./deep.ts";
import { loadConfig } from "../config.ts";
import type { WorkerResult } from "./runtime.ts";

// A tiny seeded PRNG (mulberry32) — reproducible uniform stream for the determinism/exploration tests.
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const HALF: Rng = () => 0.5; // constant rng → sampleBeta becomes a deterministic, monotonic-in-α fn of the posterior

const gen = (id: number, model: string, score: number): DeepNode => ({ id, code: "", text: "", score, ok: score >= 1, model });
const refine = (id: number, parent: number, model: string, score: number): DeepNode => ({ id, code: "", text: "", score, ok: score >= 1, model, parent });

// ── sampleBeta: determinism + bounds ─────────────────────────────────────────────
test("sampleBeta — deterministic given a seeded rng (same seed → same draw)", () => {
  expect(sampleBeta(2, 5, mulberry32(42))).toBe(sampleBeta(2, 5, mulberry32(42)));
  expect(sampleBeta(3, 3, HALF)).toBe(sampleBeta(3, 3, HALF)); // constant rng is fully deterministic too
});

test("sampleBeta — every draw lands in [0,1] across a range of shapes", () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const s = sampleBeta(1 + 5 * rng(), 1 + 5 * rng(), rng);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  }
});

test("sampleBeta — a lopsided posterior samples toward its mass (Beta(20,1)≫Beta(1,20))", () => {
  expect(sampleBeta(20, 1, HALF)).toBeGreaterThan(0.9);
  expect(sampleBeta(1, 20, HALF)).toBeLessThan(0.1);
});

// ── armPosterior: the Beta(1+Σr, 1+Σ(1−r)) math ──────────────────────────────────
test("armPosterior — empty history → uniform prior (1,1) for GEN and for a REFINE of an absent node", () => {
  expect(armPosterior({ kind: "gen", model: "A" }, [])).toEqual({ alpha: 1, beta: 1 });
  expect(armPosterior({ kind: "refine", node: 99, model: "A" }, [])).toEqual({ alpha: 1, beta: 1 });
});

test("armPosterior — GEN pools only that model's fresh generations (not refinements, not other models)", () => {
  const hist: DeepNode[] = [gen(1, "A", 0.5), gen(2, "B", 1), refine(3, 1, "A", 1)];
  // GEN(A) sees only node1 (0.5): α=1.5, β=1.5. node2 is model B; node3 is a refinement (has a parent).
  expect(armPosterior({ kind: "gen", model: "A" }, hist)).toEqual({ alpha: 1.5, beta: 1.5 });
});

test("armPosterior — REFINE pools node's children (any model) PLUS the node's own score as a prior obs", () => {
  const hist: DeepNode[] = [gen(1, "A", 0.4), refine(2, 1, "B", 0.9), refine(3, 1, "A", 0.2)];
  // REFINE(1) observes [0.9, 0.2, 0.4(self)] → Σr=1.5, Σ(1−r)=1.5 → α=2.5, β=2.5.
  const p = armPosterior({ kind: "refine", node: 1, model: "A" }, hist);
  expect(p.alpha).toBeCloseTo(2.5, 10);
  expect(p.beta).toBeCloseTo(2.5, 10);
});

test("armPosterior — a strong node attracts refinement: its own high score seeds a high refine posterior", () => {
  const p = armPosterior({ kind: "refine", node: 1, model: "A" }, [gen(1, "A", 0.9)]);
  expect(p).toEqual({ alpha: 1.9, beta: 1.1 }); // mean 0.63 with no children yet → gets sampled for depth
});

// ── selectArm: exploit the clearly-better arm; explore under uncertainty ──────────
test("selectArm — picks the clearly-better arm under a fixed rng", () => {
  const arms: Arm[] = [{ kind: "gen", model: "A" }, { kind: "gen", model: "B" }];
  const hist = [gen(1, "B", 1), gen(2, "B", 1), gen(3, "B", 1)]; // GEN(B) posterior Beta(4,1); GEN(A) stays (1,1)
  expect(selectArm(arms, hist, HALF)).toBe(1); // B's sample ≫ A's → deepen/widen toward the proven arm
});

test("selectArm — two equal (1,1) arms are BOTH explored across a varying rng (Thompson exploration)", () => {
  const arms: Arm[] = [{ kind: "gen", model: "A" }, { kind: "gen", model: "B" }];
  const rng = mulberry32(123);
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) seen.add(selectArm(arms, [], rng));
  expect(seen.has(0) && seen.has(1)).toBe(true); // neither arm is starved → genuine exploration
});

// ── buildRefineTask / deepNodeLine: pure formatting ──────────────────────────────
test("buildRefineTask — embeds the parent code + its failures + the improve instruction", () => {
  const t = buildRefineTask("export const x = 1;", "AssertionError: expected 2, got 1");
  expect(t).toContain("export const x = 1;");
  expect(t).toContain("AssertionError: expected 2, got 1");
  expect(t).toMatch(/Improve this candidate/);
  expect(buildRefineTask("code", "  ")).not.toMatch(/reported these failures/); // blank output → no failures block
});

test("deepNodeLine — `#id ← #parent · action · model · score`; GEN omits the parent arrow", () => {
  expect(deepNodeLine(gen(1, "A", 0.5))).toBe("#1 · gen · A · 0.50");
  expect(deepNodeLine(refine(3, 1, "B", 0.67))).toBe("#3 ← #1 · refine · B · 0.67");
});

// ── runDeep via injected _run/_rng (non-free provider ⇒ ensembleModels == [cfg.model]) ────
const cfg = { ...loadConfig(), provider: "openai", apiKey: "k", model: "M", cwd: process.cwd() } as any;
const block = (code: string) => "```ts\n" + code + "\n```";
const W = (label: string, text: string): WorkerResult => ({ label, text, inputTokens: 1, outputTokens: 1, ok: true });
const FAIL_CHECK = 'echo "MARKER_FAIL_XYZ" >&2; exit 1'; // ignores $OB1_FILE → always fails with a known marker

test("runDeep — (a) budget respected: every candidate fails → exactly `budget` calls, no early stop", async () => {
  const seen: string[] = [];
  const r = await runDeep({
    task: "t", cfg, tools: new Map(), budget: 3, check: FAIL_CHECK, _rng: HALF,
    _run: (async (o: { label: string; task: string }) => { seen.push(o.label); return W(o.label, block("export const x = 1;")); }) as any,
  });
  expect(r.nodes.length).toBe(3);
  expect(seen.length).toBe(3);
  expect(r.signalTier).toBe("check");
  expect(r.totalInputTokens).toBeGreaterThan(0);
});

test("runDeep — (b) early stop on a full pass: first GEN passes → 1 node, best.score 1", async () => {
  const seen: string[] = [];
  const r = await runDeep({
    task: "t", cfg, tools: new Map(), budget: 5, _rng: HALF, // no check → syntax tier; valid TS passes
    _run: (async (o: { label: string }) => { seen.push(o.label); return W(o.label, block("export const ok = 1;")); }) as any,
  });
  expect(seen.length).toBe(1); // stopped after the first fully-passing node — didn't spend the rest of the budget
  expect(r.nodes.length).toBe(1);
  expect(r.best?.ok).toBe(true);
  expect(r.best?.score).toBe(1);
  expect(r.signalTier).toBe("syntax");
});

test("runDeep — (c) a REFINE of a failing node carries that node's failure output into the prompt", async () => {
  const seen: { label: string; task: string }[] = [];
  const r = await runDeep({
    task: "t", cfg, tools: new Map(), budget: 3, check: FAIL_CHECK, _rng: HALF,
    _run: (async (o: { label: string; task: string }) => { seen.push({ label: o.label, task: o.task }); return W(o.label, block("export const x = 1;")); }) as any,
  });
  // HALF rng + all-fail: call1 GEN, call2 GEN (tie → GEN first), call3 REFINE(node1). Deterministic.
  const refineNode = r.nodes.find((n) => n.parent !== undefined);
  expect(refineNode?.parent).toBe(1);
  const refineCall = seen.find((s) => s.label.startsWith("refine"));
  expect(refineCall?.task).toContain("MARKER_FAIL_XYZ"); // the parent's real failure output
  expect(refineCall?.task).toMatch(/Improve this candidate/);
});

test("runDeep — (d) best = highest score, ties → earliest (all-fail ⇒ node #1 wins)", async () => {
  const r = await runDeep({
    task: "t", cfg, tools: new Map(), budget: 3, check: FAIL_CHECK, _rng: HALF,
    _run: (async (o: { label: string }) => W(o.label, block("export const x = 1;"))) as any,
  });
  expect(r.nodes.every((n) => n.score === 0)).toBe(true);
  expect(r.best?.id).toBe(1); // earliest among the tied-at-0 nodes
});

test("runDeep — (e) escalationContext is prepended to GEN tasks but NOT to REFINE tasks", async () => {
  const seen: { label: string; task: string }[] = [];
  await runDeep({
    task: "IMPLEMENT THING", cfg, tools: new Map(), budget: 3, check: FAIL_CHECK, escalationContext: "typecheck: TS2322 nope", _rng: HALF,
    _run: (async (o: { label: string; task: string }) => { seen.push({ label: o.label, task: o.task }); return W(o.label, block("export const x = 1;")); }) as any,
  });
  const genCall = seen.find((s) => s.label.startsWith("gen"))!;
  const refineCall = seen.find((s) => s.label.startsWith("refine"))!;
  expect(genCall.task).toMatch(/previous single-agent attempt failed verification/i);
  expect(genCall.task).toContain("TS2322 nope");
  expect(genCall.task).toContain("IMPLEMENT THING");
  expect(refineCall.task).not.toMatch(/previous single-agent attempt failed verification/i); // GEN-only
});

test("runDeep — (f) ESC mid-run returns the partial tree cleanly (honored between calls)", async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const r = await runDeep({
    task: "t", cfg, tools: new Map(), budget: 9, check: FAIL_CHECK, _rng: HALF, signal: ctrl.signal,
    _run: (async (o: { label: string }) => { if (++calls === 2) ctrl.abort(); return W(o.label, block("export const x = 1;")); }) as any,
  });
  expect(r.nodes.length).toBe(2); // call 1 + call 2 (which aborts); call 3's top-of-loop check breaks
  expect(r.best).toBeDefined(); // partial result is still returned, not thrown
});
