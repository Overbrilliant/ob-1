// Unit tests for the PURE test-edit guard (test-guard.ts). The loop supplies { inFixRound,
// afterFailedCheck } and the tool call; this decides refuse / flag / nothing. No model, no filesystem.
// Run: bun test src/agent/test-guard.test.ts
import { test, expect } from "bun:test";
import { describeTestEdits, guardTestEdit, isTestPath, parseGuardMode, writtenPaths } from "./test-guard.ts";

test("isTestPath — directory patterns anywhere in the path", () => {
  for (const p of ["test/foo.ts", "tests/unit/foo.py", "spec/models/user_spec.rb", "src/__tests__/app.tsx", "pkg/internal/tests/x.go", "./test/a.js", "a\\tests\\b.cs"]) {
    expect(isTestPath(p)).toBe(true);
  }
});

test("isTestPath — file-name patterns", () => {
  for (const p of ["src/agent/loop.test.ts", "src/x.spec.js", "handlers_test.go", "test_models.py", "lib/foo.tests.js", "app/user_spec.rb", "src/Foo.Test.cs"]) {
    expect(isTestPath(p)).toBe(true);
  }
});

test("isTestPath — source files are NOT tests", () => {
  for (const p of ["src/agent/loop.ts", "src/testing.ts", "src/latest/index.ts", "src/contest/run.py", "attest.go", "docs/spec.md", "src/testutils.ts", "README.md", ""]) {
    expect(isTestPath(p)).toBe(false);
  }
});

test("writtenPaths — only the file-writing tools report a path", () => {
  expect(writtenPaths("write_file", { path: "tests/a.ts", content: "" })).toEqual(["tests/a.ts"]);
  expect(writtenPaths("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" })).toEqual(["src/a.ts"]);
  expect(writtenPaths("architect_edit", { file: "spec/a.rb", instruction: "x" })).toEqual(["spec/a.rb"]);
  expect(writtenPaths("run_bash", { command: "echo > tests/a.ts" })).toEqual([]);
  expect(writtenPaths("read_file", { path: "tests/a.ts" })).toEqual([]);
  expect(writtenPaths("write_file", {})).toEqual([]);
});

test("guardTestEdit — refuses a test edit during a self-correction round (default mode)", () => {
  const d = guardTestEdit({ name: "edit_file", input: { path: "src/loop.test.ts" }, inFixRound: true, afterFailedCheck: true });
  expect(d.refuse).toBe(true);
  expect(d.flag).toBe(false);
  expect(d.paths).toEqual(["src/loop.test.ts"]);
  expect(d.reason).toContain("self-correction round");
  expect(d.reason).toContain("OB1_TEST_EDIT_GUARD=flag");
});

test("guardTestEdit — a source edit during a fix round is untouched", () => {
  const d = guardTestEdit({ name: "edit_file", input: { path: "src/loop.ts" }, inFixRound: true, afterFailedCheck: true });
  expect(d).toEqual({ paths: [], refuse: false, flag: false });
});

test("guardTestEdit — outside a fix round, a test edit after a failed check is allowed but flagged", () => {
  const d = guardTestEdit({ name: "write_file", input: { path: "tests/new.py", content: "" }, inFixRound: false, afterFailedCheck: true });
  expect(d.refuse).toBe(false);
  expect(d.flag).toBe(true);
  expect(d.reason).toContain("tests/new.py");
});

test("guardTestEdit — a test edit with no failing check this turn is normal work (writing tests is fine)", () => {
  const d = guardTestEdit({ name: "write_file", input: { path: "tests/new.py", content: "" }, inFixRound: false, afterFailedCheck: false });
  expect(d).toEqual({ paths: [], refuse: false, flag: false });
});

test("guardTestEdit — mode=flag never refuses, flags in a fix round", () => {
  const d = guardTestEdit({ name: "edit_file", input: { path: "test/a.ts" }, inFixRound: true, afterFailedCheck: true, mode: "flag" });
  expect(d.refuse).toBe(false);
  expect(d.flag).toBe(true);
});

test("guardTestEdit — mode=off does nothing", () => {
  const d = guardTestEdit({ name: "edit_file", input: { path: "test/a.ts" }, inFixRound: true, afterFailedCheck: true, mode: "off" });
  expect(d).toEqual({ paths: [], refuse: false, flag: false });
});

test("guardTestEdit — truth table: refuse iff test path && fix round && mode=refuse; flag iff test path && (fix round || failed check) && not refused", () => {
  for (const mode of ["refuse", "flag", "off"] as const) for (const fix of [true, false]) for (const failed of [true, false]) for (const path of ["tests/a.ts", "src/a.ts"]) {
    const d = guardTestEdit({ name: "write_file", input: { path, content: "" }, inFixRound: fix, afterFailedCheck: failed, mode });
    const isTest = path.startsWith("tests/");
    const expectRefuse = isTest && mode === "refuse" && fix;
    const expectFlag = isTest && mode !== "off" && !expectRefuse && (fix || failed);
    expect(d.refuse).toBe(expectRefuse);
    expect(d.flag).toBe(expectFlag);
  }
});

test("parseGuardMode — env spellings", () => {
  expect(parseGuardMode(undefined)).toBe("refuse");
  expect(parseGuardMode("")).toBe("refuse");
  expect(parseGuardMode("refuse")).toBe("refuse");
  expect(parseGuardMode("FLAG")).toBe("flag");
  expect(parseGuardMode("warn")).toBe("flag");
  expect(parseGuardMode("off")).toBe("off");
  expect(parseGuardMode("0")).toBe("off");
  expect(parseGuardMode("garbage")).toBe("refuse");
});

test("describeTestEdits — dedups and pluralises", () => {
  expect(describeTestEdits(["tests/a.ts", "tests/a.ts"])).toContain("test file modified");
  expect(describeTestEdits(["tests/a.ts", "tests/b.ts"])).toContain("test files modified");
  expect(describeTestEdits(["tests/a.ts"])).toContain("review the test change");
});
