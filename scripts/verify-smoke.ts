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

// ── detectChecks: BARE test files (no manifest) run with the language's built-in runner ──
{
  const ts = mkdtemp("bare-ts"); writeFileSync(join(ts, "cart.test.ts"), "");
  check("bare *.test.ts (no manifest) → bun test", detectChecks(ts).some((c) => c.kind === "test" && c.command === "bun test"));
  rmSync(ts, { recursive: true, force: true });

  const js = mkdtemp("bare-js"); writeFileSync(join(js, "debounce.test.js"), "");
  check("bare *.test.js (no manifest) → node --test", detectChecks(js).some((c) => c.kind === "test" && c.command === "node --test"));
  rmSync(js, { recursive: true, force: true });

  const py = mkdtemp("bare-py"); writeFileSync(join(py, "test_stats.py"), "");
  check("bare test_*.py (no manifest) → pytest", detectChecks(py).some((c) => c.kind === "test" && c.command === "pytest -q"));
  rmSync(py, { recursive: true, force: true });

  const py2 = mkdtemp("bare-py2"); writeFileSync(join(py2, "acceptance_test.py"), "");
  check("bare *_test.py (no manifest) → pytest", detectChecks(py2).some((c) => c.kind === "test" && c.command === "pytest -q"));
  rmSync(py2, { recursive: true, force: true });
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

{
  // If the agent explicitly ran a recognized project check after editing, don't falsely nudge "not verified"
  // just because the automatic fast-check scope is empty (common in JS repos with only a test script).
  const d = mkdtemp("explicit-check");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  const cfgWithTests = { ...cfg, cwd: d };
  const logs: string[] = [];
  let verifyCalls = 0;
  const editTool: [string, Tool] = ["edit_file", { def: { name: "edit_file", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "edited" }];
  const bashTool: [string, Tool] = ["run_bash", { def: { name: "run_bash", description: "", input_schema: { type: "object" } }, mutating: false, run: async () => "exit 0\n2 pass\n" }];
  const toolsWithBash = new Map<string, Tool>([editTool, bashTool]);
  const seq: ModelResponse[] = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "e", name: "edit_file", input: { path: "src/a.ts" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "run_bash", input: { command: "bun test" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    done("done"),
  ];
  let n = 0;
  await runTurn("fix and test", [], {
    ...baseDeps,
    cfg: cfgWithTests,
    tools: toolsWithBash,
    log: (s) => logs.push(s),
    verify: async () => { verifyCalls++; return { ran: false, ok: true, results: [], report: "no checks matched that scope (available: test)" }; },
    _callModel: async () => seq[n++],
  });
  check("self-fix: explicit successful test suppresses false unverified nudge", !logs.some((s) => s.includes("changes are NOT verified")), logs.join(" | "));
  check("self-fix: explicit successful test is reported as verified", logs.some((s) => s.includes("explicit check passed")), logs.join(" | "));
  check("self-fix: automatic verifier was still consulted", verifyCalls === 1, `calls=${verifyCalls}`);
  rmSync(d, { recursive: true, force: true });
}

{
  // A successful browser_check after a UI edit is also explicit verification. Without this, a static
  // website task can pass browser_check and then get nudged into redundant server/browser retries because
  // the project has no package-level auto checks.
  const logs: string[] = [];
  let verifyCalls = 0;
  const editTool: [string, Tool] = ["edit_file", { def: { name: "edit_file", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "edited" }];
  const browserTool: [string, Tool] = ["browser_check", { def: { name: "browser_check", description: "", input_schema: { type: "object" } }, mutating: false, run: async () => "✓ browser_check PASSED — file:///tmp/site/index.html" }];
  const seq: ModelResponse[] = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "e", name: "edit_file", input: { path: "site/index.html" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "b", name: "browser_check", input: { url: "site/index.html" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    done("done"),
  ];
  let n = 0;
  await runTurn("fix UI and browser-test it", [], {
    ...baseDeps,
    tools: new Map<string, Tool>([editTool, browserTool]),
    log: (s) => logs.push(s),
    verify: async () => { verifyCalls++; return { ran: false, ok: true, results: [], report: "no checks matched that scope" }; },
    _callModel: async () => seq[n++],
  });
  check("self-fix: passing browser_check suppresses false unverified nudge", !logs.some((s) => s.includes("changes are NOT verified")), logs.join(" | "));
  check("self-fix: passing browser_check is reported as explicit verification", logs.some((s) => s.includes("explicit check passed")), logs.join(" | "));
  check("self-fix: browser_check path still consults automatic verifier once", verifyCalls === 1, `calls=${verifyCalls}`);
}

{
  // Non-workspace mutating tools after a successful browser check (e.g. expose_port) must not invalidate
  // the verification state and trigger a redundant "not verified" nudge.
  const logs: string[] = [];
  let verifyCalls = 0;
  const editTool: [string, Tool] = ["edit_file", { def: { name: "edit_file", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "edited" }];
  const browserTool: [string, Tool] = ["browser_check", { def: { name: "browser_check", description: "", input_schema: { type: "object" } }, mutating: false, run: async () => "✓ browser_check PASSED — file:///tmp/site/index.html" }];
  const exposeTool: [string, Tool] = ["expose_port", { def: { name: "expose_port", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "https://preview.example" }];
  const seq: ModelResponse[] = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "e", name: "edit_file", input: { path: "site/index.html" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "b", name: "browser_check", input: { url: "site/index.html" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "p", name: "expose_port", input: { port: 3000 } }], usage: { input_tokens: 1, output_tokens: 1 } },
    done("done"),
  ];
  let n = 0;
  await runTurn("fix UI, verify, then preview", [], {
    ...baseDeps,
    tools: new Map<string, Tool>([editTool, browserTool, exposeTool]),
    log: (s) => logs.push(s),
    verify: async () => { verifyCalls++; return { ran: false, ok: true, results: [], report: "no checks matched that scope" }; },
    _callModel: async () => seq[n++],
  });
  check("self-fix: expose_port does not invalidate a passed browser_check", !logs.some((s) => s.includes("changes are NOT verified")) && logs.some((s) => s.includes("explicit check passed")), logs.join(" | "));
  check("self-fix: non-workspace mutations still leave one final verifier consult", verifyCalls === 1, `calls=${verifyCalls}`);
}

{
  // Fix A (dogfood): a BARE-test-file project (no manifest) where the agent runs its tests DIRECTLY
  // (`python3 test_app.py`) after editing must count as verification — not the false "NOT verified" nudge.
  const d = mkdtemp("bare-direct"); writeFileSync(join(d, "test_app.py"), "");
  const cfgBare = { ...cfg, cwd: d };
  const logs: string[] = [];
  const editTool: [string, Tool] = ["edit_file", { def: { name: "edit_file", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "edited" }];
  const bashTool: [string, Tool] = ["run_bash", { def: { name: "run_bash", description: "", input_schema: { type: "object" } }, mutating: false, run: async () => "exit 0\nok: all tests passed\n" }];
  const seq: ModelResponse[] = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "e", name: "edit_file", input: { path: "app.py" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "run_bash", input: { command: "python3 test_app.py" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    done("fixed"),
  ];
  let n = 0;
  await runTurn("fix and test", [], {
    ...baseDeps, cfg: cfgBare, tools: new Map<string, Tool>([editTool, bashTool]), log: (s) => logs.push(s),
    verify: async () => ({ ran: false, ok: true, results: [], report: "no checks matched that scope (available: pytest)" }),
    _callModel: async () => seq[n++],
  });
  check("dogfood A: a direct `python3 test_app.py` run counts as explicit verification", logs.some((s) => s.includes("explicit check passed")), logs.join(" | "));
  check("dogfood A: no false 'NOT verified' nudge after the tests passed", !logs.some((s) => s.includes("changes are NOT verified")), logs.join(" | "));
  rmSync(d, { recursive: true, force: true });
}

{
  // Fix A residual (dogfood re-run): a BENIGN command run AFTER a passing test (e.g. `python3 prog.py` to
  // show output — "unknown" intent) must NOT reset the explicit-check-passed state back to "unverified".
  const d = mkdtemp("post-check-bash"); writeFileSync(join(d, "test_app.py"), "");
  const logs: string[] = [];
  const editTool: [string, Tool] = ["edit_file", { def: { name: "edit_file", description: "", input_schema: { type: "object" } }, mutating: true, run: async () => "edited" }];
  const bashTool: [string, Tool] = ["run_bash", { def: { name: "run_bash", description: "", input_schema: { type: "object" } }, mutating: false, run: async () => "exit 0\nok\n" }];
  const seq: ModelResponse[] = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "e", name: "edit_file", input: { path: "app.py" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "run_bash", input: { command: "python3 test_app.py" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "r", name: "run_bash", input: { command: "python3 app.py sample.md" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    done("done"),
  ];
  let n = 0;
  await runTurn("build, test, then show output", [], {
    ...baseDeps, cfg: { ...cfg, cwd: d }, tools: new Map<string, Tool>([editTool, bashTool]), log: (s) => logs.push(s),
    verify: async () => ({ ran: false, ok: true, results: [], report: "no checks matched that scope" }),
    _callModel: async () => seq[n++],
  });
  check("dogfood A2: a benign command after a passing test stays verified (not 'unverified')", logs.some((s) => s.includes("explicit check passed")) && !logs.some((s) => s.includes("NOT verified")), logs.join(" | "));
  rmSync(d, { recursive: true, force: true });
}

{
  // Fix B (dogfood): a stuck model re-issuing the IDENTICAL read-only call must be loop-broken — the tool
  // runs at most MAX_IDENTICAL_CALLS (3) times, not once per repeat (the real case fired the same search 25×).
  let searchRuns = 0;
  const searchTool: [string, Tool] = ["web_search", { def: { name: "web_search", description: "", input_schema: { type: "object" } }, mutating: false, run: async () => { searchRuns++; return "results"; } }];
  const sameCall = (): ModelResponse => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "s" + Math.round(Math.random() * 1e9), name: "web_search", input: { query: "x" } }], usage: { input_tokens: 1, output_tokens: 1 } });
  const seq = [sameCall(), sameCall(), sameCall(), sameCall(), sameCall(), sameCall(), done("giving up")];
  let n = 0;
  const logs: string[] = [];
  await runTurn("search", [], { ...baseDeps, tools: new Map<string, Tool>([searchTool]), log: (s) => logs.push(s), _callModel: async () => seq[n++] });
  check("dogfood B: identical non-mutating call capped at MAX_IDENTICAL_CALLS (3), not 6", searchRuns === 3, `runs=${searchRuns}`);
  check("dogfood B: the loop-breaker surfaces a skip notice", logs.some((s) => s.includes("identical call repeated")));
}

{
  // Fix C (dogfood): a degenerate turn (no tool call, just a tool name in PROSE) is retried once with a
  // nudge instead of silently ending having done nothing. A real answer on the retry finishes cleanly.
  const logs: string[] = [];
  const seq = [done('read_file(path="cart.ts")'), done("Here is the real, complete answer.")];
  let n = 0;
  await runTurn("do the task", [], { ...baseDeps, log: (s) => logs.push(s), _callModel: async () => seq[n++] });
  check("dogfood C: a degenerate prose-tool-call turn is retried once", n === 2, `n=${n}`);
  check("dogfood C: the retry nudge is surfaced", logs.some((s) => /wrote a tool call as text|ended without taking any action/.test(s)));
}

{
  // Fix C negative: a NORMAL no-tool answer must NOT be flagged degenerate / retried.
  let n = 0;
  const logs: string[] = [];
  await runTurn("what is 2+2?", [], { ...baseDeps, log: (s) => logs.push(s), _callModel: async () => { n++; return done("2 + 2 equals 4."); } });
  check("dogfood C: a real one-shot answer is not retried", n === 1, `n=${n}`);
  check("dogfood C: no false no-op warning on a real answer", !logs.some((s) => s.includes("without taking any action")));
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
