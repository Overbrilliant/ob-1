// Architect/Editor two-model edits — PLAN-V2 item #10. OPT-IN (OB1_EDIT_ARCHITECT).
//
// Aider's division of labor: a strong "architect" model describes the change in PROSE (frontier models
// reason well but mangle structured diffs), then a cheaper "editor" model translates that plan + the
// current file into machine-appliable search/replace blocks (cheaper models apply diffs precisely). The
// blocks go through OB-1's existing flexible edit-apply engine. Reported ~85% on Aider's edit benchmark
// with a strong+cheap pairing — but an unproven ⚠️ claim for our setup, so it's opt-in and ~2× the model
// calls (surface that). This module is the PURE core (prompts + parsing); the tool applies the result so
// there's no import cycle with the edit engine.
// Source: aider.chat/2024/09/26/architect.html + edit-formats docs.

export interface SearchReplace { search: string; replace: string }
export interface ArchitectResult {
  plan: string;                 // the architect's prose
  mode: "diff" | "whole";
  blocks: SearchReplace[];      // when mode === "diff"
  whole?: string;               // when mode === "whole" (full new file content)
}

export type EditModel = (prompt: string) => Promise<string>;

export function architectPrompt(file: string, content: string, instruction: string): string {
  return [
    `You are the ARCHITECT. Describe — in plain PROSE, with NO diff/search-replace/code-edit syntax — exactly how to change \`${file}\` to accomplish this task:`,
    `\n${instruction}\n`,
    "Name the specific functions/locations to change and what the new behavior should be, so an editor can implement it precisely. Do NOT write the final edit; just explain the change clearly.",
    `\nCurrent \`${file}\`:\n\`\`\`\n${content}\n\`\`\``,
  ].join("\n");
}

export function editorPrompt(file: string, content: string, plan: string): string {
  return [
    `You are the EDITOR. Apply the planned change to \`${file}\`, emitting ONLY search/replace edit blocks — no commentary, no prose.`,
    "Format EACH edit EXACTLY as:",
    "<<<<<<< SEARCH",
    "<exact lines from the current file>",
    "=======",
    "<replacement lines>",
    ">>>>>>> REPLACE",
    "The SEARCH text must match the current file. Use multiple blocks for multiple edits. If the change is sweeping, instead output the ENTIRE new file as a single fenced ``` code block.",
    `\nPlanned change:\n${plan}`,
    `\nCurrent \`${file}\`:\n\`\`\`\n${content}\n\`\`\``,
  ].join("\n");
}

/** Parse the editor's `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks (the appliable contract). */
export function parseSearchReplace(out: string): SearchReplace[] {
  const re = /<{5,}\s*SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n?={5,}[ \t]*\r?\n([\s\S]*?)\r?\n?>{5,}\s*REPLACE/g;
  const blocks: SearchReplace[] = [];
  for (const m of out.matchAll(re)) blocks.push({ search: m[1], replace: m[2] });
  return blocks;
}

/** Whole-file fallback: the first fenced code block's contents (used when the editor rewrites the file). */
export function parseWholeFile(out: string): string | null {
  const m = out.match(/```[a-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/i);
  return m ? m[1].replace(/\s+$/, "") : null;
}

/** Run the two-model pipeline and return the parsed (not yet applied) edits. The caller applies the
 *  search/replace blocks through the flexible edit engine, or writes `whole`. Throws if the editor
 *  produced nothing appliable. Models injected for testing. */
export async function runArchitectEdit(opts: {
  file: string;
  content: string;
  instruction: string;
  architect: EditModel;
  editor: EditModel;
}): Promise<ArchitectResult> {
  const plan = (await opts.architect(architectPrompt(opts.file, opts.content, opts.instruction))).trim();
  const editorOut = await opts.editor(editorPrompt(opts.file, opts.content, plan));
  const blocks = parseSearchReplace(editorOut);
  if (blocks.length) return { plan, mode: "diff", blocks };
  const whole = parseWholeFile(editorOut);
  if (whole != null && whole.trim()) return { plan, mode: "whole", blocks: [], whole };
  throw new Error("editor produced no applicable edits (no SEARCH/REPLACE blocks or whole-file block)");
}
