// Deterministic test for architect/editor two-model edits (PLAN-V2 #10). No API key — models injected.
// Covers the prompt contracts, search/replace + whole-file parsing, the two-model pipeline, applying the
// editor's blocks through the real flexible edit engine, and conditional tool registration (OB1_EDIT_ARCHITECT).
// Usage: bun run scripts/architect-smoke.ts
import { architectPrompt, editorPrompt, parseSearchReplace, parseWholeFile, runArchitectEdit } from "../src/agent/architect.ts";
import { applyFlexibleEdit, buildTools } from "../src/agent/tools.ts";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

const FILE = "src/calc.ts";
const SRC = "export function add(a, b) {\n  return a + b;\n}\n";

// ── prompts: architect = prose-only; editor = mechanical ──
check("architect prompt forbids diff syntax + includes the file", (() => { const p = architectPrompt(FILE, SRC, "make it subtract"); return /PROSE/.test(p) && /NO diff/i.test(p) && p.includes(SRC) && p.includes("make it subtract"); })());
check("editor prompt demands SEARCH/REPLACE only + the full file", (() => { const p = editorPrompt(FILE, SRC, "the plan"); return p.includes("SEARCH") && p.includes("REPLACE") && /ONLY/.test(p) && p.includes(SRC) && p.includes("the plan"); })());

// ── parsing ──
{
  const blocks = parseSearchReplace("<<<<<<< SEARCH\nreturn a + b;\n=======\nreturn a - b;\n>>>>>>> REPLACE");
  check("parses a single search/replace block", blocks.length === 1 && blocks[0].search === "return a + b;" && blocks[0].replace === "return a - b;");
}
check("parses multiple blocks", parseSearchReplace("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE").length === 2);
check("no blocks ⇒ empty", parseSearchReplace("just prose, no edits").length === 0);
check("whole-file fallback reads a fenced block", parseWholeFile("```ts\nexport const x = 1;\n```") === "export const x = 1;");
check("whole-file fallback is null without a fence", parseWholeFile("no code here") === null);

// ── pipeline: architect plan → editor diff → applied via the real flexible engine ──
{
  let archSawFile = false, edSawPlan = false;
  const r = await runArchitectEdit({
    file: FILE, content: SRC, instruction: "make add subtract",
    architect: async (p) => { archSawFile = p.includes(SRC); return "Change the body of add to return a - b instead of a + b."; },
    editor: async (p) => { edSawPlan = p.includes("a - b"); return "<<<<<<< SEARCH\n  return a + b;\n=======\n  return a - b;\n>>>>>>> REPLACE"; },
  });
  check("architect received the file content", archSawFile);
  check("editor received the architect's plan", edSawPlan);
  check("pipeline returns diff-mode blocks", r.mode === "diff" && r.blocks.length === 1);
  // apply through the REAL edit engine
  const out = applyFlexibleEdit(SRC, r.blocks[0].search, r.blocks[0].replace, false).content;
  check("applying the editor's block transforms the file", out.includes("return a - b;") && !out.includes("a + b"));
}

// ── whole-file mode ──
{
  const r = await runArchitectEdit({
    file: FILE, content: SRC, instruction: "rewrite",
    architect: async () => "rewrite the whole file",
    editor: async () => "```ts\nexport function add(a, b) { return a - b; }\n```",
  });
  check("pipeline falls back to whole-file mode", r.mode === "whole" && r.whole?.includes("a - b") === true);
}

// ── editor produced nothing appliable → throws (surfaced as a tool error upstream) ──
{
  let threw = false;
  try { await runArchitectEdit({ file: FILE, content: SRC, instruction: "x", architect: async () => "plan", editor: async () => "sorry, I can't." }); }
  catch { threw = true; }
  check("no applicable edits → throws", threw);
}

// ── conditional tool registration ──
{
  const cfg = { cwd: process.cwd() } as any, store = {} as any;
  delete process.env.OB1_EDIT_ARCHITECT;
  check("architect_edit NOT registered by default", !buildTools(cfg, store).has("architect_edit"));
  process.env.OB1_EDIT_ARCHITECT = "1";
  const tool = buildTools(cfg, store).get("architect_edit");
  check("architect_edit registered when OB1_EDIT_ARCHITECT=1", !!tool && tool.mutating === true);
  delete process.env.OB1_EDIT_ARCHITECT;
}

console.log(fail ? "\nFAIL" : "\nPASS");
process.exit(fail ? 1 : 0);
