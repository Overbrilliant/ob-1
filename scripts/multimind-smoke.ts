// Deterministic test for the multi-mind runtime (no API key needed).
// Verifies: read-only tool filtering, and parallel execution preserving order.
import { runParallel, runWorker, readOnlyTools, type WorkerResult, type WorkerEvent } from "../src/multimind/runtime.ts";
import { shouldApply, applySolution } from "../src/multimind/apply.ts";
import { buildTools } from "../src/agent/tools.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { loadConfig } from "../src/config.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// --- read-only tool filtering ---
const cfg = loadConfig();
const dbPath = join(tmpdir(), `ob1-mm-${process.pid}.db`);
const store = new MemoryStore(dbPath);
const all = buildTools(cfg, store);
const ro = readOnlyTools(all);
const roNames = [...ro.keys()].sort();
console.log("read-only worker tools:", roNames.join(", "));

const mustHave = ["read_file", "list_dir", "repo_map", "memory_search", "use_skill"];
const mustNotHave = ["write_file", "edit_file", "run_bash", "memory_add", "relate"];
const filterOk = mustHave.every((n) => ro.has(n)) && mustNotHave.every((n) => !ro.has(n));

// --- parallel execution preserves order ---
const items = [0, 1, 2, 3, 4];
const out = await runParallel(
  items,
  async (n): Promise<WorkerResult> => {
    await new Promise((r) => setTimeout(r, (5 - n) * 5)); // reverse delay to test ordering
    return { label: `w${n}`, text: String(n), inputTokens: 0, outputTokens: 0, ok: true };
  },
  3,
);
const orderOk = out.length === 5 && out.every((r, i) => r.text === String(i));
console.log("parallel order:", out.map((r) => r.text).join(","));

// --- runWorker emits live progress: start → (per call) text + step + tool → done. This drives the
//     TUI's worker-by-worker feedback (streamed thinking, tool calls) + the per-call token meter. ---
const evs: WorkerEvent[] = [];
const stubTool = { def: { name: "read_file", description: "", input_schema: { type: "object" } }, run: async () => "file contents", mutating: false } as any;
let callN = 0;
const fakeCall = async (o: any): Promise<any> => {
  callN++;
  if (callN === 1) {                                    // first call: think out loud, then call a tool
    o.onText?.("thinking… ");
    return { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x.ts" } }], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 } };
  }
  o.onText?.("here is the answer");                     // second call: stream the final answer
  return { content: [{ type: "text", text: "final answer" }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 18 } };
};
const wr = await runWorker({
  label: "tester", task: "t", system: "s", cfg, tools: new Map([["read_file", stubTool]]),
  stream: true, onEvent: (e) => evs.push(e), _call: fakeCall as any,
});
const phases = evs.map((e) => e.phase).join("→");
console.log("worker events:", phases);
const sequenceOk = phases === "start→text→step→tool→text→step→done" && evs[0].label === "tester";
const textStreamed = evs.filter((e) => e.phase === "text").map((e: any) => e.delta).join("") === "thinking… here is the answer";
const toolSurfaced = evs.some((e) => e.phase === "tool" && (e as any).tool === "read_file" && (e as any).input.path === "x.ts");
const stepsCarryTokens = (() => { const s = evs.filter((e) => e.phase === "step") as any[]; return s.length === 2 && s[0].outputTokens === 4 && s[1].outputTokens === 18; })();
const doneCarriesTokens = (() => { const d = evs[evs.length - 1] as any; return d.phase === "done" && d.inputTokens === 11 && d.outputTokens === 22 && d.ok === true; })();
const workerOk = wr.text === "final answer" && wr.ok === true;
const startThenDone = sequenceOk && textStreamed && toolSurfaced && stepsCarryTokens;

// runWorker stops immediately when the cancel signal (ESC) is already aborted — never calls the model.
const ac = new AbortController(); ac.abort();
const wrStopped = await runWorker({
  label: "x", task: "t", system: "s", cfg, tools: new Map(), signal: ac.signal,
  _call: (async () => { throw new Error("model must not be called after abort"); }) as any,
});
const abortStops = wrStopped.ok === false && wrStopped.error === "aborted" && wrStopped.text === "(stopped)";
console.log("abort stops worker:", abortStops);

// --- apply-to-workspace gating: heavy modes write files only when there's code + not plan mode ---
const withCode = "Here is the page:\n```html\n<h1>hi</h1>\n```";
// A synthesis truncated before its closing ``` (facilitator ran out mid-file): still salvageable, must apply.
const truncated = "Here you go:\n```html\n<!DOCTYPE html><html><head><title>x</title></head><body><h1>Hello world</h1>";
const applyOk =
  shouldApply(withCode, false, {}) === true &&                       // code + act mode → apply
  shouldApply(withCode, true, {}) === false &&                        // plan mode → never write
  shouldApply("just a prose answer, no fences", false, {}) === false &&// no code → nothing to save
  shouldApply("", false, {}) === false &&                            // empty → skip
  shouldApply(withCode, false, { OB1_APPLY: "0" }) === false &&       // explicit opt-out
  shouldApply(truncated, false, {}) === true &&                      // unclosed-but-substantial fence → salvage
  shouldApply("```html\n<h1>", false, {}) === false;                 // unclosed + trivial → nothing worth saving
console.log("apply gating:", applyOk ? "ok" : "WRONG");

// --- applySolution actually DISPATCHES the gated agent turn (the "save files" step), carrying the
//     solution, and is correctly skipped when there's nothing to apply ---
let applied = "";
let called = false;
const runSpy = async (prompt: string) => { applied = prompt; called = true; };
const didApply = await applySolution({ task: "make a page", solution: withCode, planMode: false, run: runSpy, log: () => {}, env: {} });
const skippedPlan = await applySolution({ task: "x", solution: withCode, planMode: true, run: async () => { throw new Error("must not run in plan mode"); }, log: () => {}, env: {} });
const skippedProse = await applySolution({ task: "x", solution: "no code here", planMode: false, run: async () => { throw new Error("must not run without code"); }, log: () => {}, env: {} });
const dispatchOk =
  didApply === true && called && applied.includes("<h1>hi</h1>") && applied.includes("make a page") &&
  skippedPlan === false && skippedProse === false;
console.log("apply dispatch:", dispatchOk ? "ok" : "WRONG");

store.close();
for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });

const ok = filterOk && orderOk && startThenDone && doneCarriesTokens && workerOk && applyOk && dispatchOk && abortStops;
if (!ok) {
  console.error(`\n✗ multimind smoke FAILED (filter=${filterOk} order=${orderOk} start→done=${startThenDone} tokens=${doneCarriesTokens} text=${workerOk} apply=${applyOk} dispatch=${dispatchOk} abort=${abortStops})`);
  process.exit(1);
}
console.log("\n✓ multi-mind runtime smoke passed (read-only filtering + ordered parallel exec + live worker progress + apply gating + apply dispatch + ESC abort)");
