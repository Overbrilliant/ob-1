// Tool/action system (Phase 0). Read-only tools auto-run; mutating tools pass through
// the approval gate and are blocked in Plan mode (R6). File edits use a search/replace
// "diff" format — token-efficient and the proven pattern (R4).
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToolDef, ImageSource, ContentBlock } from "../providers/types.ts";
import { visionEnabled } from "../providers/models.ts";
import type { Config } from "../config.ts";
import type { MemoryStore } from "../memory/store.ts";
import { buildRepoMap, renderRepoMap } from "../context/repomap.ts";
import { listTopics, readTopic } from "../context/topics.ts";
import { wrapCommand } from "../safety/sandbox.ts";
import { classifyIntent, validateBashCommand } from "../safety/bash-validation.ts";
import { runVerification, shellExec, parseScope } from "./verify.ts";
import { isGreenLevel, levelKinds, evaluateContract } from "./green-contract.ts";
import { getDiagnostics, formatDiagnostics } from "../context/lsp.ts";
import { readSkill, listSkills, writeSkill, patchSkill, deleteSkill, findSkill } from "../skills/registry.ts";
import { recordSkillUse } from "../skills/usage.ts";
import { webSearch, webFetch } from "../tools/web.ts";
import { runArchitectEdit } from "./architect.ts";
import { callModel } from "../providers/gateway.ts";
import { makeProcKiller, type ProcRegistry } from "./procs.ts";
import { runBrowserCheck, formatBrowserCheck, defaultScreenshotPath } from "./browser.ts";
import { classifySql, sqlMutates, runSqlite, formatSqlResult } from "./sql.ts";
import { SecretStore } from "./secrets.ts";
import { createPr, prChecks } from "./pr.ts";
import { exposePort } from "./expose.ts";

/** A one-shot model call returning plain text — the architect/editor pipeline's model seam (item #10). */
async function askEditModel(cfg: Config, model: string, prompt: string): Promise<string> {
  const r = await callModel({ provider: cfg.provider, apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, model, system: "", messages: [{ role: "user", content: prompt }] });
  return r.content.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim();
}
import type { TodoRegistry, TodoItem, TodoStatus } from "./todo-registry.ts";

/** A rich tool result: human/model-readable `text` plus optional `images` a vision model can SEE.
 *  Only browser_check uses images today; every other tool returns a plain string. */
export interface ToolResult { text: string; images?: ImageSource[] }
/** What a tool's run() may return: a plain string (the common case) or a {text, images} result. */
export type ToolOutput = string | ToolResult;

/** Per-call context handed to a tool's run(). Carries the turn's AbortSignal so a long-running tool
 *  (a foreground bash, a browser_check, a web fetch) can stop the instant the user hits ESC — instead of
 *  blocking the turn until it finishes and only THEN noticing the abort between loop steps. */
export interface ToolRunCtx { signal?: AbortSignal }

export interface Tool {
  def: ToolDef;
  mutating: boolean;     // requires approval + blocked in Plan mode
  destructive?: boolean; // tagged [destructive] in the approval prompt (in "ask" mode)
  run(input: any, ctx?: ToolRunCtx): Promise<ToolOutput> | ToolOutput;
}

/** Some tools are statically mutating but input-sensitive at call time. Treat pure reads as read-only so
 *  they stay available in Plan mode / read-only workers without weakening the gate for writes. */
export function isReadOnlyToolCall(name: string, input: any): boolean {
  if (name === "run_bash") return classifyIntent(String(input?.command ?? "")) === "read-only";
  if (name === "execute_sql" && typeof input?.sql === "string") {
    const kind = classifySql(input.sql);
    return kind === "read" || kind === "empty";
  }
  return false;
}

export function toolCallMutates(tool: Tool, name: string, input: any): boolean {
  return tool.mutating && !isReadOnlyToolCall(name, input);
}

/** Does this call plausibly change workspace files/code and therefore require post-change verification?
 *  This is narrower than "mutating": process controls, public previews, secrets, memory, SQL, and PR
 *  actions mutate external/session state but should not reset a passed browser/test verification. */
export function toolCallChangesWorkspace(name: string, input: any): boolean {
  if (name === "write_file" || name === "edit_file" || name === "architect_edit") return true;
  if (name !== "run_bash") return false;
  if (input?.background) return false; // servers/watchers mutate process state, not files
  const intent = classifyIntent(String(input?.command ?? ""));
  return intent === "write" || intent === "destructive" || intent === "unknown";
}

/** A read-only view of a tool for autonomous investigators. Input-sensitive readers like execute_sql
 *  are wrapped so SELECT works while INSERT/DDL/destructive SQL is refused at execution time. */
export function readOnlyToolView(tool: Tool): Tool | null {
  if (!tool.mutating) return tool;
  if (tool.def.name !== "execute_sql") return null;
  return {
    ...tool,
    mutating: false,
    run: (input, ctx) => {
      if (toolCallMutates(tool, tool.def.name, input)) {
        throw new Error("execute_sql is read-only in this context; use SELECT/PRAGMA/EXPLAIN only.");
      }
      return tool.run(input, ctx);
    },
  };
}

/** Normalize any tool return value to {text, images}. A string (or anything unexpected) → text-only, so
 *  callers that only want text (hooks, the read-only multimind runtime) never see "[object Object]". */
export function normalizeToolOutput(raw: ToolOutput): { text: string; images?: ImageSource[] } {
  if (typeof raw === "string") return { text: raw };
  if (raw && typeof raw === "object" && typeof (raw as ToolResult).text === "string") {
    const images = (raw as ToolResult).images;
    return { text: (raw as ToolResult).text, images: images?.length ? images : undefined };
  }
  return { text: String(raw) };
}

/** browser_check screenshot policy. "auto" (default) attaches the visible screenshot ONLY when the
 *  check fails — the model doesn't need to burn vision tokens looking at a page that already passed, but
 *  needs to SEE what went wrong when it didn't. "always" attaches every time (vision permitting); "off"
 *  never captures/attaches and writes no file. The cheap accessibility-tree snapshot is sent every call
 *  regardless of this mode. */
export type ScreenshotMode = "auto" | "always" | "off";

/** Parse the tool's `screenshot` arg into a mode, tolerating the legacy boolean (true→always, false→off)
 *  and common synonyms. Anything unrecognized (incl. undefined) → "auto" — the cost-aware default. */
export function screenshotMode(v: unknown): ScreenshotMode {
  if (v === false || v === "off" || v === "none" || v === "never" || v === "no") return "off";
  if (v === true || v === "always" || v === "on" || v === "yes") return "always";
  return "auto";
}

/** Whether to ATTACH the screenshot to the model this call: never without a vision model or when off;
 *  "always" → yes; "auto" → only when the check failed. Pure + exported for testing. */
export function shouldAttachScreenshot(mode: ScreenshotMode, vision: boolean, ok: boolean): boolean {
  if (!vision || mode === "off") return false;
  return mode === "always" || (mode === "auto" && !ok);
}

/** Assemble a tool_result's `content`: a content-block array when images are present (so a vision model
 *  can SEE them), else the plain text string — keeping the overwhelmingly-common text-only case lean on
 *  the wire. A text-only image set still emits the text block first so the model has context. */
export function toolResultContent(text: string, images?: ImageSource[]): string | ContentBlock[] {
  if (!images?.length) return text;
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const source of images) blocks.push({ type: "image", source });
  return blocks;
}

// ── Clarification (ask_user) ──────────────────────────────────────────────────
// A structured GROUP of questions the agent puts to the user. Each question has a prompt, a few
// options (rendered as radio buttons or, when multiSelect, checkboxes), plus an always-present
// free-text escape hatch. The agent usually asks one, but may batch a few independent decisions.
// The UI (TUI picker / REPL prompt) implements AskUserFn — presenting the questions in turn — and the
// tool shuttles the request and returns the combined answer. Mirrors Claude Code's AskUserQuestion.
export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; header?: string; options: AskOption[]; multiSelect: boolean }
export interface AskUserRequest { questions: AskQuestion[] }
export type AskUserFn = (req: AskUserRequest) => Promise<string>;

/** Is `abs` inside the workspace AFTER resolving symlinks? A lexical check alone is escapable: an
 *  in-workspace symlink that points outside passes the `relative()` test but `readFileSync`/`writeFileSync`
 *  follow it out. We resolve the deepest EXISTING prefix of `abs` to its real location (the target itself
 *  may not exist yet — e.g. a write_file destination) and re-check containment against the real workspace
 *  root. The root is realpath'd too, so a workspace that itself lives under a symlinked path (e.g. macOS
 *  /tmp → /private/tmp) doesn't produce false positives. */
function insideWorkspaceReal(cwdRoot: string, abs: string): boolean {
  let realRoot: string;
  try { realRoot = realpathSync(cwdRoot); } catch { realRoot = cwdRoot; }
  let real: string;
  try {
    real = realpathSync(abs); // exists → fully symlink-resolved
  } catch {
    // Doesn't exist yet: resolve the nearest existing ancestor, then re-attach the not-yet-created tail.
    const tail: string[] = [];
    let dir = abs;
    for (;;) {
      const parent = dirname(dir);
      if (parent === dir) { real = resolve(dir, ...tail); break; } // reached filesystem root
      tail.unshift(basename(dir));
      try { real = resolve(realpathSync(parent), ...tail); break; } catch { dir = parent; }
    }
  }
  const rel = relative(realRoot, real);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** Keep file access inside the workspace (a basic guardrail; OS sandbox is a later phase, R7). */
function safePath(cfg: Config, p: string): string {
  // A tool call can arrive with the path missing or non-string (the model omitted it or used the wrong
  // key). Fail with an actionable message instead of crashing on p.startsWith below — an opaque TypeError
  // ("undefined is not an object") tells the model nothing and burns its whole step budget guessing.
  if (typeof p !== "string" || p.trim() === "") {
    throw new Error(`missing or invalid "path" argument (got ${JSON.stringify(p)}). Pass a non-empty file path relative to the workspace root ${cfg.cwd}, e.g. "src/agent/loop.ts".`);
  }
  // Expand a leading ~ (the model often writes a home-relative path). With the workspace under the home
  // dir, ~/…/<workspace>/src/x.ts then correctly lands INSIDE the workspace instead of resolving to a
  // bogus "<cwd>/~/…" that ENOENTs and sends the model guessing at path forms for its whole step budget.
  const expanded = p === "~" ? homedir() : p.startsWith("~/") || p.startsWith("~" + sep) ? resolve(homedir(), p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? expanded : resolve(cfg.cwd, expanded);
  const rel = relative(cfg.cwd, abs);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    // Actionable error (names the root + the right form) so the model self-corrects in ONE step rather
    // than flailing through ~/…, /…, doubled-relative variants until its budget is gone.
    throw new Error(`path is outside the workspace: "${p}". The workspace root is ${cfg.cwd} — pass a path relative to it (e.g. "src/agent/loop.ts"), not an absolute or home-relative path.`);
  }
  // The lexical check above is escapable via an in-workspace symlink that points OUT. Resolve symlinks and
  // re-verify so a read/write can't follow one outside the workspace.
  if (!insideWorkspaceReal(cfg.cwd, abs)) {
    throw new Error(`path resolves outside the workspace via a symlink: "${p}". The workspace root is ${cfg.cwd}; OB-1 won't follow a link out of it.`);
  }
  return abs;
}

function browserCheckUrl(cfg: Config, raw: string): string {
  const s = String(raw ?? "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  let abs: string;
  if (/^file:\/\//i.test(s)) {
    try { abs = safePath(cfg, fileURLToPath(s)); }
    catch (e) { throw new Error(`browser_check file URL must point inside the workspace: ${(e as Error).message}`); }
  } else {
    abs = safePath(cfg, s);
  }
  if (!existsSync(abs)) throw new Error(`browser_check file does not exist: ${s}`);
  return pathToFileURL(abs).href;
}

export interface EditResult { content: string; replacements: number; mode: "exact" | "flexible" }

/** Apply a search/replace edit with progressive relaxation (the spec's "lenient apply + auto-retry"):
 *  Level 0 = exact match; Level 1 = whitespace/indentation-flexible match (the common LLM apply
 *  failure — indentation drift and trailing whitespace). Throws an actionable error if nothing
 *  matches or a non-replace_all match is ambiguous. Pure + exported for testing. */
export function applyFlexibleEdit(src: string, old_string: string, new_string: string, replace_all = false): EditResult {
  // Level 0 — exact.
  const exact = src.split(old_string).length - 1;
  if (exact >= 1) {
    if (exact > 1 && !replace_all) throw new Error(`old_string is not unique (${exact} matches); pass replace_all or add surrounding context`);
    const content = replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string);
    return { content, replacements: replace_all ? exact : 1, mode: "exact" };
  }
  // Level 1 — whitespace/indentation-flexible: ignore leading indent + trailing ws, collapse intra-line runs.
  const pattern = old_string
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      const esc = line.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ \t]+/g, "[ \\t]+");
      return "[ \\t]*" + esc + "[ \\t]*";
    })
    .join("\\n");
  const re = new RegExp(pattern, "g");
  const matches = [...src.matchAll(re)];
  if (matches.length === 0) throw new Error("old_string not found (tried exact + whitespace-flexible match). Re-read the narrow line range you need, copy the exact current text, then retry edit_file. Do NOT rewrite the whole file unless the user asked for a full rewrite.");
  if (matches.length > 1 && !replace_all) throw new Error(`old_string is ambiguous (${matches.length} flexible matches); pass replace_all or add surrounding context`);
  if (replace_all) return { content: src.replace(re, () => new_string), replacements: matches.length, mode: "flexible" };
  const m = matches[0];
  return { content: src.slice(0, m.index!) + new_string + src.slice(m.index! + m[0].length), replacements: 1, mode: "flexible" };
}

// ── Token optimization ────────────────────────────────────────────────────────
/** Clamp long tool output to `max` chars while preserving BOTH ends. Test/build/lint failures
 *  land at the TAIL, so a head-only slice (the old behavior) often dropped exactly the error summary
 *  the model needed to fix the problem. Keeps a head (the command/setup context) + a larger tail
 *  (where the verdict lives) with an elision marker in between — token-neutral, strictly better
 *  signal. Pure + exported for testing. */
export function clampOutput(s: string, max = 20_000): string {
  if (s.length <= max) return s;
  const elided = s.length - max;
  const marker = `\n…[${elided} chars elided to fit the output budget]…\n`;
  const keep = Math.max(0, max - marker.length);
  const head = Math.floor(keep * 0.3); // 30% head / 70% tail — errors & summaries land at the end
  const tail = keep - head;
  return s.slice(0, head) + marker + s.slice(s.length - tail);
}

/** Per-turn read-dedup cache (token optimization). On a re-read of a file whose content is byte-
 *  identical to a copy already returned THIS turn, read_file returns a short pointer instead of
 *  re-sending the bytes — the model already has the content in context, so this is quality-neutral.
 *  Provably non-dangling: the loop clears the cache at the start of every turn AND whenever
 *  editContext evicts a tool result (the only thing that can remove the earlier copy from history),
 *  so a pointer can never reference content the model no longer has. */
export class ReadCache {
  private seen = new Map<string, number>(); // absPath -> content fingerprint
  private fp(s: string): number {
    let h = 0x811c9dc5; // FNV-1a (32-bit), mixed with length to make collisions vanishingly unlikely
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ((h >>> 0) ^ (s.length * 2654435761)) >>> 0;
  }
  /** True iff the current `content` for `path` matches what was last returned in full this turn. */
  hit(path: string, content: string): boolean { return this.seen.get(path) === this.fp(content); }
  /** Record that full `content` for `path` was returned (it is now present in history). */
  note(path: string, content: string): void { this.seen.set(path, this.fp(content)); }
  clear(): void { this.seen.clear(); }
}

const MIN_DEDUP_CHARS = 200; // don't bother deduping tiny reads — the pointer barely saves anything

/** Optional host-wired extras: the session secret store (interactive masked input) for request_secret /
 *  check_secret. Omitted in non-interactive contexts (subagents, smokes) — those tools then degrade to
 *  reading already-set environment secrets. */
export interface ToolExtras { secrets?: SecretStore }

export function buildTools(cfg: Config, store: MemoryStore, askUser?: AskUserFn, procs?: ProcRegistry, todos?: TodoRegistry, readCache: ReadCache = new ReadCache(), extras: ToolExtras = {}): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const add = (t: Tool) => tools.set(t.def.name, t);
  // Scrub any session secret value that leaks into shell output (an accidental `echo $TOKEN`, a tool that
  // prints its config) before it reaches the model/transcript. No-op when no secret store is wired.
  const redact = (s: string): string => (extras.secrets ? extras.secrets.redact(s) : s);

  add({
    def: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace. For a large file, pass offset/limit (a 1-based line range) to read ONLY the slice you need instead of the whole file — this keeps context lean, since a full read rides along in history on every subsequent step.",
      input_schema: { type: "object", properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "optional 1-based line number to start reading from" },
        limit: { type: "integer", description: "optional max number of lines to read from offset" },
      }, required: ["path"] },
    },
    mutating: false,
    run: ({ path, offset, limit }) => {
      const abs = safePath(cfg, path);
      let content: string;
      try { content = readFileSync(abs, "utf8"); }
      catch (e) {
        // A not-found is the #1 path mistake (a doubled relative like "<workspace-name>/src/…" or a wrong
        // prefix). Name the root + the working form so the model corrects in one step, not twelve.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no such file: "${path}". The workspace root is ${cfg.cwd} — pass a path relative to it (e.g. "src/agent/loop.ts"). Use list_dir to find the right path.`);
        throw e;
      }
      // Line-range slice: read only the requested window. The returned slice (not the whole file) is
      // what's cached/deduped below, so a ranged re-read of the same window is correctly recognized.
      const hasRange = offset != null || limit != null;
      let rangeNote = "";
      if (hasRange) {
        const lines = content.split("\n");
        const start = Math.max(0, (Number(offset) || 1) - 1);
        // A 0 / negative / non-numeric limit must read to EOF, not return an empty slice (which reads as a
        // successful "file is empty" result and misleads the model). Only a finite, positive limit caps it.
        const lim = Math.floor(Number(limit));
        const end = limit != null && Number.isFinite(lim) && lim > 0 ? start + lim : lines.length;
        content = lines.slice(start, end).join("\n");
        rangeNote = ` (lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length})`;
      }
      // Hard char cap. SAY SO when it bites — a silent slice makes the model reason about a partial file as
      // if it were complete (e.g. "the function isn't defined here"). Tell it how to read past the cap.
      const CHAR_CAP = 100_000;
      const capped = content.length > CHAR_CAP;
      if (capped) content = content.slice(0, CHAR_CAP);
      const capNote = capped
        ? `\n[read_file: TRUNCATED to the first ${CHAR_CAP.toLocaleString()} chars — the ${hasRange ? "selected range" : "file"} is larger. Pass offset/limit (a line range) to read past this point; do NOT assume the content ends here.]`
        : "";
      // Cache/dedup key includes the range so a full read and a ranged read of the same file don't
      // collide on the path alone (they return different content).
      const key = hasRange ? `${abs}#${offset ?? ""}:${limit ?? ""}` : abs;
      // Re-read dedup: if this exact content was already returned in full this turn, the model still
      // has it in context — return a pointer instead of re-sending the bytes (token optimization).
      if (content.length >= MIN_DEDUP_CHARS && readCache.hit(key, content)) {
        return `[read_file: ${path}${rangeNote} is unchanged since it was read earlier this turn — ${content.length} chars elided to save context; the copy above is still current]`;
      }
      readCache.note(key, content);
      return rangeNote || capNote
        ? `${content}${rangeNote ? `\n[read_file: returned ${rangeNote.trim()}; pass a different offset/limit for more]` : ""}${capNote}`
        : content;
    },
  });

  add({
    def: {
      name: "diagnostics",
      description:
        "Get line-precise diagnostics (errors/warnings) for a single file from its language server " +
        "(LSP) — faster and more granular than a whole-project typecheck. Use it right after editing a " +
        "file to confirm the change is clean. Falls back gracefully (says so) when no language server is " +
        "installed for that file type; for a project-wide gate use the `verify` tool instead.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    mutating: false,
    run: async ({ path }) => {
      const abs = safePath(cfg, path);
      let content: string;
      try { content = readFileSync(abs, "utf8"); } catch (e) { return `diagnostics: cannot read ${path}: ${(e as Error).message}`; }
      const r = await getDiagnostics(abs, content, { cwd: cfg.cwd });
      if (!r.available) return `diagnostics unavailable for ${path}: ${r.reason}. (Use the \`verify\` tool for a project-wide check.)`;
      return formatDiagnostics(r.diagnostics, path);
    },
  });

  add({
    def: {
      name: "list_dir",
      description: "List entries of a directory (relative to the workspace root).",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
    mutating: false,
    run: ({ path = "." }) => {
      const dir = safePath(cfg, path);
      if (!existsSync(dir)) return `directory not found: ${path} (create it first or list its parent directory)`;
      try { if (!statSync(dir).isDirectory()) return `not a directory: ${path}`; } catch { return `cannot read directory: ${path}`; }
      return readdirSync(dir)
        .map((n) => {
          try { return statSync(resolve(dir, n)).isDirectory() ? n + "/" : n; }
          catch { return n; }
        })
        .join("\n");
    },
  });

  add({
    def: {
      name: "write_file",
      description: "Create a new file or intentionally replace an entire existing file. For existing non-trivial files, prefer edit_file with a narrow exact replacement; after an edit_file mismatch, re-read the relevant range and retry edit_file instead of rewriting the whole file.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    mutating: true,
    run: ({ path, content }) => {
      const abs = safePath(cfg, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return `wrote ${content.length} bytes to ${path}`;
    },
  });

  add({
    def: {
      name: "edit_file",
      description:
        "Replace a string in a file (search/replace diff). Tries an exact match first, then falls back to a " +
        "whitespace/indentation-flexible match. old_string must be unique unless replace_all is true.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    mutating: true,
    run: ({ path, old_string, new_string, replace_all }) => {
      const abs = safePath(cfg, path);
      const src = readFileSync(abs, "utf8");
      const { content, replacements, mode } = applyFlexibleEdit(src, old_string, new_string, !!replace_all);
      writeFileSync(abs, content);
      return `edited ${path} (${replacements} replacement${replacements === 1 ? "" : "s"}${mode === "flexible" ? ", whitespace-flexible match" : ""})`;
    },
  });

  // Launch a long-lived command DETACHED (its own process group → a kill takes down the whole subtree:
  // the `bash -lc` wrapper AND the server it spawns, e.g. npm → node), register it with its cwd, drain
  // output into the registry buffer, and return a status line. Shared by run_bash(background:true) and
  // restart_bash, so a restart relaunches the EXACT same command in the EXACT same directory.
  const launchBackground = (command: string, workdir: string): { id: number | undefined; message: string } => {
    // Refuse to launch a SECOND copy of an identical long-lived command BEFORE spawning it. The old guard
    // spawned first and only THEN warned — which already created the duplicate server / port conflict it
    // claimed to prevent. restart_bash waits for the old process to leave the registry before relaunching,
    // so a legitimate restart never trips this.
    const dup = procs?.list().find((p) => p.background && p.command === command);
    if (dup) {
      return { id: dup.id, message: `not starting a duplicate — a background process with the same command is already running (#${dup.id}); launching another would conflict (a port clash if it's a server). Use restart_bash(id: ${dup.id}) to bounce it cleanly, or kill_bash(id: ${dup.id}) to stop it first.` };
    }
    const argv = wrapCommand(cfg.sandbox, cfg.cwd, command);
    // Pass an explicit env snapshot: Bun.spawn does NOT propagate runtime mutations of process.env (unlike
    // Node), so request_secret values (written to process.env) would otherwise be BLANK in the child shell.
    const proc = Bun.spawn(argv, { cwd: workdir, env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
    const id = procs?.add(command, makeProcKiller(proc.pid, (sig) => proc.kill(sig as any), true), proc.pid, true, workdir);
    const dec = new TextDecoder();
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; if (id !== undefined) procs?.appendOutput(id, dec.decode(value, { stream: true })); } }
      catch { /* torn down on kill */ } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
    };
    void drain(proc.stdout); void drain(proc.stderr);
    void proc.exited.then(() => { if (id !== undefined) procs?.remove(id); });
    return { id, message: `started background process #${id} (pid ${proc.pid ?? "?"}): ${command}\nIt keeps running; use list_bash to read its output, restart_bash(id: ${id}) to bounce it, kill_bash(id: ${id}) to stop it.` };
  };

  add({
    def: {
      name: "run_bash",
      description:
        "Run a shell command in the workspace and return combined stdout/stderr. " +
        "Each call starts FRESH in the workspace root — the working directory does NOT persist between calls. " +
        "To run in a subfolder, pass `cwd` (relative to the workspace) or chain it in one command (e.g. `cd sub && npm run build`). " +
        "A foreground command is KILLED if it runs longer than timeout_ms (default 2min, max 10min) so a stuck command can't hang the turn — bump timeout_ms for a legitimately slow build. " +
        "Set background:true for a long-lived process (a dev server, a `localhost`, a watcher) so it does NOT block the turn — " +
        "it returns immediately with a process id, keeps running, shows in the footer, and its output is buffered. " +
        "Then use list_bash to read its output (e.g. the served URL) and kill_bash to stop it.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "working directory for THIS command, relative to the workspace root (the cwd is NOT remembered for the next call)" },
          timeout_ms: { type: "number", description: "max ms to wait before the command is killed (default 120000 = 2min, max 600000 = 10min). Ignored when background:true. For something that should stay up, use background instead of a huge timeout." },
          background: { type: "boolean", description: "run detached (don't wait for exit); for servers/watchers that stay up" },
        },
        required: ["command"],
      },
    },
    mutating: true,
    destructive: false, // recomputed per-call below
    // Async (Bun.spawn, not spawnSync) so the event loop stays free while the command runs — that's
    // what lets the TUI show the process in the footer and kill it. Registered in `procs` for its
    // lifetime; a kill (user `x` / ESC / kill_bash) signals the wrapper and the await below returns.
    run: async ({ command, background, cwd, timeout_ms }, ctx) => {
      // A malformed tool call (no/blank command) must fail cleanly here — never spawn a no-op shell or
      // register a process with an undefined command (which then crashed the TUI render).
      if (typeof command !== "string" || !command.trim()) throw new Error("run_bash needs a non-empty `command` string");
      // Safety floor: refuse catastrophic commands (rm -rf /, dd to a raw disk, mkfs, system-path
      // deletes) BEFORE they ever spawn — even in autopilot. Warnings are surfaced separately via the
      // approval gate (isDestructiveCall); only a hard Block stops execution here.
      const verdict = validateBashCommand(command, { planMode: cfg.planMode, permissionMode: cfg.permissionMode, sandbox: cfg.sandbox });
      if (verdict.kind === "block") throw new Error(`blocked by safety policy: ${verdict.reason}`);
      // Per-call working directory (relative to the workspace root); cwd does NOT carry between calls.
      // Must stay INSIDE the workspace: `resolve()` alone happily accepts cwd:".." (or a symlinked subdir)
      // and would run the command in the parent tree, escaping the workspace boundary.
      const workdir = cwd ? resolve(cfg.cwd, String(cwd)) : cfg.cwd;
      if (workdir !== cfg.cwd && !insideWorkspaceReal(cfg.cwd, workdir)) {
        throw new Error(`run_bash: cwd is outside the workspace: "${cwd}". Pass a directory relative to the workspace root ${cfg.cwd} (e.g. "packages/web"), not "..", an absolute path, or a link out.`);
      }
      if (workdir !== cfg.cwd && !existsSync(workdir)) throw new Error(`run_bash: cwd does not exist: ${cwd} (resolved to ${workdir})`);
      // Background → hand off to the shared detached launcher (so a later restart_bash can relaunch it
      // identically). It returns immediately; the turn continues.
      if (background) return launchBackground(command, workdir).message;

      // Foreground: spawn inline and await with a timeout below. Explicit env (see launchBackground) so
      // request_secret values reach the shell — Bun.spawn ignores runtime process.env mutations otherwise.
      const argv = wrapCommand(cfg.sandbox, cfg.cwd, command);
      const proc = Bun.spawn(argv, { cwd: workdir, env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const id = procs?.add(command, makeProcKiller(proc.pid, (sig) => proc.kill(sig as any), false), proc.pid, false, workdir);
      // ESC: kill this foreground command directly. procs.killAll() (from the cancel handler) already
      // covers the wired TUI/REPL case; this also handles contexts with no process registry (subagents),
      // so a long foreground command always dies on abort. The `finally` removes it from procs either way.
      const onAbort = () => { try { proc.kill(); } catch { /* already gone */ } };
      if (ctx?.signal) { if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener("abort", onAbort, { once: true }); }

      // Drain incrementally into buffers so we keep partial output even if the process is killed.
      const buf = { out: "", err: "" };
      const pump = async (stream: ReadableStream<Uint8Array>, key: "out" | "err") => {
        const reader = stream.getReader(); const dec = new TextDecoder();
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf[key] += dec.decode(value, { stream: true }); } }
        catch { /* stream torn down on kill */ } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
      };
      // Foreground timeout so a stuck command can't hang the turn forever. Default 2min, hard-capped at
      // 10min (mirrors common agent bash tools); override per-call with timeout_ms or globally via
      // OB1_BASH_TIMEOUT_MS. Long-lived processes should use background:true, not a huge timeout.
      const defaultMs = Math.max(1_000, Number(process.env.OB1_BASH_TIMEOUT_MS) || 120_000);
      const timeoutMs = Math.min(600_000, Math.max(1_000, Number(timeout_ms) || defaultMs));
      try {
        const drained = Promise.all([pump(proc.stdout, "out"), pump(proc.stderr, "err")]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); });
        const finished = proc.exited.then(() => "exited" as const);
        const outcome = await Promise.race([finished, timedOut]);
        clearTimeout(timer);

        if (outcome === "timeout") {
          // Kill the stuck command (SIGTERM, then SIGKILL if it clings on), keep whatever it printed.
          try { proc.kill(); } catch { /* already gone */ }
          const sigkill = setTimeout(() => { try { proc.kill(9); } catch { /* already gone */ } }, 2_000);
          (sigkill as any).unref?.(); // don't keep the event loop alive just for the fallback kill
          await Promise.race([drained, new Promise((r) => setTimeout(r, 200))]);
          const secs = Math.round(timeoutMs / 1_000);
          return clampOutput(redact(`timed out after ${secs}s — command killed (it was still running). ` +
            `Re-run with a larger timeout_ms if it just needs longer, or use background:true for a long-lived process.\n` +
            `Partial output:\n${buf.out}${buf.err ? "\n[stderr]\n" + buf.err : ""}`));
        }

        const code = await proc.exited;
        // Once the wrapper has exited, wait briefly for the pipes to flush — but don't hang forever if a
        // detached grandchild (from a killed command) is still holding them open. Normal commands close
        // their pipes at exit, so `drained` wins instantly; the grace only matters for the kill case.
        await Promise.race([drained, new Promise((r) => setTimeout(r, 150))]);
        return clampOutput(redact(`exit ${code}\n${buf.out}${buf.err ? "\n[stderr]\n" + buf.err : ""}`));
      } finally {
        ctx?.signal?.removeEventListener("abort", onAbort);
        if (id !== undefined) procs?.remove(id);
      }
    },
  });

  // list_bash / kill_bash give the AGENT the same view + control the TUI footer (⌃P) has over running
  // processes: it can see what background commands it left running (with their buffered output) and stop
  // them by id. Only offered when a process registry is wired (the interactive TUI / REPL).
  if (procs) {
    add({
      def: {
        name: "list_bash",
        description: "List the run_bash processes currently running (id, pid, command, elapsed) with a tail of each background process's buffered output. Use to find a server's URL/logs or which id to kill_bash.",
        input_schema: { type: "object", properties: {} },
      },
      mutating: false,
      run: () => {
        const list = procs.list();
        if (list.length === 0) return "no running processes";
        return redact(list.map((p) => {
          const secs = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000));
          const head = `#${p.id} (pid ${p.pid ?? "?"}, ${secs}s${p.background ? ", background" : ""}${p.killing ? ", killing…" : ""}): ${p.command}`;
          const tail = p.background ? procs.tail(p.id, 2000).trimEnd() : "";
          return tail ? `${head}\n  ┌ output (tail):\n${tail.split("\n").map((l) => "  │ " + l).join("\n")}` : head;
        }).join("\n"));
      },
    });

    add({
      def: {
        name: "kill_bash",
        description: "Stop a running run_bash process by its id (the run_bash id from list_bash — NOT an OS PID). Sends SIGTERM, then SIGKILL if called again on a stuck process. Use this to shut down a background server/watcher you started.",
        input_schema: { type: "object", properties: { id: { type: "number", description: "the process id from list_bash" } }, required: ["id"] },
      },
      mutating: true,
      run: ({ id }) => {
        const n = Number(id);
        const info = procs.get(n);
        if (!info) {
          // Common mistake: passing an OS PID (e.g. from `lsof`/`ps`) instead of the run_bash id.
          const byPid = procs.list().find((p) => p.pid === n);
          if (byPid) return `${n} is an OS PID, not a run_bash id. Use kill_bash(id: ${byPid.id}) to stop "${byPid.command}".`;
          const ids = procs.list().map((p) => `#${p.id}`).join(", ") || "(none running)";
          return `no run_bash process with id ${n}. Running ids: ${ids}. (kill_bash takes the run_bash id from list_bash, NOT an OS PID — to kill an OS PID use run_bash "kill ${n}".)`;
        }
        procs.kill(n);
        return `signaled process #${n} (${info.command}) — ${info.killing ? "SIGKILL (was already stopping)" : "SIGTERM"}`;
      },
    });

    add({
      def: {
        name: "restart_bash",
        description:
          "Cleanly restart a BACKGROUND process (a dev server / watcher) by its run_bash id: kills the whole " +
          "process group, WAITS for it to actually exit (so its port is freed), then relaunches the SAME " +
          "command in the SAME directory and returns the new id. Use this — not kill_bash + run_bash, which " +
          "races on the port — after changing files a running server won't hot-reload: SSR / config files " +
          "(gatsby-ssr.js, gatsby-node.js, next.config.js, vite.config), env vars, or to recover a crashed watcher.",
        input_schema: { type: "object", properties: { id: { type: "number", description: "the background process id from list_bash" } }, required: ["id"] },
      },
      mutating: true,
      run: async ({ id }) => {
        const n = Number(id);
        const info = procs.get(n);
        if (!info) {
          const ids = procs.list().filter((p) => p.background).map((p) => `#${p.id}`).join(", ") || "(none running)";
          return `no run_bash process with id ${n}. Background ids: ${ids}. (restart_bash takes the run_bash id from list_bash, not an OS PID.)`;
        }
        if (!info.background) return `#${n} (${info.command}) is a foreground command, not a long-lived background process — nothing to restart.`;
        const command = info.command;
        const workdir = info.cwd ?? cfg.cwd;
        // SIGTERM the group, then WAIT for it to leave the registry (its exit handler removes it) so the
        // port is released before we relaunch. Escalate to SIGKILL if it clings on; cap the wait so a stuck
        // child can never hang the turn.
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        procs.kill(n); // SIGTERM
        const start = Date.now();
        let escalated = false;
        while (procs.get(n) && Date.now() - start < 8_000) {
          await sleep(100);
          if (!escalated && Date.now() - start > 3_000 && procs.get(n)) { procs.kill(n); escalated = true; } // → SIGKILL
        }
        if (procs.get(n)) return `#${n} (${command}) did not exit within 8s even after SIGKILL — NOT relaunched (a detached child may be holding the port). Check list_bash.`;
        const { id: newId, message } = launchBackground(command, workdir);
        return `restarted #${n} → new #${newId} (old process exited cleanly${escalated ? " after SIGKILL" : ""}, port freed, relaunched in ${workdir === cfg.cwd ? "the workspace root" : workdir}).\n${message}`;
      },
    });
  }

  add({
    def: {
      name: "verify",
      description:
        "Run the project's OWN checks to confirm your changes work — auto-detected from the project " +
        "(typecheck/compile, lint, tests, build; npm/bun/cargo/go/python). Use this after editing code, " +
        "then fix whatever fails. Choose the scope that fits the change and language: 'auto' (default — a " +
        "fast compile/typecheck gate), 'all', or a comma list of kinds e.g. 'typecheck,test'. You can also " +
        "pass a GREEN LEVEL to gate at increasing rigor: 'targeted_tests' < 'package' (typecheck+test) < " +
        "'workspace' (all) < 'merge_ready' (all, no known flakes tolerated). " +
        "Returns each check's pass/fail with the failure output so you can correct it.",
      input_schema: {
        type: "object",
        properties: { checks: { type: "string", description: "'auto' · 'all' · a comma list (e.g. 'typecheck,test') · or a green level ('targeted_tests'|'package'|'workspace'|'merge_ready')" } },
      },
    },
    mutating: false, // verification only — runs the project's known check commands; no approval gate
    run: async ({ checks }, ctx) => {
      // Thread the turn's abort signal so ESC kills an in-flight check command (a slow test/build),
      // not just the model call between checks. shellExec kills the proc on abort.
      const exec = (cmd: string) => shellExec({ cwd: cfg.cwd, sandbox: cfg.sandbox, command: cmd, signal: ctx?.signal });
      const arg = String(checks ?? "auto").trim().toLowerCase();
      // Green contract: a target level maps to the right check kinds AND a pass/fail contract (with
      // known-flake tolerance below merge_ready). OB1_KNOWN_FLAKES is a comma list of flaky check names.
      if (isGreenLevel(arg)) {
        const r = await runVerification(cfg.cwd, exec, levelKinds(arg));
        const knownFlakes = (process.env.OB1_KNOWN_FLAKES ?? "").split(/[,\s]+/).filter(Boolean);
        const contract = evaluateContract(arg, r.results, { knownFlakes });
        return `${contract.report}\n\n${r.report}`;
      }
      const r = await runVerification(cfg.cwd, exec, parseScope(checks));
      if (!r.ran) return r.report;
      return `${r.ok ? "✓ all checks passed" : "✗ some checks FAILED — fix these"}\n\n${r.report}`;
    },
  });

  add({
    def: {
      name: "browser_check",
      description:
        "VERIFY a running web app in a real headless browser — the only way to confirm a VISUAL or " +
        "INTERACTIVE change actually works (a theme toggle, a button, a form, a route). Static checks " +
        "(typecheck/build) and `curl` CANNOT see client-side behavior; this can. For static HTML/CSS/JS " +
        "pages, pass a workspace file path such as `site/index.html` or a `file://` URL — no dev server " +
        "is needed. For framework apps, point it at the dev server URL (start one with run_bash " +
        "background first, then call the list_bash TOOL — not a shell command — to read its URL). " +
        "Drive the page with `actions` (click/fill/press/wait/eval) and verify with `assert` " +
        "(each evaluates a JS expression in page context). It captures console + uncaught page errors " +
        "(React crashes show up here, with stack traces), captures FAILED network requests (broken APIs / " +
        "404 assets), and returns an ACCESSIBILITY-TREE snapshot — a structured list of the page's roles + " +
        "names you can use to target elements and reason about structure without a screenshot. " +
        "On a vision-capable model a screenshot is ATTACHED for you to inspect directly — by default ONLY " +
        "when the check FAILS (set screenshot:'always' to get it every time, 'off' to disable) — " +
        "use it to judge visual/layout correctness (spacing, overlap, color, cut-off text) that assertions can't express. " +
        "Theme-toggle pattern: eval-stash the before value → click the toggle → assert the value CHANGED. " +
        "Example assert: {describe:'bg changed after click', eval:\"getComputedStyle(document.body).backgroundColor !== window.__b\", truthy:true}.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "the page to load, e.g. http://localhost:8000/ or a workspace file path like site/index.html" },
          actions: {
            type: "array",
            description: "interactions to perform IN ORDER before asserting",
            items: {
              type: "object",
              properties: {
                click: { type: "string", description: "CSS selector to click" },
                fill: { type: "object", description: "{selector, text} — type into an input", properties: { selector: { type: "string" }, text: { type: "string" } } },
                press: { type: "string", description: "keyboard key, e.g. Enter" },
                waitForSelector: { type: "string", description: "block until this selector is visible" },
                wait: { type: "number", description: "settle time in ms (after a click/animation)" },
                eval: { type: "string", description: "JS expression run in page context (e.g. stash a before-value: window.__b = getComputedStyle(document.body).backgroundColor)" },
              },
            },
          },
          assert: {
            type: "array",
            description: "checks run after the actions; the change FAILS if any assertion fails",
            items: {
              type: "object",
              properties: {
                describe: { type: "string", description: "what this asserts, in plain words" },
                eval: { type: "string", description: "JS expression evaluated in the page; its value is compared" },
                equals: { description: "pass when the value === this" },
                contains: { type: "string", description: "pass when String(value) includes this" },
                truthy: { type: "boolean", description: "pass when the value is truthy (default) / falsy (false)" },
              },
              required: ["describe", "eval"],
            },
          },
          screenshot: { type: "string", enum: ["auto", "always", "off"], description: "screenshot policy: 'auto' (default) attaches the image to you ONLY when the check fails; 'always' every time; 'off' none. A PNG is still written to .ob1/screenshots/ for auto/always." },
          snapshot: { type: "boolean", description: "include the accessibility-tree snapshot in the report (default true)" },
          timeout_ms: { type: "number", description: "per-navigation/action timeout (default 15000)" },
        },
        required: ["url"],
      },
    },
    mutating: false, // verification only — drives a local preview; auto-runs without an approval gate
    run: async ({ url, actions, assert, screenshot, snapshot, timeout_ms }, ctx) => {
      if (typeof url !== "string" || !url.trim()) throw new Error("browser_check needs a URL or workspace file path (e.g. http://localhost:8000/ or site/index.html)");
      const normalizedUrl = browserCheckUrl(cfg, url);
      const mode = screenshotMode(screenshot);
      const vision = visionEnabled(cfg.resolvedModel ?? cfg.model); // resolved model if the chosen one is a router alias
      const shot = mode === "off" ? undefined : defaultScreenshotPath(cfg.cwd, Date.now());
      // Capture the base64 when a vision model MIGHT want it (always-mode, or auto-mode on a future fail).
      // Whether we actually ATTACH it is decided post-result by shouldAttachScreenshot (cost-aware: auto
      // attaches only on failure, so a passing check never burns vision tokens on a screenshot).
      const r = await runBrowserCheck({
        url: normalizedUrl,
        actions: Array.isArray(actions) ? actions : undefined,
        assert: Array.isArray(assert) ? assert : undefined,
        screenshotPath: shot,
        captureImage: vision && mode !== "off",
        snapshot: snapshot !== false,
        timeoutMs: Number(timeout_ms) || undefined,
        signal: ctx?.signal,
      });
      const text = formatBrowserCheck(r);
      if (shouldAttachScreenshot(mode, vision, r.ok) && r.imageBase64) {
        return { text, images: [{ data: r.imageBase64, mediaType: r.imageMediaType ?? "image/png" }] };
      }
      return text;
    },
  });

  add({
    def: {
      name: "web_fetch",
      description: "Fetch an http(s) URL and return its text (HTML is stripped to readable text, truncated). Use to read docs, references, or a specific page (often after web_search).",
      input_schema: { type: "object", properties: { url: { type: "string", description: "an http:// or https:// URL" } }, required: ["url"] },
    },
    mutating: false, // read-only network fetch
    run: ({ url }, ctx) => webFetch({ url, allowPrivate: process.env.OB1_WEB_FETCH_ALLOW_PRIVATE === "1", signal: ctx?.signal }),
  });

  // web_search is only offered when a SearXNG backend is configured (OB1_SEARXNG_URL); otherwise the
  // model would see a tool it can't use. The key (OB1_SEARXNG_KEY) is sent as the X-API-Key header.
  if (cfg.searxngUrl) add({
    def: {
      name: "web_search",
      description: "Search the web for current information, documentation, or references. Returns a ranked list (title, URL, snippet). Use this to discover pages, then web_fetch to read one.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "the search query" },
          time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "optional recency filter" },
          categories: { type: "string", description: "optional, e.g. 'news', 'science', 'it'" },
          language: { type: "string", description: "optional language code, e.g. 'en'" },
        },
        required: ["query"],
      },
    },
    mutating: false, // read-only network search
    run: ({ query, time_range, categories, language }, ctx) =>
      webSearch({ base: cfg.searxngUrl, key: cfg.searxngKey, bearer: cfg.searxngBearer, query, time_range, categories, language, signal: ctx?.signal }),
  });

  // --- Memory tools: low-risk, touch OB-1's own store, not the user's files ---
  add({
    def: {
      name: "memory_add",
      description: "Persist a concise, durable fact about this project to long-term memory.",
      input_schema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    },
    mutating: false,
    run: async ({ fact }) => `remembered #${await store.remember(fact)}`,
  });

  add({
    def: {
      name: "memory_search",
      description: "Semantic search of long-term project memory for relevant facts (vector top-k).",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    mutating: false,
    run: async ({ query }) => {
      const hits = await store.searchSemantic(query);
      return hits.length ? hits.map((f) => `#${f.id} ${f.fact}`).join("\n") : "(no matching memories)";
    },
  });

  add({
    def: {
      name: "relate",
      description: "Record a typed relationship between two code entities, e.g. relate(src='LoginController', rel='calls', dst='AuthService').",
      input_schema: {
        type: "object",
        properties: { src: { type: "string" }, rel: { type: "string" }, dst: { type: "string" } },
        required: ["src", "rel", "dst"],
      },
    },
    mutating: false,
    run: ({ src, rel, dst }) => `linked ${src} --${rel}--> ${dst} (#${store.addRelationship(src, rel, dst)})`,
  });

  add({
    def: {
      name: "repo_map",
      description: "Get a ranked map of the codebase — the most-referenced files and their key symbols. Use this to orient before reading files (cheaper than reading everything).",
      input_schema: { type: "object", properties: {} },
    },
    mutating: false,
    run: () => renderRepoMap(buildRepoMap(cfg.cwd)),
  });

  add({
    def: {
      name: "read_topic",
      description: "Load an on-demand project topic file (e.g. debugging, conventions, architecture) by name — detailed notes that spill out of the always-loaded AGENTS.md index.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    mutating: false,
    run: ({ name }) => {
      const body = readTopic(cfg.cwd, name);
      if (body) return body;
      const avail = listTopics(cfg.cwd).map((t) => t.name).join(", ") || "(none)";
      return `unknown topic: ${name}. Available: ${avail}`;
    },
  });

  add({
    def: {
      name: "use_skill",
      description: "Load the full instructions for a named skill (from the available-skills list) when its task matches. Returns the skill body to follow.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    mutating: false,
    run: ({ name }) => {
      const body = readSkill(cfg.cwd, name);
      if (body) { recordSkillUse(cfg.cwd, name); return body; } // telemetry + reactivate-on-use (curator)
      const avail = listSkills(cfg.cwd).map((s) => s.name).join(", ") || "(none)";
      return `unknown skill: ${name}. Available: ${avail}`;
    },
  });

  // manage_skill — turn a proven approach into reusable PROCEDURAL memory (a learned skill). Writes
  // markdown to .ob1/skills/ so future turns can load it with use_skill. MUTATING → it passes the
  // approval gate and is blocked in Plan mode, like any other write. Only learned skills (origin:agent)
  // can be patched/deleted; shipped/user skills are protected by the registry.
  add({
    def: {
      name: "manage_skill",
      description:
        "Save a reusable SKILL (procedural memory) so you can apply the same approach automatically later. " +
        "Create one when a non-trivial task succeeded, an error was overcome, or a user-corrected approach worked — " +
        "capture the GENERAL method (a class of task), not a one-off narrative or a transient/environment-specific failure. " +
        "Prefer updating an existing related skill over creating a near-duplicate. Actions: " +
        "create {name, description, body}; update {name, (body | old_string,new_string)}; delete {name}. " +
        "The body is markdown instructions (when-to-use, steps, pitfalls). Keep name short and generic.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "delete"] },
          name: { type: "string", description: "short, generic skill name (slugified for the filename)" },
          description: { type: "string", description: "one line shown in the always-on skill index" },
          body: { type: "string", description: "markdown instructions; for update, the full new body" },
          old_string: { type: "string", description: "for a targeted update: exact text in the body to replace" },
          new_string: { type: "string", description: "replacement text for old_string" },
        },
        required: ["action", "name"],
      },
    },
    mutating: true,
    run: ({ action, name, description, body, old_string, new_string }) => {
      let r;
      if (action === "create") r = writeSkill(cfg.cwd, { name, description: description ?? "", body: body ?? "" });
      else if (action === "update") {
        if (typeof old_string === "string" && old_string.length) r = patchSkill(cfg.cwd, name, old_string, new_string ?? "");
        else if (typeof body === "string" && body.length) r = writeSkill(cfg.cwd, { name, description: description ?? (findSkill(cfg.cwd, name)?.description ?? ""), body });
        else return `update needs either old_string/new_string (targeted) or body (full replace)`;
      } else if (action === "delete") r = deleteSkill(cfg.cwd, name);
      else return `unknown action: ${action} (use create | update | delete)`;
      if (!r.ok) return `skill ${action} failed: ${r.error}`;
      const verb = action === "delete" ? "deleted" : r.created ? "created" : "updated";
      return `skill ${verb}: ${name}${action === "delete" ? "" : ` → ${r.path}`}`;
    },
  });

  // update_tasks — the agent's TODO list for a longer, multi-step task, shown above the input so the
  // user can watch progress. Only offered when the host wired a TodoRegistry (interactive UI). Read-only
  // (it only updates in-memory display state) so it bypasses the approval gate and works in Plan mode.
  if (todos) add({
    def: {
      name: "update_tasks",
      description:
        "Maintain a visible TODO list for a longer task with several distinct steps. Call it once up front with the planned " +
        "steps (each status \"pending\"), then call it again as you go to flip the step you're starting to \"in_progress\" " +
        "(keep a SINGLE in_progress at a time) and each finished step to \"completed\". Pass the FULL list every time — it " +
        "REPLACES the previous one. Clear the list (pass an empty `tasks` array) when the whole task is done. Skip this for " +
        "simple one- or two-step tasks. The list is shown to the user above the input and persists across turns.",
      input_schema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "the full task list (replaces the previous one); empty to clear",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "the task, as a short imperative phrase" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "pending | in_progress | completed" },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["tasks"],
      },
    },
    mutating: false,
    run: (input: any) => {
      const raw: any[] = Array.isArray(input?.tasks) ? input.tasks : [];
      const items: TodoItem[] = raw
        .map((t: any): TodoItem | null => {
          // tolerate a bare string, or {content|task|text, status|state}
          const content = (typeof t === "string" ? t : String(t?.content ?? t?.task ?? t?.text ?? "")).trim();
          const s = String(t?.status ?? t?.state ?? "pending").toLowerCase();
          const status: TodoStatus = /^(completed|done|complete)$/.test(s) ? "completed"
            : /^(in_progress|in-progress|active|doing|started)$/.test(s) ? "in_progress" : "pending";
          return content ? { content, status } : null;
        })
        .filter((t: TodoItem | null): t is TodoItem => t !== null)
        .slice(0, 40);
      todos.set(items);
      if (!items.length) return "task list cleared.";
      const mark = (s: TodoStatus) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
      const done = items.filter((t) => t.status === "completed").length;
      return `task list updated (${done}/${items.length} done):\n` + items.map((t) => `  ${mark(t.status)} ${t.content}`).join("\n");
    },
  });

  // ask_user — only offered when the host wired an askUser callback (interactive UI). Read-only: it
  // gathers input, never touches files, so it bypasses the approval gate and works in Plan mode.
  if (askUser) add({
    def: {
      name: "ask_user",
      description:
        "Ask the user one or more clarifying questions when the task is ambiguous or hinges on a decision only they can " +
        "make (a missing requirement, a choice between approaches, a preference). Pass a `questions` group — usually ONE " +
        "question; batch several only when the task genuinely needs multiple independent decisions. Each question gives 2–4 " +
        "short, distinct options; the user picks with arrow keys and can always type their own answer instead. Set " +
        "multi_select on a question for \"choose any that apply\" (checkboxes) rather than the default single choice (radio). " +
        "Returns the user's answers. Prefer asking over guessing when a wrong assumption would waste work — but don't ask " +
        "when a sensible default is obvious.",
      input_schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "1–4 clarifying questions to put to the user in one batch (usually just one)",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "the question to put to the user" },
                header: { type: "string", description: "optional 1–3 word topic label shown as a chip" },
                options: {
                  type: "array",
                  description: "2–4 answer choices the user can select",
                  items: {
                    type: "object",
                    properties: { label: { type: "string" }, description: { type: "string", description: "optional one-line clarification of this choice" } },
                    required: ["label"],
                  },
                },
                multi_select: { type: "boolean", description: "true = checkboxes (choose any that apply); false/omitted = radio (choose one)" },
              },
              required: ["question", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    mutating: false,
    run: async (input: any) => {
      // Accept the group form ({questions:[…]}) and tolerate a single top-level question for robustness.
      const raw: any[] = Array.isArray(input?.questions) ? input.questions : (input?.question ? [input] : []);
      const questions: AskQuestion[] = raw
        .map((qq: any): AskQuestion | null => {
          // options: tolerate string ("Postgres") or object ({label, description}); drop blanks; cap at 6.
          const opts: AskOption[] = (Array.isArray(qq?.options) ? qq.options : [])
            .map((o: any) => (typeof o === "string" ? { label: o.trim() } : { label: String(o?.label ?? "").trim(), description: o?.description ? String(o.description) : undefined }))
            .filter((o: AskOption) => o.label)
            .slice(0, 6);
          const q = String(qq?.question ?? "").trim();
          return q && opts.length ? { question: q, header: qq?.header ? String(qq.header).trim() : undefined, options: opts, multiSelect: !!qq?.multi_select } : null;
        })
        .filter((q: AskQuestion | null): q is AskQuestion => q !== null)
        .slice(0, 4);
      if (!questions.length) return "ask_user needs at least one question with options; proceeding without asking.";
      return askUser({ questions });
    },
  });

  // Architect/Editor two-model edits (item #10) — opt-in, advertised only when OB1_EDIT_ARCHITECT is on.
  if (/^(1|true|on)$/i.test(process.env.OB1_EDIT_ARCHITECT ?? "")) add({
    def: {
      name: "architect_edit",
      description:
        "Change ONE file by DESCRIBING the change in plain language: a strong 'architect' model plans it in " +
        "prose and a cheaper 'editor' model produces the exact edits (applied via the flexible edit engine). " +
        "Use for a complex single-file change where stating intent is easier than writing the precise diff. " +
        "Costs ~2x model calls — not worth it for trivial one-liners. Pin the pair with OB1_ARCHITECT_MODEL / OB1_EDITOR_MODEL.",
      input_schema: { type: "object", properties: { file: { type: "string" }, instruction: { type: "string", description: "what to change, in plain language" } }, required: ["file", "instruction"] },
    },
    mutating: true,
    run: async ({ file, instruction }) => {
      const abs = safePath(cfg, file);
      const content = readFileSync(abs, "utf8");
      const archModel = process.env.OB1_ARCHITECT_MODEL || cfg.model;
      const edModel = process.env.OB1_EDITOR_MODEL || cfg.model;
      const r = await runArchitectEdit({ file, content, instruction, architect: (p) => askEditModel(cfg, archModel, p), editor: (p) => askEditModel(cfg, edModel, p) });
      if (r.mode === "whole") { writeFileSync(abs, r.whole!); return `architect_edit rewrote ${file} (whole-file, ${r.whole!.length} bytes) [architect ${archModel} → editor ${edModel}]`; }
      let cur = content, applied = 0;
      for (const b of r.blocks) { cur = applyFlexibleEdit(cur, b.search, b.replace, false).content; applied++; } // throws on a non-matching block → surfaced as a tool error
      writeFileSync(abs, cur);
      return `architect_edit applied ${applied} edit(s) to ${file} [architect ${archModel} → editor ${edModel}]`;
    },
  });

  // ── Delivery surface: database, secrets, PR/CI, public hosting ──────────────────────────────────

  // execute_sql — run SQL against a SQLite database file in the workspace. Reads return rows; writes are
  // approval-gated; whole-table DELETE/UPDATE and DROP/TRUNCATE are blocked unless allow_destructive:true.
  add({
    def: {
      name: "execute_sql",
      description:
        "Run SQL against a SQLite database file in the workspace (uses Bun's built-in SQLite — no setup; " +
        "the file is created if absent). A read (SELECT/PRAGMA/EXPLAIN) returns rows; INSERT/UPDATE/DELETE/" +
        "CREATE/ALTER mutate and pass the approval gate. SAFETY: a DROP/TRUNCATE, or a DELETE/UPDATE with NO " +
        "WHERE clause (whole-table), is REFUSED unless you set allow_destructive:true — prefer scoping with a " +
        "WHERE, and use migrations for schema changes. Default db file is `.ob1/app.db`; pass `db` for another.",
      input_schema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "the SQL statement(s) to run" },
          db: { type: "string", description: "sqlite file path relative to the workspace (default .ob1/app.db)" },
          allow_destructive: { type: "boolean", description: "required to run a DROP/TRUNCATE or an unscoped DELETE/UPDATE" },
        },
        required: ["sql"],
      },
    },
    // Mutating: writes are approval-gated and blocked in Plan mode. (A read SELECT also passes the gate in
    // "ask" mode — a small, safe cost; autopilot / a policy `allow` rule skip it. The destructive subset is
    // additionally tagged [destructive] via isDestructiveCall and hard-blocked at run time unless opted in.)
    mutating: true,
    run: ({ sql, db, allow_destructive }) => {
      if (typeof sql !== "string" || !sql.trim()) throw new Error("execute_sql needs a non-empty `sql` string");
      const kind = classifySql(sql);
      if (kind === "empty") return "execute_sql: empty statement.";
      if (kind === "destructive" && !allow_destructive) {
        throw new Error(`refused a ${/^\s*drop/i.test(sql) ? "DROP" : /^\s*truncate/i.test(sql) ? "TRUNCATE" : "whole-table DELETE/UPDATE"} — this is destructive. Add a WHERE clause to scope it, or pass allow_destructive:true if you really intend to wipe data.`);
      }
      const dbFile = (typeof db === "string" && db.trim()) ? db.trim() : ".ob1/app.db";
      const dbPath = safePath(cfg, dbFile); // keep the DB inside the workspace
      if (sqlMutates(sql)) mkdirSync(dirname(dbPath), { recursive: true });
      return formatSqlResult(runSqlite(cfg.cwd, dbFile, sql));
    },
  });

  // request_secret / check_secret — secure credential entry. Only meaningful when a secret store is wired
  // (interactive host); both still report on secrets already present in the environment.
  if (extras.secrets) {
    const secrets = extras.secrets;
    add({
      def: {
        name: "request_secret",
        description:
          "Ask the USER to provide a secret/credential (an API key, token, password) by name. The user types " +
          "it into a masked prompt — it is NEVER shown to you, logged, or written to disk — and it becomes " +
          "available to run_bash as an environment variable of that name. Use this instead of asking the user " +
          "to paste a key into the chat. Name it in UPPER_SNAKE_CASE (e.g. OPENAI_API_KEY, STRIPE_SECRET_KEY). " +
          "NEVER echo, print, or commit a secret's value. If it's already set, this is a no-op.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "UPPER_SNAKE_CASE env-var name for the secret" },
            reason: { type: "string", description: "short note shown to the user explaining why it's needed" },
          },
          required: ["name"],
        },
      },
      mutating: false, // gathers user input; touches no files (like ask_user)
      run: async ({ name, reason }) => {
        if (!SecretStore.validName(String(name ?? ""))) throw new Error(`invalid secret name "${name}" — use UPPER_SNAKE_CASE (e.g. OPENAI_API_KEY)`);
        if (secrets.has(name)) return `secret ${name} is already available (source: ${secrets.source(name)}); not re-requesting. It's exposed to run_bash as $${name}.`;
        const captured = await secrets.request(name, reason ? String(reason) : undefined);
        return captured
          ? `secret ${name} captured from the user and exposed to run_bash as $${name} (value hidden). Reference it as "$${name}" in commands; never print or commit it.`
          : `secret ${name} was not provided (the user cancelled or left it blank).`;
      },
    });
    add({
      def: {
        name: "check_secret",
        description: "Check whether a named secret is available (without revealing its value). Returns set/unset and where it came from. Use before a command that needs a credential.",
        input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
      mutating: false,
      run: ({ name }) => {
        const src = secrets.source(String(name ?? ""));
        return src === "missing" ? `secret ${name} is NOT set. Use request_secret to ask the user for it.` : `secret ${name} is available (source: ${src}); reference it as $${name} in run_bash. Value not shown.`;
      },
    });
  }

  // create_pr / pr_checks — open a GitHub PR and gate on CI. Both shell out to `gh`; they degrade with
  // actionable guidance when gh is absent. create_pr mutates (pushes a branch, opens a PR).
  add({
    def: {
      name: "create_pr",
      description:
        "Open a GitHub pull request for the current branch's work (via the `gh` CLI). Pushes the branch and " +
        "creates the PR with your title/body. It does NOT commit — stage & commit with run_bash first (it " +
        "refuses to open a PR with no commits ahead of base). If you're on the default branch it derives a " +
        "feature branch `ob1/<slug>` from the title; pass `branch` to choose one. Returns the PR URL. After " +
        "opening, poll pr_checks and don't call the task done until CI is green.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "PR title" },
          body: { type: "string", description: "PR description (markdown)" },
          base: { type: "string", description: "base branch to merge into (default: the repo's default branch)" },
          branch: { type: "string", description: "feature branch to use/create (default: current, or ob1/<slug> if on base)" },
          draft: { type: "boolean", description: "open as a draft PR" },
        },
        required: ["title"],
      },
    },
    mutating: true,
    run: (input) => createPr(input, { cwd: cfg.cwd }),
  });
  add({
    def: {
      name: "pr_checks",
      description:
        "Report the CI check status for a pull request (via `gh pr checks`). With wait:true it polls until " +
        "the checks finish (or timeout_s elapses). Use this as the completion gate: treat the task as done " +
        "only when this reports all checks passed. Defaults to the PR for the current branch.",
      input_schema: {
        type: "object",
        properties: {
          pr: { type: "string", description: "PR number or URL (default: the current branch's PR)" },
          wait: { type: "boolean", description: "poll until checks finish (default false)" },
          timeout_s: { type: "number", description: "max seconds to wait when wait:true (default 600, max 1800)" },
        },
      },
    },
    mutating: false, // read-only status poll
    run: ({ pr, wait, timeout_s }, ctx) => prChecks({ pr, wait, timeoutS: timeout_s }, { cwd: cfg.cwd }).then((s) => ctx?.signal?.aborted ? "pr_checks: aborted." : s),
  });

  // expose_port — public tunnel to a local server. Needs the process registry (interactive host) to track
  // the tunnel; mutating because it exposes a port to the public internet (an outward-facing side effect).
  add({
    def: {
      name: "expose_port",
      description:
        "Open a PUBLIC URL tunnelling to a local server (e.g. a dev server you started with run_bash " +
        "background). Auto-selects an installed tunnel client (cloudflared / localtunnel / localhost.run), " +
        "runs it in the background, and returns the public https URL — so a frontend/app can be tested via a " +
        "real URL, not just localhost. The tunnel is TEMPORARY (not production hosting). Start the server " +
        "first, then expose its port.",
      input_schema: {
        type: "object",
        properties: {
          port: { type: "number", description: "the local port to expose (the server must already be listening)" },
          provider: { type: "string", enum: ["cloudflared", "localtunnel", "localhost.run"], description: "force a specific tunnel client (default: first installed)" },
        },
        required: ["port"],
      },
    },
    mutating: true,
    destructive: false,
    run: ({ port, provider }, ctx) => exposePort(Number(port), { cwd: cfg.cwd, procs, signal: ctx?.signal }, provider),
  });

  return tools;
}

/** Heuristic: flag clearly dangerous shell commands so they always prompt. */
export function isDestructiveCall(name: string, input: any): boolean {
  // Semantic intent (rm/shred/dd/mkfs, git reset --hard / push --force / clean -fd, …) — richer and more
  // accurate than the old single regex, so the approval gate's [destructive] tag catches more real cases.
  if (name === "run_bash" && typeof input?.command === "string") return classifyIntent(input.command) === "destructive";
  // A destructive SQL statement (DROP/TRUNCATE or an unscoped DELETE/UPDATE) gets the [destructive] tag too.
  if (name === "execute_sql" && typeof input?.sql === "string") return classifySql(input.sql) === "destructive";
  return false;
}
