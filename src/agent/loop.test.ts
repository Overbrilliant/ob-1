// Unit tests for the PURE verified-escalation decision (loop.ts `shouldEscalate`). The precondition — a
// genuine verified failure after the self-fix budget — is the caller's; this helper only gates the three
// policy flags, so it's fully testable without a model, subprocess, or filesystem. The end-to-end wiring
// (runTurn actually returning { escalate }) is exercised deterministically by scripts/escalation-smoke.ts.
// Run: bun test src/agent/loop.test.ts
import { test, expect } from "bun:test";
import { shouldEscalate } from "./loop.ts";

test("shouldEscalate — default allowed path (escalation on, act mode, not aborted) → escalate", () => {
  expect(shouldEscalate({ canEscalateOnFailure: true, planMode: false, aborted: false })).toBe(true);
});

test("shouldEscalate — escalation OFF (cfg.escalation=false / apply-turn override) → never", () => {
  expect(shouldEscalate({ canEscalateOnFailure: false, planMode: false, aborted: false })).toBe(false);
  // undefined (dep not wired) is treated as off, not on — no accidental escalation.
  expect(shouldEscalate({ canEscalateOnFailure: undefined, planMode: false, aborted: false })).toBe(false);
});

test("shouldEscalate — Plan mode (read-only) → never, even with escalation on", () => {
  expect(shouldEscalate({ canEscalateOnFailure: true, planMode: true, aborted: false })).toBe(false);
});

test("shouldEscalate — aborted (ESC) → never, even with escalation on", () => {
  expect(shouldEscalate({ canEscalateOnFailure: true, planMode: false, aborted: true })).toBe(false);
});

test("shouldEscalate — all three gates must hold; any single failing gate blocks", () => {
  // Exhaustive truth table over the 3 flags: escalate iff on && !plan && !aborted.
  for (const on of [true, false]) for (const plan of [true, false]) for (const aborted of [true, false]) {
    const expected = on && !plan && !aborted;
    expect(shouldEscalate({ canEscalateOnFailure: on, planMode: plan, aborted })).toBe(expected);
  }
});
