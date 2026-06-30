// Mock-provider parity harness: scripted scenarios drive the REAL agent loop (runTurn) via an injected
// scripted model, asserting wire behavior (tool roundtrips, denials, multi-tool, stable system prompt).
// Usage: bun run scripts/parity-harness-smoke.ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, looksLikeUnsentToolCall, type TurnDeps } from "../src/agent/loop.ts";
import { buildTools } from "../src/agent/tools.ts";
import { loadConfig } from "../src/config.ts";
import { MockBrain, asText, asToolUse, toolResultsIn } from "../src/eval/parity.ts";
import type { CallOpts, Message } from "../src/providers/types.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const dir = mkdtempSync(join(tmpdir(), "ob1-parity-"));
const store = { searchSemantic: async () => [], listFacts: () => [], listRelationships: () => [] } as any;
const baseCfg = { ...loadConfig(), apiKey: "test-key", cwd: dir, dataDir: dir, planMode: false, sandbox: "off", repoMap: false, qualityMode: "normal" } as any;

function deps(cfg: any, brain: MockBrain, over: Partial<TurnDeps> = {}): TurnDeps {
  return {
    cfg, store, tools: buildTools(cfg, store), approve: async () => true, log: () => {},
    verify: undefined, _callModel: brain.callModel, ...over,
  };
}

// ── scenario 1: streaming_text — a plain answer, no tools ─────────────────────
{
  const brain = new MockBrain([asText("Hello there")]);
  const history: Message[] = [];
  await runTurn("hi", history, deps(baseCfg, brain));
  check("streaming_text: one model call", brain.steps === 1);
  check("streaming_text: assistant text recorded in history", history.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "text" && b.text === "Hello there")));
  check("streaming_text: the user turn was sent", !!brain.request(0)?.messages.some((m) => m.role === "user" && m.content === "hi"));
}

// ── scenario 1b: quality prompt guidance is per-turn volatile, not cached ────
{
  let seenSystem: CallOpts["system"] | undefined;
  const history: Message[] = [];
  await runTurn("Create a website with a dark mode toggle", history, deps(baseCfg, new MockBrain([]), {
    _callModel: async (opts) => { seenSystem = opts.system; return asText("done"); },
  }));
  const blocks = Array.isArray(seenSystem) ? seenSystem : [];
  check("quality_contract: cached prefix stays task-agnostic",
    blocks[0]?.cache === true && !blocks[0]?.text.includes("Task Quality Contract") &&
    blocks[1]?.cache === false && blocks[1]?.text.includes("Task Quality Contract"));
}

// ── scenario 2: read_file_roundtrip — tool_use → result fed back → answer ──────
{
  writeFileSync(join(dir, "f.txt"), "the answer is 42");
  const brain = new MockBrain([asToolUse([{ name: "read_file", input: { path: "f.txt" } }]), asText("It says 42")]);
  const history: Message[] = [];
  await runTurn("read f.txt", history, deps(baseCfg, brain));
  check("read_roundtrip: two model calls (tool, then answer)", brain.steps === 2);
  const fed = toolResultsIn(brain.request(1));
  check("read_roundtrip: the file content was fed back as a tool_result", fed.length === 1 && /the answer is 42/.test(fed[0].content) && !fed[0].is_error);
  check("read_roundtrip: final assistant answer present", history.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.text === "It says 42")));
  check("read_roundtrip: system prompt identical across both steps (stable cache prefix)", brain.request(0)?.system === brain.request(1)?.system);
  check("read_roundtrip: tools advertised on every request", (brain.request(0)?.toolNames.length ?? 0) > 0 && !!brain.request(0)?.toolNames.includes("read_file"));
}

// ── scenario 3: write_file_denied — gate denies → is_error fed back, no write ──
{
  const brain = new MockBrain([asToolUse([{ name: "write_file", input: { path: "out.txt", content: "x" } }]), asText("understood, not writing")]);
  const history: Message[] = [];
  // permissionMode ask + approve:false → the gate denies the write
  await runTurn("write out.txt", history, deps({ ...baseCfg, permissionMode: "ask" }, brain, { approve: async () => false }));
  check("write_denied: file was NOT written", !existsSync(join(dir, "out.txt")));
  const fed = toolResultsIn(brain.request(1));
  check("write_denied: denial surfaced as an is_error tool_result", fed.length === 1 && !!fed[0].is_error && /denied/i.test(fed[0].content));
}

// ── scenario 4: multi_tool_turn — two tool calls in one assistant message ──────
{
  writeFileSync(join(dir, "a.txt"), "AAA");
  writeFileSync(join(dir, "b.txt"), "BBB");
  const brain = new MockBrain([asToolUse([{ name: "read_file", input: { path: "a.txt" } }, { name: "read_file", input: { path: "b.txt" } }]), asText("read both")]);
  const history: Message[] = [];
  await runTurn("read both", history, deps(baseCfg, brain));
  const fed = toolResultsIn(brain.request(1));
  check("multi_tool: BOTH tool_results fed back in the next request", fed.length === 2 && fed.some((r) => /AAA/.test(r.content)) && fed.some((r) => /BBB/.test(r.content)));
}

// ── scenario 5: bash_roundtrip — run a real (sandbox-off) command, result fed back ──
{
  const brain = new MockBrain([asToolUse([{ name: "run_bash", input: { command: "echo parity-ok" } }]), asText("done")]);
  const history: Message[] = [];
  await runTurn("echo", history, deps(baseCfg, brain, { onMutate: () => {} }));
  const fed = toolResultsIn(brain.request(1));
  check("bash_roundtrip: command stdout fed back", fed.length === 1 && /parity-ok/.test(fed[0].content));
}

// ── scenario 6: blocked bash — catastrophic command is refused by the safety floor ──
{
  const brain = new MockBrain([asToolUse([{ name: "run_bash", input: { command: "rm -rf /" } }]), asText("ok")]);
  const history: Message[] = [];
  await runTurn("danger", history, deps(baseCfg, brain, { onMutate: () => {} }));
  const fed = toolResultsIn(brain.request(1));
  check("blocked_bash: catastrophic rm refused, surfaced as is_error", fed.length === 1 && !!fed[0].is_error && /blocked by safety policy/.test(fed[0].content));
}

// ── scenario 7: tool_call_as_json_text — a write serialized into content (no real tool_use) is steered ──
// A weak model "writes" its tool call as a bare JSON object in the text instead of emitting a tool_use, so
// nothing runs. The degenerate-turn guard must detect this, nudge once, and let the recovered real call run.
{
  const brain = new MockBrain([
    asText('{"path":"out7.txt","content":"recovered"}'),                 // serialized call — executes nothing
    asToolUse([{ name: "write_file", input: { path: "out7.txt", content: "recovered" } }]), // model recovers
    asText("done"),
  ]);
  const history: Message[] = [];
  await runTurn("make out7.txt", history, deps(baseCfg, brain, { onMutate: () => {} }));
  check("json_text_call: the turn did NOT end on the serialized call (it was steered to retry)", brain.steps === 3);
  check("json_text_call: a corrective nudge about text/JSON tool calls was injected",
    !!brain.request(1)?.messages.some((m) => m.role === "user" && typeof m.content === "string" && /as TEXT|serialized|never print a tool call/i.test(m.content)));
  check("json_text_call: the recovered real write actually wrote the file", existsSync(join(dir, "out7.txt")) && readFileSync(join(dir, "out7.txt"), "utf8") === "recovered");
}

// ── scenario 8: json_text_call_AFTER_real_work — fires even once stepsWithTools>0 (the task-09 shape) ──
// The model reads a file (real tool_use), THEN serializes its fix as JSON text and stalls. The old guard
// only fired on a pure no-op turn (stepsWithTools===0) and let this slip through unsolved.
{
  writeFileSync(join(dir, "src8.txt"), "input");
  const brain = new MockBrain([
    asToolUse([{ name: "read_file", input: { path: "src8.txt" } }]),     // real work first
    asText('{"path":"fix8.txt","content":"fixed"}'),                     // then a serialized call — nothing runs
    asToolUse([{ name: "write_file", input: { path: "fix8.txt", content: "fixed" } }]), // recovers
    asText("done"),
  ]);
  const history: Message[] = [];
  await runTurn("fix it", history, deps(baseCfg, brain, { onMutate: () => {} }));
  check("json_text_after_work: steered to retry despite earlier real tool calls", brain.steps === 4);
  check("json_text_after_work: the fix file was written by the recovered call", existsSync(join(dir, "fix8.txt")));
}

// ── scenario 8b: false capability refusal — model says it cannot write files despite file tools ──
// A live FreeLLMAPI run did this for a PHP task: it returned a code block and claimed it couldn't create
// files. The guard must nudge once so the model uses write_file instead of ending the turn as "success".
{
  const brain = new MockBrain([
    asText("I currently don't have the capability to create or write files directly.\n\n```php\n<?php // MATRIX_PHP_OK\n```"),
    asToolUse([{ name: "write_file", input: { path: "index.php", content: "<?php // MATRIX_PHP_OK\n" } }]),
    asText("done"),
  ]);
  const history: Message[] = [];
  await runTurn("create index.php", history, deps(baseCfg, brain, { onMutate: () => {} }));
  check("capability_refusal: the turn did NOT end on the refusal", brain.steps === 3);
  check("capability_refusal: corrective nudge says file tools are available",
    !!brain.request(1)?.messages.some((m) => m.role === "user" && typeof m.content === "string" && /DO have file tools|write_file/i.test(m.content)));
  check("capability_refusal: recovered write_file created index.php",
    existsSync(join(dir, "index.php")) && readFileSync(join(dir, "index.php"), "utf8").includes("MATRIX_PHP_OK"));
}

// ── scenario 9: no false positive — an explanatory final answer that NAMES a tool isn't flagged ──
// A normal answer mentioning a tool (after real work) must NOT be treated as an unsent tool call.
{
  writeFileSync(join(dir, "r9.txt"), "data");
  const brain = new MockBrain([
    asToolUse([{ name: "read_file", input: { path: "r9.txt" } }]),
    asText("I used read_file to inspect r9.txt and everything looks correct. No changes were needed."),
  ]);
  const history: Message[] = [];
  await runTurn("check r9", history, deps(baseCfg, brain, { onMutate: () => {} }));
  check("no_false_positive: a prose answer naming a tool ends cleanly (no extra retry step)", brain.steps === 2);
}

// ── scenario 9b: detector unit checks (looksLikeUnsentToolCall) ──────────────
{
  check("detector: bare JSON write call → true", looksLikeUnsentToolCall('{"path":"a.py","content":"x"}'));
  check("detector: ```json-fenced call → true", looksLikeUnsentToolCall('```json\n{"path":"a.py","content":"x"}\n```'));
  check("detector: prose call → true", looksLikeUnsentToolCall('write_file(path="a.py", content="x")'));
  check("detector: serialized run_bash → true", looksLikeUnsentToolCall('{"command":"bun test"}'));
  check("detector: normal prose answer → false", !looksLikeUnsentToolCall("All tests pass; I edited calc.py to fix the precedence bug."));
  check("detector: answer mentioning a tool name → false", !looksLikeUnsentToolCall("I called read_file to inspect the file and it looks fine."));
  check("detector: a JSON example without tool keys → false", !looksLikeUnsentToolCall('{"name":"ada","age":3}'));
  check("detector: empty → false", !looksLikeUnsentToolCall("   "));
}

if (fail) { console.error("\n✗ parity-harness smoke FAILED"); process.exit(1); }
console.log("\n✓ parity-harness smoke passed");
