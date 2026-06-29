// @path mentions — when a prompt contains `@src/foo.ts` (or `@dir/`), pull that file/dir into the turn so
// the model sees its contents without having to call read_file first. The visible @token is kept; the
// content is appended as a fenced block. Mirrors the @-mention UX of other coding CLIs.
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export interface MentionResult { text: string; attached: string[]; missing: string[] }

const MAX_FILE_CHARS = 60_000;   // per file, so one @big-file can't blow the window
const MAX_TOTAL_CHARS = 150_000; // across all mentions in one prompt

/** Find @path tokens. A path token is @ followed by non-space chars; we trim trailing punctuation that's
 *  likely sentence punctuation, not part of the path. Avoids matching emails (preceded by a word char). */
function findMentions(prompt: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s(])@([^\s)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const raw = m[2].replace(/[.,;:!?]+$/, ""); // strip trailing sentence punctuation
    if (raw) out.push(raw);
  }
  return [...new Set(out)];
}

/** Expand @path mentions in `prompt` against `cwd`. Returns the augmented prompt plus what was attached /
 *  not found. Unresolvable mentions are left in the text untouched (they may just be an @handle). */
export function expandMentions(prompt: string, cwd: string): MentionResult {
  const mentions = findMentions(prompt);
  if (!mentions.length) return { text: prompt, attached: [], missing: [] };

  const attached: string[] = [];
  const missing: string[] = [];
  const blocks: string[] = [];
  let total = 0;

  for (const ref of mentions) {
    const abs = isAbsolute(ref) ? ref : join(cwd, ref);
    if (!existsSync(abs)) { missing.push(ref); continue; }
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        const entries = readdirSync(abs).slice(0, 200);
        blocks.push(`### @${ref} (directory)\n${entries.join("\n")}`);
        attached.push(ref);
        continue;
      }
      if (total >= MAX_TOTAL_CHARS) { missing.push(ref); continue; }
      let body = readFileSync(abs, "utf8");
      let truncated = "";
      if (body.length > MAX_FILE_CHARS) { body = body.slice(0, MAX_FILE_CHARS); truncated = `\n… [truncated at ${MAX_FILE_CHARS} chars]`; }
      total += body.length;
      blocks.push(`### @${ref}\n\`\`\`\n${body}${truncated}\n\`\`\``);
      attached.push(ref);
    } catch { missing.push(ref); }
  }

  if (!blocks.length) return { text: prompt, attached, missing };
  const text = `${prompt}\n\n--- Attached via @mention ---\n${blocks.join("\n\n")}`;
  return { text, attached, missing };
}
