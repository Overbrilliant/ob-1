// Unit tests for the auto verifier signal (evaluate.ts) — the PURE parts, with injected seams so nothing
// spawns a real subprocess or hits the network. Run: bun test src/multimind/evaluate.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectSignal,
  evaluateInDir,
  parsePassFraction,
  rankFrontierModels,
  ensembleModels,
  tail,
  type Signal,
  type FrontierModel,
  type ExecInDir,
} from "./evaluate.ts";
import type { Config } from "../config.ts";

// ── parsePassFraction: per-runner formats ──────────────────────────────────────
test("parsePassFraction — bun test 'N pass / M fail'", () => {
  expect(parsePassFraction(" 5 pass\n 1 fail\n 6 expect() calls\nRan 6 tests")).toBeCloseTo(5 / 6, 6);
  expect(parsePassFraction(" 3 pass\n 0 fail")).toBe(1);
});
test("parsePassFraction — vitest/jest 'Tests: X failed, Y passed'", () => {
  expect(parsePassFraction("Tests:       1 failed, 4 passed, 5 total")).toBeCloseTo(4 / 5, 6);
  expect(parsePassFraction("Tests: 5 passed, 5 total")).toBe(1);
});
test("parsePassFraction — pytest 'X failed, Y passed'", () => {
  expect(parsePassFraction("=== 1 failed, 3 passed in 0.05s ===")).toBeCloseTo(3 / 4, 6);
  expect(parsePassFraction("=== 3 passed in 0.02s ===")).toBe(1);
});
test("parsePassFraction — cargo 'Y passed; X failed'", () => {
  expect(parsePassFraction("test result: FAILED. 3 passed; 1 failed; 0 ignored")).toBeCloseTo(3 / 4, 6);
});
test("parsePassFraction — go (no counts) and empty → undefined", () => {
  expect(parsePassFraction("ok  \tmypkg\t0.01s\nFAIL\tother")).toBeUndefined();
  expect(parsePassFraction("")).toBeUndefined();
  expect(parsePassFraction("build failed: some error")).toBeUndefined();
});
test("parsePassFraction — 'pass' word-boundary does not eat 'passed'", () => {
  // jest 'passed'/'failed' must win the worded parser, not be mis-summed by the bun 'pass'/'fail' parser.
  expect(parsePassFraction("2 failed, 2 passed")).toBe(0.5);
});

// ── evaluateInDir: runs the signal's commands via an injected executor ──────────
const fakeCfg = { sandbox: "off" } as unknown as Config;
const mkExec = (byCmd: Record<string, { code: number; output: string }>): { exec: ExecInDir; calls: string[] } => {
  const calls: string[] = [];
  const exec = (async (o: { command: string }) => {
    calls.push(o.command);
    return byCmd[o.command] ?? { code: 0, output: "ok" };
  }) as unknown as ExecInDir;
  return { exec, calls };
};

test("evaluateInDir — all commands pass → ok, score 1", async () => {
  const sig: Signal = { tier: "test", testCmd: "bun test", autoCmds: ["tsc --noEmit"] };
  const { exec, calls } = mkExec({ "tsc --noEmit": { code: 0, output: "" }, "bun test": { code: 0, output: "3 pass\n0 fail" } });
  const s = await evaluateInDir("/x", fakeCfg, sig, {}, exec);
  expect(s.ok).toBe(true);
  expect(s.checked).toBe(true);
  expect(s.score).toBe(1);
  expect(calls).toEqual(["tsc --noEmit", "bun test"]); // gate first, test last
});

test("evaluateInDir — compile gate fails → stop before tests, bounded output, score 0", async () => {
  const sig: Signal = { tier: "test", testCmd: "bun test", autoCmds: ["tsc --noEmit"] };
  const { exec, calls } = mkExec({ "tsc --noEmit": { code: 2, output: "TS2322 boom".padStart(5000, "x") } });
  const s = await evaluateInDir("/x", fakeCfg, sig, {}, exec);
  expect(s.ok).toBe(false);
  expect(s.checked).toBe(true);
  expect(s.score).toBe(0); // no test output → no fraction
  expect(s.output.length).toBeLessThanOrEqual(2000); // bounded tail
  expect(s.output).toContain("boom"); // the tail keeps the trailing error
  expect(calls).toEqual(["tsc --noEmit"]); // never ran the test command
});

test("evaluateInDir — partial test failure → fractional score", async () => {
  const sig: Signal = { tier: "test", testCmd: "bun test", autoCmds: [] };
  const { exec } = mkExec({ "bun test": { code: 1, output: " 3 pass\n 1 fail" } });
  const s = await evaluateInDir("/x", fakeCfg, sig, {}, exec);
  expect(s.ok).toBe(false);
  expect(s.score).toBeCloseTo(3 / 4, 6);
  expect(s.testOutput).toContain("fail");
});

test("evaluateInDir — no signal → UNSCORED (checked:false)", async () => {
  const sig: Signal = { tier: "none", autoCmds: [] };
  const { exec, calls } = mkExec({});
  const s = await evaluateInDir("/x", fakeCfg, sig, {}, exec);
  expect(s.checked).toBe(false);
  expect(calls).toEqual([]);
});

test("tail — keeps the trailing maxChars", () => {
  expect(tail("abcdef", 3)).toBe("def");
  expect(tail("ab", 5)).toBe("ab");
});

// ── detectSignal: reuses detectChecks; env override honored ─────────────────────
test("detectSignal — package.json scripts → test tier + auto gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob1-sig-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run" } }));
    const sig = detectSignal({ cwd: dir } as unknown as Config);
    expect(sig.tier).toBe("test");
    expect(sig.testCmd).toContain("test");
    expect(sig.autoCmds.length).toBeGreaterThan(0); // the typecheck gate
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectSignal — empty dir → none; OB1_FUSION_TEST_CMD forces test tier", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob1-sig-"));
  try {
    expect(detectSignal({ cwd: dir } as unknown as Config).tier).toBe("none");
    process.env.OB1_FUSION_TEST_CMD = "make check";
    const sig = detectSignal({ cwd: dir } as unknown as Config);
    expect(sig.tier).toBe("test");
    expect(sig.testCmd).toBe("make check");
  } finally {
    delete process.env.OB1_FUSION_TEST_CMD;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── rankFrontierModels: the diversity gate (pure, fake registry inputs) ─────────
const fm = (o: Partial<FrontierModel> & { id: string; displayName: string }): FrontierModel => ({
  available: true, sizeLabel: "Frontier", intelligenceRank: 5, succ: 0, fail: 0, ...o,
});

test("rankFrontierModels — Frontier-only; drops Medium/Small + unavailable", () => {
  const ranked = rankFrontierModels([
    fm({ id: "a/x", displayName: "Big", intelligenceRank: 2 }),
    fm({ id: "b/y", displayName: "Weak", sizeLabel: "Medium", intelligenceRank: 1, succ: 50 }), // excluded (not frontier)
    fm({ id: "c/z", displayName: "Sharp", intelligenceRank: 1 }), // best intelligence prior
    fm({ id: "d/w", displayName: "Down", available: false }), // excluded (unhealthy)
  ]);
  expect(ranked).toEqual(["c/z", "a/x"]); // intelligence prior breaks the (tied) reliability
  expect(ranked).not.toContain("b/y");
  expect(ranked).not.toContain("d/w");
});

test("rankFrontierModels — dedupe by display name keeps the best-ranked instance", () => {
  const ranked = rankFrontierModels([
    fm({ id: "p1/twin", displayName: "Twin", succ: 0, fail: 0 }),
    fm({ id: "p2/twin", displayName: "Twin", succ: 20, fail: 0 }), // same model, better bandit → this one
    fm({ id: "q/solo", displayName: "Solo" }),
  ]);
  expect(ranked).toContain("p2/twin");
  expect(ranked).not.toContain("p1/twin");
  expect(ranked[0]).toBe("p2/twin"); // reliability-dominant
});

test("rankFrontierModels — bandit reliability dominates ordering", () => {
  const ranked = rankFrontierModels([
    fm({ id: "hi/rel", displayName: "Reliable", intelligenceRank: 9, succ: 90, fail: 1 }),
    fm({ id: "lo/rel", displayName: "Flaky", intelligenceRank: 1, succ: 0, fail: 30 }),
  ]);
  expect(ranked[0]).toBe("hi/rel"); // reliability beats the intelligence prior
});

test("rankFrontierModels — fewer than 2 distinct frontier models", () => {
  expect(rankFrontierModels([fm({ id: "only/one", displayName: "Lonely" })]).length).toBe(1);
});

// ── ensembleModels: override + non-free provider (free path via pure ranker above) ──
test("ensembleModels — OB1_FUSION_MODELS override is verbatim (any provider)", () => {
  process.env.OB1_FUSION_MODELS = "a/one, b/two ,c/three";
  try {
    expect(ensembleModels({ provider: "openai", model: "sonnet" } as unknown as Config)).toEqual(["a/one", "b/two", "c/three"]);
  } finally { delete process.env.OB1_FUSION_MODELS; }
});

test("ensembleModels — non-free provider → the single active model (Self-MoA)", () => {
  delete process.env.OB1_FUSION_MODELS;
  expect(ensembleModels({ provider: "openai", model: "sonnet" } as unknown as Config)).toEqual(["sonnet"]);
});
