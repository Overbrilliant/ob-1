// Deterministic test (no API key) for write-capable Council/Fusion workers and the workspace-copy
// isolation that backs Fusion. Covers: runWorker now RUNS mutating tools (gated by `approve`),
// createWorkspaceCopy makes an isolated temp-dir copy (non-git) that excludes the data dir and cleans
// up, Council hands its workers the FULL toolset (read-only only in Plan mode), and Fusion falls back
// to read-only when no mkTools factory is wired.
// Usage: bun run scripts/worker-write-smoke.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "../src/multimind/runtime.ts";
import { createWorkspaceCopy } from "../src/multimind/worktree.ts";
import { runCouncil } from "../src/multimind/council.ts";
import { runFusion } from "../src/multimind/fusion.ts";
import { loadConfig } from "../src/config.ts";
import type { Tool } from "../src/agent/tools.ts";
import type { WorkerResult } from "../src/multimind/runtime.ts";

const cfg = loadConfig();
let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

// --- fake tools: a mutating write_file + a read-only read_file ---
let wrote = "";
const writeTool: Tool = {
  def: { name: "write_file", description: "", input_schema: { type: "object", properties: {} } },
  mutating: true,
  run: (i: any) => { wrote = String(i?.content ?? "ran"); return "wrote"; },
};
const readTool: Tool = {
  def: { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
  mutating: false,
  run: () => "data",
};
const fullMap = new Map<string, Tool>([["write_file", writeTool], ["read_file", readTool]]);

/** Fake model: step 1 calls write_file, step 2 ends the turn. */
function mkCall() {
  let step = 0;
  return (async (_o: any) => {
    step++;
    if (step === 1) return { content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "x.txt", content: "hi" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
    return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  }) as any;
}

// --- 1. ungated: a worker given write_file actually runs it ---
wrote = "";
const w1 = await runWorker({ label: "w", task: "t", system: "", cfg, tools: fullMap, _call: mkCall() });
check("worker runs a mutating tool when allowed", wrote === "hi" && w1.ok && w1.text === "done");

// --- 2. gated DENY: approve→false blocks the write, worker still finishes ---
wrote = "";
const w2 = await runWorker({ label: "w", task: "t", system: "", cfg, tools: fullMap, approve: async () => false, _call: mkCall() });
check("approve=false denies the mutating tool", wrote === "" && w2.ok);

// --- 3. gated ALLOW: approve→true lets it through; the desc is a readable action line ---
wrote = "";
let sawDesc = "";
const w3 = await runWorker({ label: "w", task: "t", system: "", cfg, tools: fullMap, approve: async (d) => { sawDesc = d; return true; }, _call: mkCall() });
check("approve=true allows the mutating tool", wrote === "hi" && w3.ok);
check("approve desc names the action + path", /write_file/.test(sawDesc) && /x\.txt/.test(sawDesc));

// --- 4. createWorkspaceCopy on a NON-git dir: isolated copy, excludes dataDir, cleans up ---
const base = mkdtempSync(join(tmpdir(), "ob1-copytest-"));
writeFileSync(join(base, "hello.txt"), "world");
mkdirSync(join(base, ".obdata"), { recursive: true });
writeFileSync(join(base, ".obdata", "memory.db"), "secret");
const copyCfg = { ...cfg, cwd: base, dataDir: join(base, ".obdata") } as any;
const wt = createWorkspaceCopy(copyCfg, "cand-1");
check("copy is a fresh, separate dir", wt.path !== base && existsSync(wt.path));
check("copy includes the workspace file", existsSync(join(wt.path, "hello.txt")) && readFileSync(join(wt.path, "hello.txt"), "utf8") === "world");
check("copy EXCLUDES the data dir (no recursion / db leak)", !existsSync(join(wt.path, ".obdata")));
// edits in the copy don't touch the original
writeFileSync(join(wt.path, "hello.txt"), "changed");
check("editing the copy leaves the original untouched", readFileSync(join(base, "hello.txt"), "utf8") === "world");
wt.cleanup();
check("cleanup removes the copy", !existsSync(wt.path));
rmSync(base, { recursive: true, force: true });

// --- 5. Council hands workers the FULL toolset; Plan mode is read-only ---
let councilTools: Map<string, Tool> | undefined;
const capCouncil = (cap: (m: Map<string, Tool>) => void) => (async (o: any): Promise<WorkerResult> => {
  if (o.label === "author") cap(o.tools);
  return { label: o.label, text: o.label.startsWith("reviewer:") ? "ok\nVERDICT: OK" : "x\nVERDICT: ACCEPT", inputTokens: 1, outputTokens: 1, ok: true };
}) as any;
await runCouncil({ task: "t", cfg, tools: fullMap, rounds: 1, _run: capCouncil((m) => { councilTools = m; }) });
check("council gives workers full (mutating) tools", !!councilTools?.has("write_file") && !!councilTools?.has("read_file"));
let planTools: Map<string, Tool> | undefined;
await runCouncil({ task: "t", cfg, tools: fullMap, rounds: 1, planMode: true, _run: capCouncil((m) => { planTools = m; }) });
check("council Plan mode → read-only (no mutating tools)", !planTools?.has("write_file") && !!planTools?.has("read_file"));

// --- 6. Fusion without mkTools → candidates stay read-only (back-compat) ---
let candTools: Map<string, Tool> | undefined;
await runFusion({
  task: "t", cfg, tools: fullMap, n: 1,
  _run: (async (o: any): Promise<WorkerResult> => {
    if (o.label === "cand-1") candTools = o.tools;
    return { label: o.label, text: "```ts\nconst x = 1;\n```", inputTokens: 1, outputTokens: 1, ok: true };
  }) as any,
});
check("fusion without mkTools → candidate read-only", !candTools?.has("write_file") && !!candTools?.has("read_file"));

if (fail) { console.error("\n✗ worker-write smoke FAILED"); process.exit(1); }
console.log("\n✓ worker-write smoke passed (gated mutating workers + workspace-copy isolation + council full-tools / plan read-only + fusion read-only fallback)");
