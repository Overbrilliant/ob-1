// Deterministic test for the graduated green contract (no spawn — injected executor).
// Usage: bun run scripts/green-contract-smoke.ts
import { GREEN_LEVELS, isGreenLevel, levelKinds, checksForLevel, evaluateContract } from "../src/agent/green-contract.ts";
import { runVerification, type Check, type CheckResult } from "../src/agent/verify.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const R = (name: string, kind: any, ok: boolean): CheckResult => ({ name, kind, ok, output: ok ? "" : "boom", command: name });

// ── level → kinds ─────────────────────────────────────────────────────────────
check("levels are ordered targeted→package→workspace→merge_ready", GREEN_LEVELS.join(",") === "targeted_tests,package,workspace,merge_ready");
check("isGreenLevel recognizes a level, not a kind", isGreenLevel("merge_ready") && !isGreenLevel("typecheck"));
check("package requires typecheck+test", levelKinds("package").join(",") === "typecheck,test");
check("workspace requires all four", levelKinds("workspace").join(",") === "typecheck,lint,test,build");

// ── checksForLevel filters detected checks ────────────────────────────────────
const detected: Check[] = [
  { name: "typecheck", kind: "typecheck", command: "tsc --noEmit", auto: true },
  { name: "lint", kind: "lint", command: "eslint .", auto: false },
  { name: "test", kind: "test", command: "bun test", auto: false },
];
check("checksForLevel(package) → typecheck+test only (no lint)", checksForLevel("package", detected).map((c) => c.name).sort().join(",") === "test,typecheck");

// ── evaluateContract: pass/fail + coverage ─────────────────────────────────────
check("package satisfied when typecheck+test pass", evaluateContract("package", [R("typecheck", "typecheck", true), R("test", "test", true)]).satisfied);
check("package NOT satisfied when a check fails", !evaluateContract("package", [R("typecheck", "typecheck", true), R("test", "test", false)]).satisfied);
check("package NOT satisfied when a required kind is MISSING (coverage gap)", (() => {
  const c = evaluateContract("package", [R("typecheck", "typecheck", true)]); // no test ran
  return !c.satisfied && c.missingKinds.includes("test");
})());
check("targeted_tests is satisfied by any passing test (lenient coverage)", evaluateContract("targeted_tests", [R("test", "test", true)]).satisfied);
check("targeted_tests NOT satisfied when nothing ran", !evaluateContract("targeted_tests", []).satisfied);

// ── known-flake handling ───────────────────────────────────────────────────────
const withFlake = [R("typecheck", "typecheck", true), R("lint", "lint", true), R("test", "test", false), R("build", "build", true)];
check("workspace TOLERATES a known flake (test) → satisfied", (() => {
  const c = evaluateContract("workspace", withFlake, { knownFlakes: ["test"] });
  return c.satisfied && c.flakesIgnored.some((r) => r.name === "test");
})());
check("merge_ready NEVER tolerates a flake → NOT satisfied", !evaluateContract("merge_ready", withFlake, { knownFlakes: ["test"] }).satisfied);
check("workspace blocks a NON-flaky failure even with a flake list", !evaluateContract("workspace", withFlake, { knownFlakes: ["lint"] }).satisfied);
check("blockKnownFlakes:true forces a flake to count below merge_ready", !evaluateContract("workspace", withFlake, { knownFlakes: ["test"], blockKnownFlakes: true }).satisfied);

// ── integration: verify tool path via runVerification + a mock package.json + injected exec ──────
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ob1-green-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest" } }));
    // Injected executor: typecheck passes (code 0), test fails (code 1) — deterministic, no real spawn.
    const exec = async (cmd: string) => (/test|vitest/.test(cmd) ? { code: 1, output: "1 failing" } : { code: 0, output: "" });
    const r = await runVerification(dir, exec, levelKinds("package"));
    const contract = evaluateContract("package", r.results, {});
    check("integration: package contract runs typecheck+test and reports the failing test", !contract.satisfied && contract.failing.some((f) => f.kind === "test"));
    // mark the test as a known flake at workspace level (lint/build absent → still missing-coverage)
    const contractFlake = evaluateContract("package", r.results, { knownFlakes: ["test"] });
    check("integration: declaring the test a flake satisfies the package contract", contractFlake.satisfied && contractFlake.flakesIgnored.length === 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (fail) { console.error("\n✗ green-contract smoke FAILED"); process.exit(1); }
console.log("\n✓ green-contract smoke passed");
