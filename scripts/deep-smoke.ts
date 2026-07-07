// Deterministic full-loop narrative smoke for deep.ts (AB-MCTS-lite) — no API key, no network, no models,
// no subprocesses beyond a trivial $OB1_FILE `grep` check. A fake `_run` scripts the workers and a CONSTANT
// `_rng` (() => 0.5) makes Thompson selection fully deterministic, so the whole widen-then-deepen narrative
// is reproducible: two fresh GENERATIONS fail the check, then a REFINE of the first failing node fixes it,
// the node passes 1.0, and the search STOPS EARLY. Prints the search tree exactly as the CLI renders it.
// Usage: bun run scripts/deep-smoke.ts
import { runDeep, deepNodeLine, sampleBeta, armPosterior, selectArm, type Arm } from "../src/multimind/deep.ts";
import { loadConfig } from "../src/config.ts";
import type { WorkerResult } from "../src/multimind/runtime.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

// Non-free provider ⇒ ensembleModels(cfg) is deterministically [cfg.model] (the free router would read live
// registry/health state — non-deterministic in a smoke).
const cfg = { ...loadConfig(), provider: "openai", apiKey: "k", model: "M", cwd: process.cwd() } as any;
const HALF = () => 0.5;
const block = (code: string) => "```ts\n" + code + "\n```";
const W = (label: string, text: string): WorkerResult => ({ label, text, inputTokens: 5, outputTokens: 7, ok: true });

// ── pure-core sanity (the pieces the loop is built on) ──
check("sampleBeta bounded in [0,1]", (() => { const s = sampleBeta(3, 4, HALF); return s >= 0 && s <= 1; })());
check("armPosterior — empty history → uniform (1,1)", (() => { const p = armPosterior({ kind: "gen", model: "M" }, []); return p.alpha === 1 && p.beta === 1; })());
check("selectArm — first GEN arm chosen on a cold start (only arm available)", selectArm([{ kind: "gen", model: "M" } as Arm], [], HALF) === 0);

// ── full loop: widen (fail, fail) → deepen (fix) → early stop ──
// The check passes only when the candidate contains the token FIXED. GENs emit code WITHOUT it (fail, reward
// 0); a REFINE emits code WITH it (pass, reward 1). Under HALF rng + all-fail history, the deterministic arm
// schedule is GEN, GEN, REFINE(node#1) — so call #3 is the fix.
const seen: { label: string; task: string; model: string }[] = [];
const r = await runDeep({
  task: "make the widget total add up", cfg, tools: new Map(), budget: 9, check: 'grep -q FIXED "$OB1_FILE"', _rng: HALF,
  _run: (async (o: { label: string; task: string; model: string }) => {
    seen.push({ label: o.label, task: o.task, model: o.model });
    const code = o.label.startsWith("refine") ? "export const total = sum(items); // FIXED" : "export const total = 0; // draft";
    return W(o.label, block(code));
  }) as any,
});

console.log("\n  narrative — the search tree (widen-vs-deepen · real verifier reward):");
for (const n of r.nodes) {
  const v = n.ok ? "PASS" : n.score > 0 ? `${Math.round(n.score * 100)}%` : "fail";
  const isBest = r.best && n.id === r.best.id ? " ◀ best" : "";
  console.log(`    ${deepNodeLine(n)}  ${v}${isBest}`);
}
console.log(`  [${r.nodes.length} node(s) · signal=${r.signalTier} · ~${r.totalInputTokens} in / ${r.totalOutputTokens} out tok]\n`);

check("D: two widening GENs ran first (from-scratch drafts)", seen.slice(0, 2).every((s) => s.label.startsWith("gen")));
check("D: the third call DEEPENED — a REFINE of the first failing node", seen[2]?.label.startsWith("refine") === true && r.nodes[2]?.parent === 1);
check("D: the refine prompt carried the parent draft + the improve instruction", /Improve this candidate/.test(seen[2].task) && seen[2].task.includes("draft"));
check("D: the refine fixed it — best node PASSES (ok, score 1)", r.best?.ok === true && r.best?.score === 1);
check("D: best is the refine node (deepened, not a fresh draft)", r.best?.parent === 1);
check("D: STOPPED EARLY on the full pass (3 of a 9 budget spent)", r.nodes.length === 3);
check("D: signal tier reported as the check command", r.signalTier === "check");
check("D: tree summary has one printable line per node", r.tree.length === r.nodes.length && r.tree[2].includes("refine"));
check("D: tokens rolled up from every worker call", r.totalInputTokens === 15 && r.totalOutputTokens === 21);

// ── ESC returns a clean partial (honored between calls) ──
{
  const ctrl = new AbortController();
  let calls = 0;
  const p = await runDeep({
    task: "t", cfg, tools: new Map(), budget: 9, check: "exit 1", _rng: HALF, signal: ctrl.signal,
    _run: (async (o: { label: string }) => { if (++calls === 2) ctrl.abort(); return W(o.label, block("export const x = 1;")); }) as any,
  });
  check("D: ESC mid-run → partial tree returned cleanly (2 nodes, best defined)", p.nodes.length === 2 && p.best !== undefined);
}

console.log("");
if (fail) { console.error("✗ deep smoke FAILED"); process.exit(1); }
console.log("✓ deep smoke passed (AB-MCTS-lite: widen → deepen → verified fix → early stop · ESC partial)");
