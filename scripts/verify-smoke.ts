// Deterministic test for self-verification + the auto self-fix loop (no API key, no spawning). Covers:
//   • detectChecks — per-ecosystem detection (JS/TS scripts + tsconfig, Rust, Go, Python) + auto flags
//   • selectChecks / parseScope — scope selection (auto / all / named kinds)
//   • runVerification — pass / fail / no-checks, via an injected executor (no real commands run)
//   • runTurn integration — after a file-changing turn, a failing check feeds back and the model
//     self-corrects until green; the round budget is respected; a no-edit turn never verifies
// Usage: bun run scripts/verify-smoke.ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChecks, selectChecks, parseScope, runVerification, type Exec } from "../src/agent/verify.ts";
import { runTurn, type TurnDeps } from "../src/agent/loop.ts";
import type { Tool } from "../src/agent/tools.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import { loadConfig } from "../src/config.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const mkdtemp = (tag: string) => mkdtempSync(join(tmpdir(), `ob1-verify-${tag}-`));

// ── detectChecks: JS/TS via package.json scripts + bun lockfile ──
{
  const d = mkdtemp("js");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test", build: "gatsby build", lint: "eslint ." } }));
  writeFileSync(join(d, "bun.lockb"), "");
  const checks = detectChecks(d);
  const by = (k: string) => checks.find((c) => c.kind === k);
  check("JS: detects typecheck/test/build/lint", checks.length === 4);
  check("JS: typecheck uses the script via bun", by("typecheck")?.command === "bun run typecheck");
  check("JS: typecheck is the only AUTO check", checks.filter((c) => c.auto).length === 1 && by("typecheck")?.auto === true);
  check("JS: test/build/lint are NOT auto (agent runs them on demand)", !by("test")?.auto && !by("build")?.auto && !by("lint")?.auto);
  rmSync(d, { recursive: true, force: true });
}

// ── detectChecks: TS with only a tsconfig (no typecheck script) → npx tsc --noEmit ──
{
  const d = mkdtemp("tsc");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  writeFileSync(join(d, "tsconfig.json"), "{}");
  const checks = detectChecks(d);
  check("TS: tsconfig (no script) → tsc --noEmit auto check", checks.find((c) => c.kind === "typecheck")?.command === "npx tsc --noEmit");
  check("TS: still picks up the test script", checks.some((c) => c.kind === "test" && c.command === "npm test"));
  rmSync(d, { recursive: true, force: true });
}

// ── detectChecks: Rust / Go / Python ──
{
  const r = mkdtemp("rust"); writeFileSync(join(r, "Cargo.toml"), "[package]");
  check("Rust: cargo check is the auto gate + cargo test on demand", detectChecks(r).some((c) => c.command === "cargo check" && c.auto) && detectChecks(r).some((c) => c.command === "cargo test" && !c.auto));
  rmSync(r, { recursive: true, force: true });

  const g = mkdtemp("go"); writeFileSync(join(g, "go.mod"), "module x");
  check("Go: go build ./... auto + go test ./... on demand", detectChecks(g).some((c) => c.command === "go build ./..." && c.auto) && detectChecks(g).some((c) => c.command === "go test ./..."));
  rmSync(g, { recursive: true, force: true });

  const p = mkdtemp("py"); writeFileSync(join(p, "pyproject.toml"), "[tool.ruff]\n[tool.mypy]\n");
  const pc = detectChecks(p);
  check("Python: ruff + mypy detected from pyproject, pytest on demand", pc.some((c) => c.command === "ruff check .") && pc.some((c) => c.command === "mypy .") && pc.some((c) => c.command === "pytest -q" && !c.auto));
  rmSync(p, { recursive: true, force: true });

  const empty = mkdtemp("empty");
  check("no markers → no checks detected", detectChecks(empty).length === 0);
  rmSync(empty, { recursive: true, force: true });
}

// ── selectChecks / parseScope ──
{
  const all = [
    { name: "typecheck", kind: "typecheck" as const, command: "tsc", auto: true },
    { name: "test", kind: "test" as const, command: "test", auto: false },
    { name: "build", kind: "build" as const, command: "build", auto: false },
  ];
  check("selectChecks auto → only auto checks", selectChecks(all, "auto").length === 1);
  check("selectChecks all → everything", selectChecks(all, "all").length === 3);
  check("selectChecks by kind list", selectChecks(all, ["test", "build"]).map((c) => c.name).join(",") === "test,build");
  check("parseScope: blank/auto/fast → auto", parseScope("") === "auto" && parseScope("auto") === "auto" && parseScope("fast") === "auto");
  check("parseScope: all → all", parseScope("all") === "all");
  check("parseScope: comma/space list → kinds", JSON.stringify(parseScope("typecheck, test")) === JSON.stringify(["typecheck", "test"]));
}

// ── runVerification with an injected executor (pass / fail / no-checks) ──
{
  const d = mkdtemp("run");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test" } }));
  const okExec: Exec = async () => ({ code: 0, output: "all good" });
  const passed = await runVerification(d, okExec, "auto");
  check("runVerification: all pass → ran && ok", passed.ran && passed.ok && passed.report.includes("✓ typecheck passed"));

  const failExec: Exec = async (cmd) => cmd.includes("typecheck") ? ({ code: 2, output: "src/x.ts(1,1): error TS1005" }) : ({ code: 0, output: "" });
  const failed = await runVerification(d, failExec, "all");
  check("runVerification: a failing check → !ok with its output", failed.ran && !failed.ok && failed.report.includes("✗ typecheck FAILED") && failed.report.includes("TS1005"));
  check("runVerification: passing checks still reported alongside failures", failed.report.includes("✓ test passed"));
  rmSync(d, { recursive: true, force: true });

  const bare = mkdtemp("bare");
  const none = await runVerification(bare, okExec, "auto");
  check("runVerification: no checks → ran:false (no false 'verified')", none.ran === false && none.ok === true && none.report.includes("no checks"));
  rmSync(bare, { recursive: true, force: true });
}

// ── runTurn integration: a file-changing turn that fails verification self-corrects until green ──
const cfg = { ...loadConfig(), apiKey: "test-key", planMode: false } as any;
const store = { searchSemantic: async () => [], listFacts: () => [], listRelationships: () => [] } as any;
const writeTool: [string, Tool] = ["write_file", { def: { name: "write_file", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "wrote file" }];
const tools = new Map<string, Tool>([writeTool]);
const baseDeps: TurnDeps = { cfg, tools, store, approve: async () => true, log: () => {} };
const edit = (): ModelResponse => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "w" + Math.round(Math.random() * 1e9), name: "write_file", input: { path: "a.ts" } }], usage: { input_tokens: 1, output_tokens: 1 } });
const done = (t: string): ModelResponse => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 1, output_tokens: 1 } });

{
  // model: edit → (verify fails) → edit again → (verify passes)
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: verifyCalls >= 2, report: verifyCalls >= 2 ? "✓ ok" : "✗ typecheck FAILED: boom" }; };
  const seq = [edit(), done("done (first attempt)"), edit(), done("fixed it")];
  let n = 0;
  const history: any[] = [];
  await runTurn("change the code", history, { ...baseDeps, verify, _callModel: async () => seq[n++] });
  check("self-fix: verify runs after a file-changing turn finishes", verifyCalls === 2, `calls=${verifyCalls}`);
  check("self-fix: a failure is fed back into history for the model to fix", history.some((m) => typeof m.content === "string" && m.content.includes("verification of your changes FAILED")));
  check("self-fix: the model consumed all 4 scripted responses (it kept going until green)", n === 4);
}

{
  // round budget: verify ALWAYS fails, autofixMax=2 → stops after 3 verify calls (initial + 2 corrections), no hang
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: false, report: "✗ still broken" }; };
  const seq = [edit(), done("a"), edit(), done("b"), edit(), done("c"), edit(), done("d")];
  let n = 0;
  await runTurn("change it", [], { ...baseDeps, verify, autofixMax: 2, _callModel: async () => seq[n++] });
  check("self-fix: respects the round budget (stops, doesn't loop forever)", verifyCalls === 3, `calls=${verifyCalls}`);
}

{
  // a turn that does NOT change files never triggers verification
  let verifyCalls = 0;
  const verify = async () => { verifyCalls++; return { ran: true, ok: true, report: "" }; };
  await runTurn("just answer a question", [], { ...baseDeps, verify, _callModel: async () => done("here's the answer") });
  check("self-fix: a no-edit turn does NOT verify", verifyCalls === 0);
}

// ── step-retry: a mid-stream model failure (the proxy's router falling back to another model) must
//    re-issue the step, NOT kill the whole turn ──
{
  let calls = 0;
  const _callModel = async (): Promise<ModelResponse> => {
    calls++;
    if (calls === 1) throw new Error("stream idle > 90000ms"); // retryable mid-stream failure
    return done("recovered and answered");
  };
  const history: any[] = [];
  await runTurn("answer me", history, { ...baseDeps, _callModel } as any);
  check("step-retry: a mid-stream failure re-issues the step (turn not killed)", calls === 2, `calls=${calls}`);
  check("step-retry: the turn completes with the model's answer", history.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("recovered and answered")));
}

{
  // bounded: a PERSISTENT mid-stream failure gives up after OB1_STEP_RETRIES (no infinite loop)
  const saved = process.env.OB1_STEP_RETRIES; process.env.OB1_STEP_RETRIES = "2";
  let calls = 0;
  const _callModel = async (): Promise<ModelResponse> => { calls++; throw new Error("stream idle > 90000ms"); };
  await runTurn("answer", [], { ...baseDeps, _callModel } as any);
  check("step-retry: bounded by OB1_STEP_RETRIES (initial + 2 retries = 3, no infinite loop)", calls === 3, `calls=${calls}`);
  if (saved === undefined) delete process.env.OB1_STEP_RETRIES; else process.env.OB1_STEP_RETRIES = saved;
}

{
  // a NON-retryable client error (e.g. 401) must still stop — don't retry a config/auth problem forever
  let calls = 0;
  const _callModel = async (): Promise<ModelResponse> => { calls++; throw new Error("API 401: unauthorized"); };
  await runTurn("answer", [], { ...baseDeps, _callModel } as any);
  check("step-retry: a non-retryable error (401) still stops (calls once)", calls === 1, `calls=${calls}`);
}

if (fail) { console.error("\n✗ verify smoke FAILED"); process.exit(1); }
console.log("\n✓ verify smoke passed (detect JS/Rust/Go/Python · scope select · runVerification pass/fail/none · self-fix loop + budget + no-edit skip · step-retry on mid-stream failure + bound + non-retryable stop)");
process.exit(0);
