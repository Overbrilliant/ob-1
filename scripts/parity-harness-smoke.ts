// Mock-provider parity harness: scripted scenarios drive the REAL agent loop (runTurn) via an injected
// scripted model, asserting wire behavior (tool roundtrips, denials, multi-tool, stable system prompt).
// Usage: bun run scripts/parity-harness-smoke.ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, type TurnDeps } from "../src/agent/loop.ts";
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

if (fail) { console.error("\n✗ parity-harness smoke FAILED"); process.exit(1); }
console.log("\n✓ parity-harness smoke passed");
