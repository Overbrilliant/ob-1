// Deterministic test for write-capable worktree subagents (PLAN-V2 #2). No API key — workers injected.
// Real git: spins up a temp repo, runs the write path with fake workers that edit files inside their
// worktrees, and asserts the safety model end-to-end: pre-spawn partition refusal, isolated-worktree
// merge of DISJOINT changes, post-work overlap detection (abort + working tree untouched), the gated
// apply, and the not-a-repo guard. Usage: bun run scripts/subagents-write-smoke.ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partitionConflicts, overlappingChanges, runWriteSubagents, applyMerge, type WriteAssignment } from "../src/multimind/subagents-write.ts";
import { runTurn, type TurnDeps } from "../src/agent/loop.ts";
import type { WorkerResult, runWorker } from "../src/multimind/runtime.ts";
import type { ModelResponse } from "../src/providers/types.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });

function freshRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "ob1-cowrite-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}
const cfgFor = (repo: string) => ({ cwd: repo, dataDir: join(repo, ".ob1") } as any);

// a fake write-worker: writes a pre-scripted {file→content} into its OWN worktree (o.cfg.cwd)
const writerRun = (script: Record<string, { file: string; content: string }>): typeof runWorker =>
  (async (o: any): Promise<WorkerResult> => {
    const w = script[o.label];
    if (w) writeFileSync(join(o.cfg.cwd, w.file), w.content);
    return { label: o.label, text: `wrote ${w?.file ?? "nothing"}`, inputTokens: 5, outputTokens: 2, ok: true };
  }) as any;

// ── pure conflict detection ──
const A: WriteAssignment = { label: "A", task: "x", files: ["a.ts", "shared.ts"] };
const B: WriteAssignment = { label: "B", task: "y", files: ["b.ts", "shared.ts"] };
check("partitionConflicts flags a file declared by two agents", partitionConflicts([A, B]).some((c) => c.file === "shared.ts" && c.labels.length === 2));
check("partitionConflicts is empty for a clean partition", partitionConflicts([{ label: "A", task: "", files: ["a.ts"] }, { label: "B", task: "", files: ["b.ts"] }]).length === 0);
check("overlappingChanges flags actual same-file edits", overlappingChanges(new Map([["A", ["x.ts"]], ["B", ["x.ts"]]])).length === 1);
check("overlappingChanges is empty for disjoint edits", overlappingChanges(new Map([["A", ["x.ts"]], ["B", ["y.ts"]]])).length === 0);

// ── pre-spawn refusal: declared overlap never spawns ──
{
  let ran = false;
  const r = await runWriteSubagents({ assignments: [{ label: "A", task: "", files: ["x.ts"] }, { label: "B", task: "", files: ["x.ts"] }], cfg: cfgFor(freshRepo()), tools: new Map(), _run: (async () => { ran = true; return {}; }) as any });
  check("declared-overlap is refused BEFORE spawning", !r.ok && !ran && r.reason?.includes("overlap") === true);
}

// ── not a git repo ──
{
  const dir = mkdtempSync(join(tmpdir(), "ob1-nogit-"));
  const r = await runWriteSubagents({ assignments: [{ label: "A", task: "", files: ["a.ts"] }], cfg: cfgFor(dir), tools: new Map(), _run: writerRun({}) });
  check("non-git dir is refused (worktree isolation needs git)", !r.ok && r.reason?.includes("git repository") === true);
}

// ── happy path: disjoint writes merge cleanly, then a gated apply lands them ──
{
  const repo = freshRepo();
  const r = await runWriteSubagents({
    assignments: [{ label: "A", task: "add a", files: ["a.txt"] }, { label: "B", task: "add b", files: ["b.txt"] }],
    cfg: cfgFor(repo), tools: new Map(),
    _run: writerRun({ A: { file: "a.txt", content: "AAA\n" }, B: { file: "b.txt", content: "BBB\n" } }),
  });
  check("disjoint write batch succeeds with no conflicts", r.ok && r.conflicts.length === 0);
  check("merge gathers both agents' changed files", r.changes.length === 2 && r.changes.some((c) => c.file === "a.txt" && c.content === "AAA\n") && r.changes.some((c) => c.file === "b.txt"));
  check("real working tree is untouched until apply", !existsSync(join(repo, "a.txt")) && !existsSync(join(repo, "b.txt")));
  const written = await applyMerge(repo, r.changes);
  check("gated apply writes both files to the real tree", written.length === 2 && readFileSync(join(repo, "a.txt"), "utf8") === "AAA\n" && existsSync(join(repo, "b.txt")));
}

// ── apply gate: a denying approver writes nothing ──
{
  const repo = freshRepo();
  const wrote = await applyMerge(repo, [{ file: "z.txt", content: "z" }], async () => false);
  check("apply is gated — a denied approval writes nothing", wrote.length === 0 && !existsSync(join(repo, "z.txt")));
}

// ── conflict: agents write the SAME file out of lane → abort, working tree untouched ──
{
  const repo = freshRepo();
  const r = await runWriteSubagents({
    assignments: [{ label: "A", task: "", files: ["a.txt"] }, { label: "B", task: "", files: ["b.txt"] }],
    cfg: cfgFor(repo), tools: new Map(),
    _run: writerRun({ A: { file: "clash.txt", content: "fromA" }, B: { file: "clash.txt", content: "fromB" } }), // both write clash.txt
  });
  check("actual overlap is detected post-work", !r.ok && r.conflicts.some((c) => c.file === "clash.txt"));
  check("no changes are proposed on conflict", r.changes.length === 0);
  check("the real working tree is left untouched on conflict", !existsSync(join(repo, "clash.txt")));
}

// ── runTurn integration: the model calls spawn_write_subagents → loop runs the write path → gated apply ──
{
  const repo = freshRepo();
  const store = { searchSemantic: async () => [], listFacts: () => [], listRelationships: () => [] } as any;
  const cfg = { ...cfgFor(repo), apiKey: "k", provider: "openai", model: "m", baseUrl: "x" } as any;
  const writer = writerRun({ "writer-1": { file: "x.txt", content: "X\n" }, "writer-2": { file: "y.txt", content: "Y\n" } });
  const spawnResp: ModelResponse = {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "spawn_write_subagents", input: { subtasks: [{ task: "write x", files: ["x.txt"] }, { task: "write y", files: ["y.txt"] }] } }],
    usage: { input_tokens: 1, output_tokens: 1 } as any,
  };
  const endResp: ModelResponse = { stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } as any };
  const base: TurnDeps = { cfg, tools: new Map(), store, approve: async () => true, log: () => {} };

  // ON: tool runs, files land via the gated apply
  {
    let n = 0; const calls = [spawnResp, endResp];
    await runTurn("split the edits", [], { ...base, canSpawnWrite: true, _runWorker: writer, _callModel: async () => calls[n++] });
    check("runTurn integration: write-subagents applied disjoint edits to the real tree", existsSync(join(repo, "x.txt")) && existsSync(join(repo, "y.txt")));
  }
  // OFF: the tool is inert (unknown tool, no write)
  {
    const repo2 = freshRepo();
    const cfg2 = { ...cfgFor(repo2), apiKey: "k", provider: "openai", model: "m", baseUrl: "x" } as any;
    let n = 0; const calls = [spawnResp, endResp];
    const tr = await runTurn("split", [], { ...base, cfg: cfg2, canSpawnWrite: false, _runWorker: writer, _callModel: async () => calls[n++] });
    check("gated off: spawn_write_subagents is inert (no write)", !existsSync(join(repo2, "x.txt")) && tr != null);
  }
}

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
