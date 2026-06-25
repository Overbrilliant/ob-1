// Ink (React) TUI — the rich interactive front-end (plan §11 stack: "Ink for streaming output,
// diff viewer, approval prompts, live token meter"). Used only on a TTY; piped/non-TTY input falls
// back to the readline REPL in index.ts.
//
// The agent loop is NOT React — so a TuiController bridges the two: app code pushes scrollback
// lines / stream deltas / token usage into the controller, the controller notifies subscribers,
// and <TuiApp> mirrors that state. Input flows back through controller.onSubmit.
import { useEffect, useReducer, useState, Component, type ReactNode } from "react";
import { render, Box, Text, Static, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { estimateCost, modelSpec, modelReasoning } from "../providers/models.ts";
import { costForUsage } from "../usage/log.ts";
import type { ProcRegistry, ProcInfo } from "../agent/procs.ts";
import type { AgentRegistry, AgentInfo } from "../agent/agent-registry.ts";
import type { TodoRegistry, TodoItem } from "../agent/todo-registry.ts";

export interface Status {
  model: string;
  mode: string;
  plan: boolean;
  inTok: number;
  outTok: number;
  cacheTok: number;
  ctxTok?: number;   // current context occupancy = the LAST request's full input size (≠ the cumulative inTok)
  autopilot?: boolean;
  resolvedModel?: string; // what a router alias (`auto`) actually resolved to, from the last response
  estTok?: boolean;       // the meter includes locally-estimated tokens (proxy returned no usage)
  effort?: "low" | "medium" | "high"; // reasoning effort for the active model (shown by the ⌃O hint)
  // Subscription: on a paid managed plan we show MONTHLY credit usage as a bar (like the context meter)
  // and hide the per-session $ amount (subscribers pay a flat plan, not per call). Unset on free/BYOK.
  subscribed?: boolean;
  monthUsed?: number;     // managed credits used this billing month
  monthCap?: number;      // monthly credit cap
}

interface ScrollItem { id: number; text: string; md?: boolean; dim?: boolean; code?: boolean; user?: boolean } // md = inline Markdown; dim = reasoning; code = inside a ``` fence (verbatim); user = a submitted prompt (grey bar)
type Pending = { desc: string; resolve: (b: boolean) => void } | null;

// Render a small subset of inline Markdown to ANSI so model replies show formatting in the terminal:
// **bold** → SGR bold, `code` → cyan, and an ATX "# heading" → bold line. Applied ONLY to model output
// (lines flagged md), never to command/tool output, so code and pre-formatted text are left intact.
export function mdToAnsi(line: string): string {
  const h = line.match(/^(\s*)#{1,6}\s+(.*)$/);
  let s = h ? `${h[1]}\x1b[1m${h[2]}\x1b[22m` : line;
  s = s.replace(/<br\s*\/?>/gi, " ");                      // <br> (common inside md tables) → space, not literal text
  s = s.replace(/`([^`]+)`/g, "\x1b[36m$1\x1b[39m");      // `inline code` → cyan
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "\x1b[1m$1\x1b[22m"); // **bold** → bold
  return s;
}

// A fenced ``` code line: a gray gutter + the code VERBATIM (no Markdown processing, so `backticks`,
// **stars**, and pipes inside code are left exactly as written).
const CODE_GUTTER = "\x1b[90m▏\x1b[39m ";
export function codeLine(text: string): string { return CODE_GUTTER + text; }
/** Is this line a ``` fence? Returns the language (may be "") when it is, else null. */
export function fenceLang(line: string): string | null {
  const m = line.match(/^\s*```+\s*([^\s`]*)\s*$/);
  return m ? m[1] : null;
}
/** A dim rule shown IN PLACE OF the raw ``` fence (with the language on the opening rule). */
export function fenceRule(lang: string, opening: boolean, cols = 80): string {
  const head = opening ? (lang ? `╭─ ${lang} ` : "╭─ ") : "╰─";
  const dashes = Math.max(2, Math.min(cols - 2, 72) - head.length);
  return `\x1b[90m${head}${"─".repeat(dashes)}\x1b[39m`;
}
/** The display string for a committed scroll line — handles code blocks, Markdown, and blank rows. */
export function renderScroll(it: ScrollItem): string {
  if (it.user) return it.text || " ";   // styled (grey bar) by the caller via <Text> props, not ANSI
  if (it.code) return codeLine(it.text || "");
  return (it.md ? mdToAnsi(it.text) : it.text) || " ";
}

// ─── Markdown tables → aligned box-drawn tables ───────────────────────────────
// The model streams a GFM table as separate lines (header · `|---|` separator · rows). Those can't be
// aligned one-line-at-a-time, so the controller BUFFERS consecutive pipe lines and renders the block
// here once it's complete. Pure + exported for tests.
const G = (s: string) => `\x1b[90m${s}\x1b[39m`;            // dim gray (borders)
function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
/** A GFM separator row: every cell is dashes with optional leading/trailing colons (alignment). */
export function isTableSeparator(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s+/g, "")));
}
const cellPlain = (s: string): string => s.replace(/\*\*/g, "").replace(/`/g, ""); // display width (markers gone)
/** Render buffered pipe lines as an aligned, box-drawn table — or null if they aren't a real table
 *  (no `|---|` separator on the 2nd line), so the caller can fall back to plain text. */
export function renderTable(rows: string[], maxColWidth = 60): string[] | null {
  if (rows.length < 2 || !isTableSeparator(rows[1])) return null;
  const header = splitCells(rows[0]);
  const aligns = splitCells(rows[1]).map((c) => {
    const t = c.replace(/\s+/g, ""), l = t.startsWith(":"), r = t.endsWith(":");
    return l && r ? "c" : r ? "r" : "l";
  });
  const body = rows.slice(2).map(splitCells);
  const ncol = Math.max(header.length, aligns.length, ...body.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < ncol; i++) {
    let w = cellPlain(header[i] ?? "").length;
    for (const r of body) w = Math.max(w, cellPlain(r[i] ?? "").length);
    widths[i] = Math.min(Math.max(w, 1), maxColWidth);
  }
  const cell = (raw: string, i: number): string => {
    const plain = cellPlain(raw ?? "");
    let render: string, len: number;
    if (plain.length > widths[i]) { const t = plain.slice(0, widths[i] - 1) + "…"; render = t; len = t.length; }
    else { render = mdToAnsi(raw ?? ""); len = plain.length; }
    const gap = Math.max(0, widths[i] - len), a = aligns[i] ?? "l";
    if (a === "r") return " ".repeat(gap) + render;
    if (a === "c") { const lft = Math.floor(gap / 2); return " ".repeat(lft) + render + " ".repeat(gap - lft); }
    return render + " ".repeat(gap);
  };
  const bar = (l: string, m: string, r: string) => G(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const sep = G("│");
  const rowLine = (cells: string[], bold: boolean) =>
    `${sep} ` + widths.map((_, i) => { const c = cell(cells[i] ?? "", i); return bold ? `\x1b[1m${c}\x1b[22m` : c; }).join(` ${sep} `) + ` ${sep}`;
  return [bar("┌", "┬", "┐"), rowLine(header, true), bar("├", "┼", "┤"), ...body.map((r) => rowLine(r, false)), bar("└", "┴", "┘")];
}
export interface PickItem { label: string; hint?: string; value: string }
type Picker = { title: string; items: PickItem[]; index: number; resolve: (v: string | null) => void } | null;

// Clarification question (ask_user). A radio (single) / checkbox (multi) list with a synthetic final
// row — the free-text escape hatch — at index === options.length. `index` walks [0 .. options.length];
// `checked` holds ticked option indices (multi); `editing` swaps the free-text row for a text input.
export interface AskOpt { label: string; description?: string }
// One question of a group. `progress` (e.g. {n:1,total:3}) shows a "1/3" counter when batched.
export type AskReq = { question: string; header?: string; options: AskOpt[]; multi?: boolean; progress?: { n: number; total: number } };
type Ask =
  | (AskReq & { index: number; checked: Set<number>; editing: boolean; freeText: string; resolve: (a: string | null) => void })
  | null;

// Provider setup tab (reached via /models). A focused full-frame form: an explanatory blurb (so users know what
// they're connecting to), a Local/Remote location toggle, URL + key text fields, a live "Test
// connection" action, and Save / Cancel. Opened by index.ts via ctrl.providerSetup(); resolves with the
// entered {url, key} on Save or null on Cancel/Esc.
export interface ProviderSetupOpts {
  title: string;
  blurb: string[];
  presets: { label: string; hint: string; url: string }[];
  keyPrefix?: string;
  initialUrl: string;
  initialKey: string;
  /** Probe the endpoint; returns a human-readable status line (✓ … / ✗ …) shown under the form. */
  onTest: (url: string, key: string) => Promise<string>;
}
export type ProviderSetupResult = { url: string; key: string } | null;
type SetupRow = "location" | "url" | "key" | "test" | "save" | "cancel";
type Setup =
  | (ProviderSetupOpts & { presetIndex: number; url: string; key: string; index: number; editing: null | "url" | "key"; status: string; testing: boolean; resolve: (r: ProviderSetupResult) => void })
  | null;

// Inline single-field text prompt (Settings → Free LLM API managed setup). A focused box with a label +
// one text field; Enter submits (returns the text), Esc cancels (returns null). `mask` hides input for
// passwords. Opened via ctrl.promptOpen(); the <TextInput> owns typing while it's up.
export interface PromptOpts { title: string; question: string; mask?: boolean; placeholder?: string }
type Prompt = (PromptOpts & { value: string; resolve: (s: string | null) => void }) | null;

/** ⌃C arm window: a second ⌃C within this many ms exits; otherwise the first press "expires" and the
 *  next ⌃C re-arms instead of exiting. Keeps exit to a deliberate double-tap. */
const EXIT_ARM_MS = 2500;

export class TuiController {
  lines: ScrollItem[] = [];
  streaming = "";
  status: Status;
  pending: Pending = null;
  picker: Picker = null;
  busy = false;
  stopping = false;       // ESC pressed: aborting the turn — shown in the footer until the turn actually ends
  exited = false;
  exitArmed = false;      // ⌃C two-stage: armed by the first press, exits on a second within the window
  showReasoning = false;  // Ctrl+O toggles whether the model's reasoning/thinking is shown
  reasoning = "";         // trailing partial reasoning line (live region) when showReasoning is on
  cancelTurn: (() => void) | null = null; // set by the drain loop while a turn runs; ESC calls it
  queue: string[] = [];   // prompts submitted while busy — drained in order when the turn frees up
  suggestion = "";        // a proposed next prompt (update_tasks-style ghost): shown as the placeholder, Tab accepts
  genChars = 0;           // chars streamed this turn (a live ~token approximation for the loader)
  spinnerFrame = 0;       // advances on a timer while busy → the loader spins even during waits
  private busyTimer: ReturnType<typeof setInterval> | null = null;
  onSubmit?: (line: string) => void | Promise<void>;
  // Prefill the input box with text + move the cursor to the end (registered by <TuiApp>). Used by
  // /rewind to drop the rewound prompt back into the input so the user can re-edit / re-run it.
  setInput?: (text: string) => void;
  private seq = 0;
  private listeners = new Set<() => void>();
  // Render coalescing (see emit): streaming fires one emit per token; rendering each repaints the whole
  // terminal hundreds of times/sec and pegs the CPU. Batch bursts into ~25fps frames. Tunable via
  // OB1_RENDER_FRAME_MS (0 = render synchronously, no batching — used by tests for deterministic frames).
  private readonly frameMs = Math.max(0, Number(process.env.OB1_RENDER_FRAME_MS ?? 40));
  private renderScheduled = false;
  private lastRenderAt = 0;

  procReg?: ProcRegistry;  // running run_bash processes (footer indicator + ⌃P manager)
  procFocus = false;       // ⌃P opened the process manager (captures ↑↓ / x / Esc)
  procIndex = 0;
  agentReg?: AgentRegistry; // spawned subagents (footer indicator + live progress panel)
  todoReg?: TodoRegistry;   // the agent's task list (update_tasks tool) — rendered above the input
  constructor(status: Status, procs?: ProcRegistry, agents?: AgentRegistry, todos?: TodoRegistry) {
    this.status = status;
    if (procs) {
      this.procReg = procs;
      // Re-render on any process add/remove/kill; auto-close the manager once nothing is left.
      procs.subscribe(() => { if (procs.size === 0) this.procFocus = false; this.procIndex = Math.min(this.procIndex, Math.max(0, procs.size - 1)); this.emit(); });
    }
    if (agents) { this.agentReg = agents; agents.subscribe(() => this.emit()); } // re-render as each subagent advances
    if (todos) { this.todoReg = todos; todos.subscribe(() => this.emit()); }     // re-render as tasks are added/checked off
  }
  todoList(): TodoItem[] { return this.todoReg?.list() ?? []; }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  // Coalesce bursty updates into at most one render per frame (leading + trailing edge), so a fast
  // token stream can't trigger hundreds of full-screen repaints a second. The latest state always
  // renders within frameMs; visually imperceptible for streaming text, ~4–10× fewer repaints.
  private emit(): void {
    if (this.frameMs === 0) { this.lastRenderAt = Date.now(); for (const l of this.listeners) l(); return; } // synchronous (tests)
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const since = Date.now() - this.lastRenderAt;
    const wait = since >= this.frameMs ? 0 : this.frameMs - since;
    setTimeout(() => {
      this.renderScheduled = false;
      this.lastRenderAt = Date.now();
      for (const l of this.listeners) l();
    }, wait);
  }

  // ─── Turn buffer ───────────────────────────────────────────────────────────
  // While a turn runs (busy), committed lines go to `pending`, NOT to the <Static> scrollback. They're
  // rendered in a bounded live viewport above the pinned input box. Appending to <Static> one line at a
  // time (as the model streams) makes Ink rewrite the dynamic region below it on every append, and once
  // the output overflows the terminal each rewrite leaves a DUPLICATED input box in the scrollback (and
  // the response appears to vanish). Buffering the turn and flushing it to <Static> in ONE bulk append at
  // the end renders cleanly — Ink writes all the rows, then repositions the dynamic region once.
  turnBuf: ScrollItem[] = [];
  private commitItem(it: ScrollItem): void { (this.busy ? this.turnBuf : this.lines).push(it); }
  /** Move the finished turn's buffered lines into the permanent <Static> scrollback (one bulk append). */
  private flushTurnBuf(): void { if (this.turnBuf.length) { this.lines.push(...this.turnBuf); this.turnBuf = []; } }

  pushLine = (s: string): void => {
    for (const part of String(s).split("\n")) this.commitItem({ id: this.seq++, text: part });
    this.emit();
  };
  // A submitted prompt — committed as `user` lines so the TUI renders them as a grey bar with white
  // text (distinct from the model's output). "› " prefixes the first line; continuations are indented.
  pushUser = (s: string): void => {
    this.lastErrorAction = undefined; this.errorFocus = false; // a new prompt supersedes the previous error's action
    String(s).split("\n").forEach((part, i) => this.commitItem({ id: this.seq++, text: (i === 0 ? "› " : "  ") + part, user: true }));
    this.emit();
  };
  // One blank line BEFORE a stream block (user message · response · tool call) for even spacing between
  // everything in the transcript. Deduped: never doubles a blank, and never leads with one when empty.
  gap = (): void => {
    const arr = this.busy ? this.turnBuf : this.lines;
    const ref = arr.length ? arr : this.lines;     // empty buffer → check the scrollback's last line
    const last = ref[ref.length - 1];
    if (!last || last.text === "") return;          // nothing yet, or already blank → no separator
    arr.push({ id: this.seq++, text: "" });
    this.emit();
  };
  private tableBuf: string[] = []; // consecutive pipe lines held back until the table block completes

  // ─── Reasoning channel (Ctrl+O) ───────────────────────────────────────────
  // Reasoning deltas arrive BEFORE the answer. When showReasoning is on they stream to scrollback as
  // dim "▏ …" lines; when off they're dropped (ephemeral — never stored in history). Toggling on
  // mid-turn reveals the rest of the current reasoning.
  reasoningDelta = (delta: string): void => {
    if (!this.showReasoning) return;
    this.reasoning += delta;
    let nl: number;
    while ((nl = this.reasoning.indexOf("\n")) >= 0) {
      this.commitItem({ id: this.seq++, text: "▏ " + this.reasoning.slice(0, nl), dim: true });
      this.reasoning = this.reasoning.slice(nl + 1);
    }
    this.emit();
  };
  endReasoning = (): void => {
    if (this.reasoning) { this.commitItem({ id: this.seq++, text: "▏ " + this.reasoning, dim: true }); this.reasoning = ""; this.emit(); }
  };
  toggleReasoning = (): void => {
    this.showReasoning = !this.showReasoning;
    if (!this.showReasoning) this.endReasoning(); // commit whatever was shown so far
    this.emit();
  };

  stream = (delta: string): void => {
    this.endReasoning(); // answer text started → commit any trailing reasoning line first
    this.streaming += delta;
    this.genChars += delta.length;
    // Commit COMPLETED lines to scrollback as they arrive, keeping only the trailing partial line
    // in the live region. A tall, then-shrinking live region makes Ink's <Static> erase walk up
    // INTO already-committed rows and wipe them (the "response vanishes" bug) — so the live region
    // must stay ~one line tall.
    let nl: number;
    while ((nl = this.streaming.indexOf("\n")) >= 0) {
      this.commitStreamLine(this.streaming.slice(0, nl));
      this.streaming = this.streaming.slice(nl + 1);
    }
    this.emit();
  };
  inCode = false; // currently between ``` fences in the streamed answer (public: the live partial reads it)
  // A pipe line is held in tableBuf (we can't align a table until it's whole); any other line first
  // flushes the buffer (rendering the table) and is then committed as normal Markdown. Inside a ``` fence
  // the line is committed VERBATIM (no table/Markdown handling) so code isn't mangled, and the raw fence
  // itself is replaced by a dim rule.
  private commitStreamLine = (line: string): void => {
    const lang = fenceLang(line);
    if (lang !== null) {                       // ``` fence → toggle code mode, show a rule instead
      this.flushTableBuf();
      const opening = !this.inCode;
      this.inCode = opening;
      this.commitItem({ id: this.seq++, text: fenceRule(lang, opening, process.stdout.columns || 80) });
      return;
    }
    if (this.inCode) { this.commitItem({ id: this.seq++, text: line, code: true }); return; }
    if (line.includes("|")) { this.tableBuf.push(line); return; }
    this.flushTableBuf();
    this.commitItem({ id: this.seq++, text: line, md: true });
  };
  private flushTableBuf = (): void => {
    if (!this.tableBuf.length) return;
    const buf = this.tableBuf;
    this.tableBuf = [];
    const rendered = renderTable(buf);
    if (rendered) for (const r of rendered) this.commitItem({ id: this.seq++, text: r, md: false }); // already ANSI
    else for (const raw of buf) this.commitItem({ id: this.seq++, text: raw, md: true });             // not a table → plain
  };
  endStream = (): void => {
    if (this.streaming) { this.commitStreamLine(this.streaming); this.streaming = ""; }
    this.flushTableBuf();
    this.inCode = false; // reset fence state between responses (also closes an unterminated block)
    this.emit();
  };
  setStatus = (p: Partial<Status>): void => { this.status = { ...this.status, ...p }; this.emit(); };
  /** Set the current context occupancy (the LAST request's full input size) for the footer context bar. */
  setContext = (ctxTok: number): void => { this.status.ctxTok = ctxTok; this.emit(); };
  /** Update the footer's subscription state: a paid plan shows monthly credit usage as a bar (and hides
   *  the $ cost); free/BYOK clears it (subscribed=false) and the $ cost stays. */
  setSubscription = (subscribed: boolean, monthUsed?: number, monthCap?: number): void => {
    this.status.subscribed = subscribed; this.status.monthUsed = monthUsed; this.status.monthCap = monthCap; this.emit();
  };
  addTokens = (inTok: number, outTok: number, cacheTok = 0): void => {
    this.status.inTok += inTok; this.status.outTok += outTok; this.status.cacheTok += cacheTok; this.emit();
  };
  approve = (desc: string): Promise<boolean> => new Promise((resolve) => { this.pending = { desc, resolve }; this.emit(); });
  answer = (b: boolean): void => { const p = this.pending; this.pending = null; this.emit(); p?.resolve(b); };
  setBusy = (b: boolean): void => {
    // Turn ending → flush the buffered turn into <Static> in one clean bulk append (see turnBuf).
    if (!b) { this.flushTableBuf(); this.flushTurnBuf(); this.stopping = false; }
    this.busy = b;
    if (b) {
      this.genChars = 0; this.spinnerFrame = 0;
      // Animate the loader while busy: a steady tick advances the spinner (so it moves even during
      // waits — when no deltas arrive) and re-renders so the live token counter climbs. Safe now that a
      // turn's output is buffered in turnBuf — the <Static> scrollback does NOT grow mid-turn, so the
      // dynamic region re-rendering on a timer can't trigger the overflow-duplication bug that the old
      // (pre-turnBuf) spinner did.
      if (!this.busyTimer) this.busyTimer = setInterval(() => { this.spinnerFrame++; this.emit(); }, 120);
    } else if (this.busyTimer) {
      clearInterval(this.busyTimer); this.busyTimer = null;
    }
    this.emit();
  };
  // Next-step suggestion (generated after a turn by the current model): shown as the input placeholder
  // until the user types; Tab accepts it. Cleared when a new turn starts or the suggestion is taken.
  setSuggestion = (s: string): void => { this.suggestion = s; this.emit(); };
  clearSuggestion = (): void => { if (this.suggestion) { this.suggestion = ""; this.emit(); } };
  enqueue = (s: string): void => { this.queue.push(s); this.emit(); };
  dequeue = (): string | undefined => { const s = this.queue.shift(); if (s !== undefined) this.emit(); return s; };
  exit = (): void => { if (this.busyTimer) { clearInterval(this.busyTimer); this.busyTimer = null; } this.disarmExit(); this.exited = true; this.emit(); };
  // ESC → abort the running turn + clear the queue. Flip `stopping` first so the footer shows "stopping…"
  // the instant the key is pressed — feedback that the abort registered even while a tool unwinds (a
  // browser closing, a bash dying). Idempotent: a second ESC while already stopping is a no-op.
  requestCancel = (): void => {
    if (this.stopping) return;                            // already aborting — ignore a repeat ESC
    if (this.busy) { this.stopping = true; this.emit(); } // show "stopping…" while a tool unwinds (cosmetic; only renders mid-turn)
    this.cancelTurn?.();                                  // always fire the handle — the drain loop nulls it when idle
  };

  // ── ⌃C two-stage exit ───────────────────────────────────────────────────────
  // ⌃C must "always be twice in a row": the first press ARMS exit and shows a hint that auto-clears
  // after a short window; only a SECOND ⌃C while still armed actually leaves. Works from anywhere — the
  // input box AND any picker/approval/setup/process frame — so there's always a way out. (A non-empty
  // MAIN prompt is cleared by the caller before this is reached, so ⌃C-on-text never arms/exits.)
  private exitArmTimer: ReturnType<typeof setTimeout> | null = null;
  armOrExit = (): void => {
    if (this.exitArmed) {                 // second press within the window → leave for real
      this.cancelTurn?.();                // abort any in-flight turn + clear the queue
      this.procReg?.killAll();            // and any running bash before we go
      this.exit();
      return;
    }
    this.exitArmed = true; this.emit();
    if (this.exitArmTimer) clearTimeout(this.exitArmTimer);
    this.exitArmTimer = setTimeout(() => { this.exitArmTimer = null; this.exitArmed = false; this.emit(); }, EXIT_ARM_MS);
  };
  disarmExit = (): void => {
    if (this.exitArmTimer) { clearTimeout(this.exitArmTimer); this.exitArmTimer = null; }
    if (this.exitArmed) { this.exitArmed = false; this.emit(); }
  };

  // A render error was caught by the boundary — record it to scrollback (deferred so we don't dispatch
  // during React's commit phase) so the user sees what happened after recovery. Best-effort.
  reportRenderError = (err: unknown): void => {
    const msg = (err as Error)?.message ?? String(err);
    queueMicrotask(() => { try { this.pushLine("\x1b[31m  ⚠ UI render error (recovered): " + msg.slice(0, 200) + "\x1b[39m"); } catch { /* ignore */ } });
  };

  // Interactive list picker — used by /models and /settings. Resolves with the chosen value (or
  // null on Esc). The arrow/Enter/Esc keys are handled by a dedicated useInput in <TuiApp>.
  pick = (title: string, items: PickItem[], current?: string): Promise<string | null> =>
    new Promise((resolve) => {
      const idx = items.findIndex((i) => i.value === current);
      this.picker = { title, items, index: idx >= 0 ? idx : 0, resolve };
      this.emit();
    });
  pickerMove = (delta: number): void => {
    if (!this.picker) return;
    const n = this.picker.items.length;
    this.picker.index = (this.picker.index + delta + n) % n;
    this.emit();
  };
  // Why the last picker closed. /settings reads this to tell ← (back to the menu) from Esc (leave
  // settings): both still resolve the SAME way (a value on select, null on back/escape) — the reason
  // is a SEPARATE channel so plain consumers (/models, /skill, …) are unaffected.
  pickerDismiss: "select" | "back" | "escape" = "select";
  pickerConfirm = (): void => { const p = this.picker; if (!p) return; this.picker = null; this.pickerDismiss = "select"; this.emit(); p.resolve(p.items[p.index]?.value ?? null); };
  pickerBack = (): void => { const p = this.picker; if (!p) return; this.picker = null; this.pickerDismiss = "back"; this.emit(); p.resolve(null); };   // ← : up one level
  pickerCancel = (): void => { const p = this.picker; if (!p) return; this.picker = null; this.pickerDismiss = "escape"; this.emit(); p.resolve(null); }; // Esc : close/leave

  // ─── Clarification question (ask_user) ─────────────────────────────────────
  ask: Ask = null;
  askUser = (req: AskReq): Promise<string | null> =>
    new Promise((resolve) => {
      this.ask = { ...req, options: req.options.slice(), index: 0, checked: new Set(), editing: false, freeText: "", resolve };
      this.emit();
    });
  private askFree(): number { return this.ask ? this.ask.options.length : -1; } // the free-text row index
  private askResolve(answer: string | null): void { const a = this.ask; if (!a) return; this.ask = null; this.emit(); a.resolve(answer); }
  askMove = (delta: number): void => {
    const a = this.ask; if (!a || a.editing) return;
    const n = a.options.length + 1; // options + the free-text row
    a.index = (a.index + delta + n) % n; this.emit();
  };
  // Space (multi only): tick/untick the highlighted box; on the free-text row, open the editor instead.
  askToggle = (): void => {
    const a = this.ask; if (!a || a.editing) return;
    if (a.index === this.askFree()) { a.editing = true; this.emit(); return; }
    if (a.multi) { if (a.checked.has(a.index)) a.checked.delete(a.index); else a.checked.add(a.index); this.emit(); }
  };
  // Enter / →: single → select the highlighted option (or open the editor on the free-text row);
  //            multi  → confirm the ticked set (free-text row: edit if empty, else confirm).
  askEnter = (): void => {
    const a = this.ask; if (!a || a.editing) return;
    const free = this.askFree();
    if (a.index === free) {
      if (a.multi && a.freeText.trim()) { this.askConfirm(); return; } // text already entered → confirm
      a.editing = true; this.emit(); return;                           // otherwise type the answer
    }
    if (a.multi) { this.askConfirm(); return; }
    this.askResolve(a.options[a.index].label);
  };
  // Multi: resolve with every ticked option label, plus the free-text answer when present.
  askConfirm = (): void => {
    const a = this.ask; if (!a) return;
    const labels = [...a.checked].filter((i) => i < a.options.length).sort((x, y) => x - y).map((i) => a.options[i].label);
    if (a.freeText.trim()) labels.push(a.freeText.trim());
    this.askResolve(labels.length ? labels.join(", ") : "(no option selected)");
  };
  askEditChange = (v: string): void => { const a = this.ask; if (!a) return; a.freeText = v; this.emit(); };
  askEditSubmit = (): void => {
    const a = this.ask; if (!a) return;
    const text = a.freeText.trim(); a.editing = false;
    if (a.multi) { if (text) a.checked.add(this.askFree()); else a.checked.delete(this.askFree()); this.emit(); } // ticks the free-text row
    else this.askResolve(text || "(no answer)"); // single: finishing the text IS the answer
  };
  askEditCancel = (): void => { const a = this.ask; if (!a) return; a.editing = false; this.emit(); }; // Esc in the editor → back to the list
  askCancel = (): void => { this.askResolve(null); }; // ←/Esc on the list → dismissed

  // ─── Provider setup tab (reached via /models) ────────────────────────────────────────
  setup: Setup = null;
  /** Ordered list of navigable rows for the current form (the location row is dropped when there are
   *  no presets). The cursor (setup.index) indexes into this. */
  setupRowKinds = (): SetupRow[] => {
    const s = this.setup; if (!s) return [];
    return [...(s.presets.length ? ["location" as const] : []), "url", "key", "test", "save", "cancel"];
  };
  providerSetup = (opts: ProviderSetupOpts): Promise<ProviderSetupResult> =>
    new Promise((resolve) => {
      this.setup = { ...opts, presetIndex: 0, url: opts.initialUrl, key: opts.initialKey, index: 0, editing: null, status: "", testing: false, resolve };
      this.emit();
    });
  private setupResolve(r: ProviderSetupResult): void { const s = this.setup; if (!s) return; this.setup = null; this.emit(); s.resolve(r); }
  setupMove = (delta: number): void => {
    const s = this.setup; if (!s || s.editing) return;
    const n = this.setupRowKinds().length;
    s.index = (s.index + delta + n) % n; this.emit();
  };
  // ←/→ on the location row cycles the Local/Remote presets and applies that preset's URL.
  setupCycle = (delta: number): void => {
    const s = this.setup; if (!s || s.editing) return;
    if (this.setupRowKinds()[s.index] !== "location" || !s.presets.length) return;
    const n = s.presets.length;
    s.presetIndex = (s.presetIndex + delta + n) % n;
    s.url = s.presets[s.presetIndex].url; s.status = ""; this.emit();
  };
  // Enter / → on a row: url/key → open the text editor; test → probe; save/cancel → resolve.
  setupActivate = (): void => {
    const s = this.setup; if (!s || s.editing) return;
    const row = this.setupRowKinds()[s.index];
    if (row === "url") { s.editing = "url"; this.emit(); }
    else if (row === "key") { s.editing = "key"; this.emit(); }
    else if (row === "test") void this.setupRunTest();
    else if (row === "save") {
      if (!s.url.trim() || !s.key.trim()) { s.status = "enter a URL and a key first"; this.emit(); return; }
      this.setupResolve({ url: s.url.trim(), key: s.key.trim() });
    } else if (row === "cancel") this.setupResolve(null);
  };
  setupEditChange = (v: string): void => { const s = this.setup; if (!s || !s.editing) return; if (s.editing === "url") s.url = v; else s.key = v; this.emit(); };
  setupEditSubmit = (): void => { const s = this.setup; if (!s) return; s.editing = null; s.status = ""; this.emit(); };
  setupEditCancel = (): void => { const s = this.setup; if (!s) return; s.editing = null; this.emit(); };
  private async setupRunTest(): Promise<void> {
    const s = this.setup; if (!s) return;
    if (!s.url.trim() || !s.key.trim()) { s.status = "enter a URL and a key first"; this.emit(); return; }
    s.testing = true; s.status = "testing connection…"; this.emit();
    let result = "";
    try { result = await s.onTest(s.url.trim(), s.key.trim()); } catch (e: any) { result = "✗ " + (e?.message ?? "test failed"); }
    if (this.setup !== s) return; // form was cancelled while the probe was in flight
    s.testing = false; s.status = result; this.emit();
  }
  setupCancel = (): void => { this.setupResolve(null); };

  // ─── Inline text prompt (Settings → Free LLM API managed setup) ──────────────
  prompt: Prompt = null;
  promptOpen = (opts: PromptOpts): Promise<string | null> =>
    new Promise((resolve) => { this.prompt = { ...opts, value: "", resolve }; this.emit(); });
  private promptDone(v: string | null): void { const p = this.prompt; if (!p) return; this.prompt = null; this.emit(); p.resolve(v); }
  promptChange = (v: string): void => { const p = this.prompt; if (!p) return; p.value = v; this.emit(); };
  promptSubmit = (): void => { const p = this.prompt; if (!p) return; this.promptDone(p.value); };
  promptCancel = (): void => { this.promptDone(null); };

  // ─── Subagent progress (footer indicator + live panel) ─────────────────────
  agentList = (): AgentInfo[] => this.agentReg?.list() ?? [];
  agentsRunning = (): number => this.agentReg?.runningCount ?? 0;

  // ─── Running-process manager (⌃P) ──────────────────────────────────────────
  procList = (): ProcInfo[] => this.procReg?.list() ?? [];
  // ⌃P toggles the manager. Only opens when there's something to manage (no empty panel).
  toggleProcs = (): void => {
    if (this.procFocus) { this.procFocus = false; this.emit(); return; }
    if ((this.procReg?.size ?? 0) === 0) return;
    this.procFocus = true; this.procIndex = 0; this.emit();
  };
  closeProcs = (): void => { if (this.procFocus) { this.procFocus = false; this.emit(); } };
  procMove = (delta: number): void => {
    const n = this.procList().length; if (!n) return;
    this.procIndex = (this.procIndex + delta + n) % n; this.emit();
  };
  procKill = (): void => {
    const list = this.procList(); if (!list.length) return;
    const p = list[Math.min(this.procIndex, list.length - 1)];
    if (p) this.procReg?.kill(p.id); // SIGTERM, then SIGKILL on a second x; removal happens when it exits
  };

  // ─── "Get Intelligent Models" upsell (footer button) ───────────────────────
  // A prominent footer call-to-action shown ONLY on the OB-1-managed Free LLM API provider (free models
  // only). From the input box, ↓ moves focus onto the button and ↑ returns; Enter opens the pricing page
  // in the browser. Both hooks are injected by index.ts so this file stays free of config/browser deps.
  upsellEligible: () => boolean = () => false; // index.ts: cfg.providerProfile === "freellmapi"
  onUpsell: () => void = () => {};             // index.ts: open the pricing page in the browser
  upsellFocus = false;                         // ↓ from the input gives the button focus; ↑/Esc returns
  focusUpsell = (): void => { if (!this.upsellFocus && this.upsellEligible()) { this.upsellFocus = true; this.emit(); } };
  blurUpsell = (): void => { if (this.upsellFocus) { this.upsellFocus = false; this.emit(); } };
  activateUpsell = (): void => { this.upsellFocus = false; this.emit(); this.onUpsell(); };

  // ─── Most-recent error action (↑ from the input) ────────────────────────────
  // When a turn ends in an actionable error (e.g. a 402 carrying an "Upgrade your plan" link), that action
  // is parked here. From an empty prompt the user presses ↑ to focus it and Enter to open it in the
  // browser — a keyboard path to the same link that's clickable inline. Superseded by the next prompt.
  onErrorAction: (url: string) => void = () => {};    // index.ts: open the url in the browser
  lastErrorAction?: { label: string; url: string };
  errorFocus = false;                                 // ↑ from the input gives the action button focus
  setErrorAction = (a?: { label: string; url: string }): void => { this.lastErrorAction = a; this.errorFocus = false; this.emit(); };
  focusErrorAction = (): void => { if (!this.errorFocus && this.lastErrorAction) { this.errorFocus = true; this.emit(); } };
  blurErrorAction = (): void => { if (this.errorFocus) { this.errorFocus = false; this.emit(); } };
  activateErrorAction = (): void => { const a = this.lastErrorAction; this.errorFocus = false; this.emit(); if (a) this.onErrorAction(a.url); };
}

function modeColor(mode: string): string {
  return mode === "fusion" ? "blue" : mode === "council" ? "magenta" : mode === "personas" ? "cyan" : mode === "adaptive" ? "green" : "gray";
}

// Context-usage bar: how much of the MODEL's context window the current conversation occupies.
// Filled portion + percentage are colored green <80% · yellow <90% · red ≥90% (the user's thresholds).
const CTX_BAR_WIDTH = 8;
export function contextBar(used: number, total: number): { filled: number; empty: number; pct: number; color: string } {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const filled = Math.max(0, Math.min(CTX_BAR_WIDTH, Math.round((pct / 100) * CTX_BAR_WIDTH)));
  const color = pct >= 90 ? "red" : pct >= 80 ? "yellow" : "green";
  return { filled, empty: CTX_BAR_WIDTH - filled, pct, color };
}

/** A REMAINING-credits bar for subscribers: the fill ∝ credits LEFT this month (so it DRAINS as you
 *  spend), and the color warns as the balance runs low — green, yellow ≤20% left, red ≤10% left. pct is
 *  the percent REMAINING. Inverse of contextBar, whose fill grows toward a danger ceiling. */
export function remainingBar(used: number, cap: number): { filled: number; empty: number; pct: number; color: string } {
  const remaining = Math.max(0, cap - used);
  const pct = cap > 0 ? Math.max(0, Math.min(100, Math.round((remaining / cap) * 100))) : 0;
  const filled = Math.max(0, Math.min(CTX_BAR_WIDTH, Math.round((pct / 100) * CTX_BAR_WIDTH)));
  const color = pct <= 10 ? "red" : pct <= 20 ? "yellow" : "green";
  return { filled, empty: CTX_BAR_WIDTH - filled, pct, color };
}

/** Keep a live-region partial to a single terminal row: show the TAIL (newest text) with a leading "…"
 *  when truncated. Operates on the RAW text (before mdToAnsi/codeLine add escape codes) so the width is
 *  the visible width. A partial has no newline yet, so this never hides committed scrollback. */
export function clipToRow(s: string, width: number): string {
  const w = Math.max(8, width);
  return s.length > w ? "…" + s.slice(-(w - 1)) : s;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; // braille spinner frames for the busy loader
/** A short, climbing token count for the loader (e.g. "342" then "1.2k"). Live estimate ≈ chars/4. */
function tokStr(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function StatusBar({ s, reasoning, procs, agents, busy, stopping, genChars = 0, spin = 0 }: { s: Status; reasoning?: boolean; procs?: number; agents?: number; busy?: boolean; stopping?: boolean; genChars?: number; spin?: number }) {
  // When a router alias (`auto`) resolved to a concrete model, use THAT for pricing/context lookups and
  // show "auto → <label>" so the meter comes alive instead of reading "unknown model".
  const specModel = s.resolvedModel || s.model;
  const modelLabel = s.resolvedModel ? `${s.model} → ${modelSpec(s.resolvedModel)?.label ?? s.resolvedModel}` : s.model;
  // Subscribers (paid managed plan) see MONTHLY credit usage as a bar instead of a per-session $ amount —
  // they pay a flat plan, so the dollar figure is meaningless to them. Free/BYOK keep the $ cost.
  const subscribed = !!s.subscribed && (s.monthCap ?? 0) > 0;
  // inTok is the UNCACHED input; cached tokens still bill (~0.25× input) so fold them in at the cache
  // rate — otherwise the live cost understates a cache-heavy session.
  const cost = costForUsage(specModel, s.inTok, s.outTok, s.cacheTok);
  const meter = `${(s.inTok / 1000).toFixed(1)}k in · ${(s.outTok / 1000).toFixed(1)}k out` +
    (s.cacheTok ? ` · ${(s.cacheTok / 1000).toFixed(1)}k cached` : "") +
    (!subscribed && cost ? ` · ~$${cost.toFixed(4)}` : "") + // subscribers see the usage bar, not a $ amount
    (s.estTok ? " (est)" : "");
  // Context window from the model registry (all current models ~1M); occupancy = the last request's input.
  const ctxWindow = modelSpec(specModel)?.contextWindow ?? 0;
  const ctx = ctxWindow > 0 ? contextBar(s.ctxTok ?? 0, ctxWindow) : null;
  // Monthly credits REMAINING as a bar: fills with what's left and drains as the plan's credits are
  // spent (yellow/red as it runs low). Shown only for subscribers; refills each billing cycle.
  const credits = subscribed ? remainingBar(s.monthUsed ?? 0, s.monthCap!) : null;
  // Borderless footer status line (the border now lives on the input box below). While busy it shows an
  // animated spinner + a live ~token counter that CLIMBS as text streams (genChars/4) — both update via
  // the controller's busy timer + per-delta emits. This is safe because a turn's output is buffered in
  // turnBuf, so the <Static> scrollback doesn't grow mid-turn (the old overflow-duplication trap).
  const spinner = SPINNER[((spin % SPINNER.length) + SPINNER.length) % SPINNER.length];
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="cyan" bold>OB-1</Text>
        <Text dimColor> {modelLabel} · </Text>
        <Text color={modeColor(s.mode)}>{s.mode}</Text>
        <Text dimColor> · </Text>
        <Text color={s.plan ? "yellow" : "green"}>{s.plan ? "plan" : "act"}</Text>
        {s.autopilot ? <Text color="yellow"> · ⚡autopilot</Text> : null}
        {procs ? <Text color="yellow"> · ⚙{procs} proc{procs > 1 ? "s" : ""} ⌃P</Text> : null}
        {agents ? <Text color="cyan"> · 🤖{agents} agent{agents > 1 ? "s" : ""}</Text> : null}
        {busy ? (stopping
          ? <Text color="yellow" bold>{` · ${spinner} stopping…`}</Text>
          : <Text color="cyan" bold>{` · ${spinner} working · ${tokStr(Math.round(genChars / 4))} tok↑ · Esc to stop`}</Text>)
          : (() => {
              // Reasoning hint, model-aware: a KNOWN non-reasoning model says so (⌃O is a no-op); a model
              // that reasons but hides the trace (OpenAI) shows the effort but notes ⌃O won't reveal it;
              // visible reasoners (and unknown/router models, which may reason) show the ⌃O toggle + effort.
              const cap = modelReasoning(specModel);
              const eff = s.effort ?? "medium";
              if (!cap && modelSpec(specModel)) return <Text dimColor> · no reasoning</Text>; // known, no reasoning
              if (cap && !cap.visible) return <Text dimColor>{` · 💭 ${eff} (trace hidden)`}</Text>;
              return reasoning
                ? <Text color="magenta">{` · 💭reasoning · ${eff}`}</Text>
                : <Text dimColor>{` · ⌃O reasoning · ${eff}`}</Text>;
            })()}
      </Text>
      <Text>
        {ctx ? (
          <Text>
            <Text dimColor>ctx </Text>
            <Text color={ctx.color}>{"█".repeat(ctx.filled)}</Text>
            <Text dimColor>{"░".repeat(ctx.empty)}</Text>
            <Text color={ctx.color}>{` ${ctx.pct}%`}</Text>
            <Text dimColor> · </Text>
          </Text>
        ) : null}
        {credits ? (
          <Text>
            <Text dimColor>credits </Text>
            <Text color={credits.color}>{"█".repeat(credits.filled)}</Text>
            <Text dimColor>{"░".repeat(credits.empty)}</Text>
            <Text color={credits.color}>{` ${credits.pct}% left`}</Text>
            <Text dimColor> · </Text>
          </Text>
        ) : null}
        <Text dimColor>{meter}</Text>
      </Text>
    </Box>
  );
}

// Slash-command palette shown the moment you type "/" — no need to know commands by heart.
// Ordered the way people reach for them: session basics, then model/mode, provider, permissions &
// safety, context/workspace, the heavier orchestration modes, and finally tools/integrations. Every
// entry here must also appear in the /help text (slash-menu-smoke enforces it both ways).
const SLASH_COMMANDS: [string, string][] = [
  // ── session ──
  ["/help", "show all commands"],
  ["/clear", "reset the conversation context"],
  ["/exit", "exit the session"],
  // ── model & mode ──
  ["/models", "pick a model — or connect FreeLLMAPI (↑↓ · Enter)"],
  ["/mode", "pick a mode (↑↓ · Enter)"],
  ["/solo", "exit a heavy mode → back to Solo"],
  ["/plan", "read-only plan mode"],
  ["/act", "act mode (allow edits)"],
  ["/effort", "reasoning effort: low/medium/high (↑↓ · Enter)"],
  // ── provider & plan ──
  ["/freellm", "set up / manage the Free LLM API proxy (↑↓ · Enter)"],
  ["/upgrade", "subscribe / manage your plan (opens pricing, signed in)"],
  // ── permissions & safety ──
  ["/permission", "approval mode: ask / autopilot (↑↓ · Enter)"],
  ["/sandbox", "pick sandbox level (↑↓ · Enter)"],
  ["/trust", "trust this workspace (allow autopilot here)"],
  ["/allow", "standing approval (e.g. /allow git · /allow write src/ · list · clear)"],
  // ── context & workspace ──
  ["/repomap", "repo-map in context on/off (↑↓ · Enter)"],
  ["/rewind", "restore code/conversation to an earlier prompt (↑↓ · Enter)"],
  ["/map", "repository map"],
  ["/memory", "facts + relationships"],
  ["/usage", "token + cost analytics"],
  // ── orchestration modes ──
  ["/autoroute", "Solo auto-routing on/off (↑↓ · Enter)"],
  ["/subagents", "parallel subagents on/off"],
  ["/route", "adaptive routing"],
  ["/fanout", "multi-mind workers"],
  ["/council", "draft → critics → arbiter"],
  ["/personas", "brainstorming panel"],
  ["/eval", "compute-matched eval"],
  ["/codeact", "code-as-action mode (task)"],
  // ── tools & integrations ──
  ["/verify", "run the project's checks (typecheck/test/build)"],
  ["/mcp", "MCP servers"],
  ["/skills", "list skills"],
  ["/skill", "pick a skill (↑↓ · Enter)"],
  ["/agents", "project memory — show/update/episodes/review (↑↓ · Enter)"],
];

// Commands that take a free-text argument: Enter on these COMPLETES to "/cmd " so the argument can be
// typed. Every other command RUNS on Enter (opens its picker, toggles, or lists) — so navigating the
// menu and pressing Enter actually does the thing, instead of just writing the name into the input.
const NEEDS_ARG = new Set(["/fanout", "/council", "/personas", "/route"]);

export function TuiApp({ ctrl }: { ctrl: TuiController }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [value, setValue] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  // Bumping this remounts the <TextInput> so it re-initializes its cursor to the END of the value —
  // ink-text-input only clamps its cursor down, never forward, so a programmatic setValue (e.g. accepting
  // a suggestion) would otherwise leave the cursor at offset 0. Call setAtEnd() instead of bare setValue.
  const [inputKey, setInputKey] = useState(0);
  const setAtEnd = (v: string) => { setValue(v); setInputKey((k) => k + 1); };
  const { exit } = useApp();

  useEffect(() => ctrl.subscribe(force), [ctrl]);
  useEffect(() => { if (ctrl.exited) exit(); });
  // Let the controller drop text into the input box (cursor at end) — used by /rewind to repopulate
  // the rewound prompt. setValue/setInputKey are stable, so registering once is safe.
  useEffect(() => { ctrl.setInput = (text: string) => setAtEnd(text); return () => { ctrl.setInput = undefined; }; }, [ctrl]);

  // Ctrl+O toggles showing the model's reasoning/thinking. ink-text-input only ignores Ctrl+C, so it
  // would otherwise append the "o" to the input — strip that spurious char back off (this handler runs
  // after ink-text-input's onChange, so the value already includes it).
  useInput((input, key) => {
    if (key.ctrl && (input === "o" || input === "O")) {
      ctrl.toggleReasoning();
      setValue((v) => (v.endsWith(input) ? v.slice(0, -1) : v));
    } else if (key.ctrl && (input === "p" || input === "P")) {
      // ⌃P opens/closes the running-process manager (footer shows ⚙N; navigate + kill with x).
      ctrl.toggleProcs();
      setValue((v) => (v.endsWith(input) ? v.slice(0, -1) : v));
    } else if (key.ctrl && (input === "c" || input === "C")) {
      // ⌃C (Ink's exitOnCtrlC is off so this fires instead of an instant kill):
      //  • a non-empty MAIN prompt is CLEARED first — one press, never exits;
      //  • otherwise (empty prompt OR inside ANY picker/approval/setup/process frame) it's a two-stage
      //    exit — the first press arms + shows a hint, a second within the window leaves.
      // This handler is always-active, so ⌃C now works everywhere, including settings/model pickers.
      if (value) { setValue(""); setMenuIndex(0); ctrl.disarmExit(); }
      else ctrl.armOrExit();
    }
  });

  // ESC stops the running turn (aborts the in-flight model call + clears the queue). Inactive while a
  // picker, approval, or clarification owns ESC (those use it to cancel themselves) — ask_user runs
  // mid-turn, so without the !ctrl.ask guard a single ESC would dismiss the question AND kill the turn.
  useInput((_input, key) => {
    if (key.escape) ctrl.requestCancel();
  }, { isActive: ctrl.busy && !ctrl.pending && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.prompt && !ctrl.procFocus });

  // Process manager (⌃P). Active only while open; ↑↓ navigate, x kills the highlighted process,
  // ←/Esc (or ⌃P again) close. Takes over the input frame so x never lands in the text field.
  useInput((input, key) => {
    if (key.upArrow) ctrl.procMove(-1);
    else if (key.downArrow) ctrl.procMove(1);
    else if (input === "x" || input === "X") ctrl.procKill();
    else if (key.escape || key.leftArrow) ctrl.closeProcs();
  }, { isActive: ctrl.procFocus });

  // Approval modal: capture a single keypress (y = yes, anything else = no).
  useInput((input, key) => {
    if (input === "y" || input === "Y") ctrl.answer(true);
    else if (input === "n" || input === "N" || key.return || key.escape) ctrl.answer(false);
  }, { isActive: !!ctrl.pending });

  // Slash-command menu: open while typing a command name (a leading "/", no space yet). Suppressed
  // while a picker/approval/clarification owns the input frame.
  const typingCommand = !ctrl.pending && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.prompt && !ctrl.procFocus && value.startsWith("/") && !value.includes(" ");
  const matches = typingCommand ? SLASH_COMMANDS.filter(([n]) => n.startsWith(value.toLowerCase())) : [];
  const menuOpen = matches.length > 0;
  const sel = Math.max(0, Math.min(menuIndex, matches.length - 1));

  // Menu navigation (active only while it's open, so it never fights the approval handler).
  useInput((_input, key) => {
    if (key.upArrow) setMenuIndex(() => Math.max(0, sel - 1));
    else if (key.downArrow) setMenuIndex(() => Math.min(matches.length - 1, sel + 1));
    else if (key.tab) { setAtEnd(matches[sel][0] + " "); setMenuIndex(0); } // setAtEnd: remount so the cursor lands at end, not mid-string
  }, { isActive: menuOpen });

  // Tab accepts the next-step suggestion (shown as the placeholder) when the input is empty and no
  // menu/modal owns the frame. It just fills the input — the user still reviews + presses Enter.
  const canAcceptSuggestion = !ctrl.busy && !menuOpen && !ctrl.pending && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.prompt && !ctrl.procFocus && value === "" && !!ctrl.suggestion;
  useInput((_input, key) => {
    if (key.tab) { setAtEnd(ctrl.suggestion); ctrl.clearSuggestion(); } // fill the input, cursor at the end
  }, { isActive: canAcceptSuggestion });

  // List-picker navigation (/models, /settings). Active only while a picker is open. → / Enter select
  // (forward); ← goes back ONE level (in /settings, a sub-picker → the Settings menu); Esc leaves the
  // whole flow (in /settings, exits settings). Both ← and Esc resolve null — they differ via pickerDismiss.
  useInput((_input, key) => {
    if (key.upArrow) ctrl.pickerMove(-1);
    else if (key.downArrow) ctrl.pickerMove(1);
    else if (key.return || key.rightArrow) ctrl.pickerConfirm();
    else if (key.leftArrow) ctrl.pickerBack();
    else if (key.escape) ctrl.pickerCancel();
  }, { isActive: !!ctrl.picker });

  // Clarification (ask_user) navigation. List mode: arrows move, ↵/→ select (or confirm in multi),
  // Space toggles a checkbox, ←/Esc dismiss. Editor mode: the <TextInput> owns typing; only Esc here
  // (it backs out of the editor to the list). The handler ignores other keys while editing so the
  // text field still receives them.
  useInput((input, key) => {
    const a = ctrl.ask; if (!a) return;
    if (a.editing) { if (key.escape) ctrl.askEditCancel(); return; }
    if (key.upArrow) ctrl.askMove(-1);
    else if (key.downArrow) ctrl.askMove(1);
    else if (key.return || key.rightArrow) ctrl.askEnter();
    else if (a.multi && input === " ") ctrl.askToggle();
    else if (key.escape || key.leftArrow) ctrl.askCancel();
  }, { isActive: !!ctrl.ask });

  // Provider setup form (reached via /models). List mode: ↑↓ move between rows, ←/→ cycle the location preset,
  // ↵/→ edit a field or run the row's action (Test/Save/Cancel), Esc cancels. Editor mode: the
  // <TextInput> owns typing; only Esc here (backs out of the field). Mirrors the ask_user pattern.
  useInput((_input, key) => {
    const s = ctrl.setup; if (!s) return;
    if (s.editing) { if (key.escape) ctrl.setupEditCancel(); return; }
    const row = ctrl.setupRowKinds()[s.index];
    if (key.upArrow) ctrl.setupMove(-1);
    else if (key.downArrow) ctrl.setupMove(1);
    else if (key.leftArrow) { if (row === "location") ctrl.setupCycle(-1); }
    else if (key.rightArrow) { if (row === "location") ctrl.setupCycle(1); else ctrl.setupActivate(); }
    else if (key.return) { if (row === "location") ctrl.setupMove(1); else ctrl.setupActivate(); }
    else if (key.escape) ctrl.setupCancel();
  }, { isActive: !!ctrl.setup });

  // Inline text prompt (Settings → Free LLM API managed setup). The <TextInput> owns typing + Enter
  // (onSubmit); only Esc is handled here, to cancel the prompt.
  useInput((_input, key) => {
    if (key.escape) ctrl.promptCancel();
  }, { isActive: !!ctrl.prompt });

  // "Get Intelligent Models" footer button. From the input box, ↓ moves focus onto the button — inactive
  // while a menu/modal owns the frame (they use ↓ themselves), while the button already has focus, and
  // while the input has text (so ↓ never steals a keystroke from someone editing a multi-line-ish prompt).
  useInput((_input, key) => {
    if (key.downArrow) ctrl.focusUpsell();
  }, { isActive: ctrl.upsellEligible() && !ctrl.upsellFocus && !ctrl.errorFocus && value === "" && !menuOpen && !ctrl.pending && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.procFocus });

  // While the upsell button is focused: Enter opens the pricing page in the browser; ↑ / Esc return to
  // the input. The <TextInput> is unfocused (focus={!ctrl.upsellFocus}) so typing doesn't leak into it.
  useInput((_input, key) => {
    if (key.return) ctrl.activateUpsell();
    else if (key.upArrow || key.escape) ctrl.blurUpsell();
  }, { isActive: ctrl.upsellFocus });

  // ↑ from an empty prompt surfaces the most recent error's action (e.g. "Upgrade your plan") as a
  // focusable button. Inactive while a menu/modal/upsell owns the frame or the prompt has text.
  useInput((_input, key) => {
    if (key.upArrow) ctrl.focusErrorAction();
  }, { isActive: !!ctrl.lastErrorAction && !ctrl.errorFocus && !ctrl.upsellFocus && value === "" && !menuOpen && !ctrl.pending && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.procFocus });

  // While the error action is focused: Enter opens it in the browser; ↓ / Esc return to the input. The
  // <TextInput> is unfocused (focus also gates on !errorFocus) so the keystroke can't leak into it.
  useInput((_input, key) => {
    if (key.return) ctrl.activateErrorAction();
    else if (key.downArrow || key.escape) ctrl.blurErrorAction();
  }, { isActive: ctrl.errorFocus });

  const s = ctrl.status;
  // The current turn's output lives in a BOUNDED live viewport (ctrl.turnBuf), not in <Static>, so it
  // never appends to <Static> one-line-at-a-time (which duplicates the pinned input box on overflow).
  // It's capped to the terminal height so the dynamic region itself can't overflow; the whole turn is
  // flushed to <Static> in one clean bulk append when it ends (setBusy(false)).
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const panelOpen = !!(ctrl.ask || ctrl.picker || ctrl.setup || ctrl.prompt || ctrl.procFocus || ctrl.pending);
  // One renderer for both the <Static> scrollback and the live turn viewport: a submitted prompt
  // (it.user) renders as a full-width grey bar with white text; everything else as before.
  const renderItem = (it: ScrollItem) =>
    it.user
      ? <Text key={it.id} backgroundColor="#3a3a3a" color="#ffffff">{it.text.length < cols ? it.text + " ".repeat(cols - it.text.length) : it.text}</Text>
      : <Text key={it.id} dimColor={it.dim}>{renderScroll(it)}</Text>;
  // Reserve room for the partial line + input box (3) + status + any proc list, with margin, so the
  // viewport + everything below it never exceeds the terminal height (an overflowing dynamic region
  // pushes the input box off-screen / clobbers the scrollback).
  const viewH = Math.max(2, rows - (panelOpen ? 18 : 12) - ctrl.procList().length - (ctrl.agentsRunning() > 0 ? Math.min(ctrl.agentList().length + 1, 10) : 0) - (ctrl.todoList().length ? Math.min(ctrl.todoList().length + 1, 13) : 0));
  const view = ctrl.busy ? ctrl.turnBuf.slice(-viewH) : [];
  return (
    <Box flexDirection="column">
      {/* Fresh array reference each render: Ink's <Static> memoizes its item slice on the items
          REFERENCE, so a mutated-in-place array never flushes the lines pushed after first render
          (the "output vanishes after the first turn" bug). */}
      {/* `|| " "` so an empty line renders a VISIBLE blank row — Ink collapses a truly-empty <Text> to
          zero height, which would swallow the gap between tool calls and paragraph breaks. */}
      <Static items={[...ctrl.lines]}>{(it) => renderItem(it)}</Static>
      {/* Bounded live viewport of the current turn (the most recent lines), kept OUT of <Static>. */}
      {view.map((it) => renderItem(it))}
      {/* Clip the live partials to ONE terminal row (show the tail = newest text). A long unbroken line
          with no newline never commits, so without clipping it would wrap across many rows — and a tall,
          then-shrinking dynamic region makes Ink's <Static> erase walk up into committed scrollback and
          garble it (the build-error corruption). The full text still commits intact once a newline lands. */}
      {ctrl.reasoning ? <Text dimColor>{"▏ " + clipToRow(ctrl.reasoning, (process.stdout.columns || 80) - 2)}</Text> : null}
      {ctrl.streaming ? <Text>{ctrl.inCode ? codeLine(clipToRow(ctrl.streaming, (process.stdout.columns || 80) - 2)) : mdToAnsi(clipToRow(ctrl.streaming, (process.stdout.columns || 80) - 2))}</Text> : null}
      {/* The agent's task list (update_tasks) — the plan for a longer task, shown above the input with
          each step checked off as it completes. Persists across turns until the agent clears it. */}
      {ctrl.todoList().length > 0 && !ctrl.procFocus && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.pending ? (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{`  ✔ tasks (${ctrl.todoList().filter((t) => t.status === "completed").length}/${ctrl.todoList().length})`}</Text>
          {ctrl.todoList().slice(0, 12).map((t, i) => {
            const icon = t.status === "completed" ? "☑" : t.status === "in_progress" ? "▸" : "☐";
            const color = t.status === "completed" ? "green" : t.status === "in_progress" ? "cyan" : "gray";
            return (
              <Text key={i}>
                <Text color={color}>{`   ${icon} `}</Text>
                <Text color={color} bold={t.status === "in_progress"} strikethrough={t.status === "completed"} dimColor={t.status === "completed"}>{t.content}</Text>
              </Text>
            );
          })}
          {ctrl.todoList().length > 12 ? <Text dimColor>{`   …+${ctrl.todoList().length - 12} more`}</Text> : null}
        </Box>
      ) : null}
      {/* Live subagents (spawn_subagents) — one row per agent so the user can watch what each is doing
          and track progress (queued → running → done/failed). Shown only while the batch is ACTIVE: once
          every agent is terminal the panel collapses away (Solo keeps synthesizing; the saved report holds
          the full findings) so a finished batch doesn't linger on screen. */}
      {ctrl.agentsRunning() > 0 && !ctrl.procFocus && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.pending ? (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{`  🤖 subagents (${ctrl.agentsRunning()} running / ${ctrl.agentList().length})`}</Text>
          {ctrl.agentList().slice(0, 8).map((a) => {
            const color = a.status === "done" ? "green" : a.status === "failed" ? "red" : a.status === "running" ? "cyan" : "gray";
            const icon = a.status === "done" ? "✓" : a.status === "failed" ? "✗" : a.status === "running" ? "▸" : "⋯";
            const elapsed = Math.max(0, Math.round((Date.now() - a.startedAt) / 1000));
            const task = a.task.length > 30 ? a.task.slice(0, 30) + "…" : a.task;
            const detail = a.status === "running" ? (a.activity.length > 26 ? a.activity.slice(0, 26) + "…" : a.activity) : a.status;
            return (
              <Text key={a.id}>
                <Text color={color}>{`   ${icon} ${a.label}`}</Text>
                <Text dimColor>{` ${task} · ${detail} · ${elapsed}s${a.outTok ? ` · ${(a.outTok / 1000).toFixed(1)}k` : ""}`}</Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
      {/* Running bash processes, shown above the input (informational). ⌃P opens the manager to kill. */}
      {ctrl.procList().length > 0 && !ctrl.procFocus && !ctrl.picker && !ctrl.ask && !ctrl.setup && !ctrl.pending ? (
        <Box flexDirection="column" paddingX={1}>
          {ctrl.procList().map((p) => { const cmd = p.command ?? ""; return (
            <Text key={p.id} dimColor>{`  ⚙ ${cmd.length > 56 ? cmd.slice(0, 56) + "…" : cmd} · ${Math.max(0, Math.round((Date.now() - p.startedAt) / 1000))}s${p.background ? " · bg" : ""}${p.killing ? " · killing…" : ""}`}</Text>
          ); })}
          <Text dimColor>{"  ⌃P to manage / kill"}</Text>
        </Box>
      ) : null}
      {/* Queued prompts (submitted while busy) — run automatically, in order. */}
      {ctrl.queue.length > 0 && !ctrl.setup ? (
        <Box flexDirection="column" paddingX={1}>
          {ctrl.queue.map((q, i) => (
            <Text key={i} dimColor>{`  ⋯ queued #${i + 1}: ${q.length > 64 ? q.slice(0, 64) + "…" : q}`}</Text>
          ))}
        </Box>
      ) : null}
      {/* Slash-command palette (above the input), so "/" alone reveals every command. */}
      {menuOpen ? (
        <Box flexDirection="column" paddingX={1}>
          {matches.slice(0, 8).map(([n, d], i) => (
            <Text key={n}>
              <Text color={i === sel ? "cyan" : "gray"} bold={i === sel}>{(i === sel ? "❯ " : "  ") + n.padEnd(11)}</Text>
              <Text dimColor>{d}</Text>
            </Text>
          ))}
          <Text dimColor>  ↑↓ navigate · Tab complete · Enter run</Text>
        </Box>
      ) : null}
      {/* The most recent error's action (e.g. "Upgrade your plan") sits directly ABOVE the input, so ↑
          from the prompt moves focus UP onto it (and ↓/Esc back down to the input — the natural direction).
          Hidden while a panel/menu owns the frame. Cleared by the next prompt. */}
      {ctrl.lastErrorAction && !panelOpen && !menuOpen ? (
        <Box paddingX={1}>
          {ctrl.errorFocus ? (
            <Text>
              <Text backgroundColor="cyan" color="black" bold>{` ❯ ↗ ${ctrl.lastErrorAction.label} `}</Text>
              <Text dimColor>{"  Enter → open · ↓ back"}</Text>
            </Text>
          ) : (
            <Text>
              <Text color="cyan" bold>{`↗ ${ctrl.lastErrorAction.label}`}</Text>
              <Text dimColor>{"  ↑ to open"}</Text>
            </Text>
          )}
        </Box>
      ) : null}
      {/* Inline text prompt (Settings → Free LLM API managed setup): a label + one field. Enter submits,
          Esc cancels. `mask` hides the value (password). */}
      {ctrl.prompt ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text bold color="cyan">{ctrl.prompt.title}</Text>
          <Box>
            <Text color="cyan">{"  " + ctrl.prompt.question + ": "}</Text>
            <TextInput
              value={ctrl.prompt.value}
              onChange={ctrl.promptChange}
              onSubmit={ctrl.promptSubmit}
              mask={ctrl.prompt.mask ? "•" : undefined}
              placeholder={ctrl.prompt.placeholder ?? ""}
            />
          </Box>
          <Text dimColor>  Enter submit · Esc cancel</Text>
        </Box>
      ) : ctrl.setup ? (() => {
        const s = ctrl.setup!;
        const rows = ctrl.setupRowKinds();
        const maskedKey = s.key ? "•".repeat(Math.min(s.key.length, 24)) : "(none)";
        const rowLabel = (kind: SetupRow): { label: string; value: string; hint?: string } => {
          if (kind === "location") { const p = s.presets[s.presetIndex]; return { label: "Location", value: `◀ ${p.label} ▶`, hint: p.hint }; }
          if (kind === "url") return { label: "Proxy URL", value: s.url || "(empty)" };
          if (kind === "key") return { label: "API key", value: maskedKey, hint: s.keyPrefix ? `starts with ${s.keyPrefix}…` : undefined };
          if (kind === "test") return { label: "", value: s.testing ? "[ Testing… ]" : "[ Test connection ]" };
          if (kind === "save") return { label: "", value: "[ Save & use ]" };
          return { label: "", value: "[ Cancel ]" };
        };
        return (
          <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
            <Text bold color="green">{s.title}</Text>
            {s.blurb.map((l, i) => <Text key={i} dimColor>{l || " "}</Text>)}
            <Text> </Text>
            {rows.map((kind, i) => {
              const cur = i === s.index;
              // URL/key rows become a live <TextInput> while editing that field.
              if (s.editing === kind && (kind === "url" || kind === "key")) {
                return (
                  <Box key={kind}>
                    <Text color="green">{`  ✎ ${kind === "url" ? "Proxy URL" : "API key"}: `}</Text>
                    <TextInput value={kind === "url" ? s.url : s.key} onChange={ctrl.setupEditChange} onSubmit={ctrl.setupEditSubmit} placeholder={kind === "url" ? "https://host:port/v1" : "freellmapi-…"} />
                  </Box>
                );
              }
              const r = rowLabel(kind);
              return (
                <Text key={kind}>
                  <Text color={cur ? "cyan" : "gray"} bold={cur}>{(cur ? "❯ " : "  ") + (r.label ? r.label + ": " : "") + r.value}</Text>
                  {r.hint ? <Text dimColor>{"  " + r.hint}</Text> : null}
                </Text>
              );
            })}
            {s.status ? <Text color={s.status.startsWith("✓") ? "green" : s.status.startsWith("✗") ? "red" : "yellow"}>{"  " + s.status}</Text> : null}
            <Text dimColor>  ↑↓ move · ←/→ change location · ↵ edit/run · Esc cancel</Text>
          </Box>
        );
      })() : ctrl.ask ? (
        <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
          <Text>
            {ctrl.ask.progress ? <Text dimColor>{`(${ctrl.ask.progress.n}/${ctrl.ask.progress.total}) `}</Text> : null}
            {ctrl.ask.header ? <Text color="magenta" bold>{`[${ctrl.ask.header}] `}</Text> : null}
            <Text bold>{ctrl.ask.question}</Text>
          </Text>
          {ctrl.ask.options.map((o, i) => {
            const cur = i === ctrl.ask!.index && !ctrl.ask!.editing;
            const mark = ctrl.ask!.multi ? (ctrl.ask!.checked.has(i) ? "[x]" : "[ ]") : (cur ? "(•)" : "( )");
            return (
              <Text key={i}>
                <Text color={cur ? "cyan" : "gray"} bold={cur}>{(cur ? "❯ " : "  ") + mark + " " + o.label}</Text>
                {o.description ? <Text dimColor>{"  " + o.description}</Text> : null}
              </Text>
            );
          })}
          {(() => {
            const a = ctrl.ask!;
            const fi = a.options.length;            // the free-text row
            const cur = a.index === fi && !a.editing;
            const checkedFree = a.multi && a.checked.has(fi) && a.freeText.trim().length > 0;
            if (a.editing) return (
              <Box>
                <Text color="magenta">{"  " + (a.multi ? "[x]" : "(•)") + " ✎ "}</Text>
                <TextInput value={a.freeText} onChange={ctrl.askEditChange} onSubmit={ctrl.askEditSubmit} placeholder="type your answer…" />
              </Box>
            );
            const mark = a.multi ? (checkedFree ? "[x]" : "[ ]") : (cur ? "(•)" : "( )");
            const text = checkedFree ? `✎ ${a.freeText.trim()}` : "Something else (type your own)…";
            return <Text color={cur ? "cyan" : "gray"} bold={cur}>{(cur ? "❯ " : "  ") + mark + " " + text}</Text>;
          })()}
          <Text dimColor>{ctrl.ask.multi ? "  ↑↓ move · Space toggle · Enter confirm · ←/Esc cancel" : "  ↑↓ move · ↵/→ select · ←/Esc cancel"}</Text>
        </Box>
      ) : ctrl.picker ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text bold color="cyan">{ctrl.picker.title}</Text>
          {ctrl.picker.items.map((it, i) => (
            <Text key={it.value}>
              <Text color={i === ctrl.picker!.index ? "cyan" : "gray"} bold={i === ctrl.picker!.index}>{(i === ctrl.picker!.index ? "❯ " : "  ") + it.label.padEnd(24)}</Text>
              {it.hint ? <Text dimColor>{"  " + it.hint}</Text> : null}
            </Text>
          ))}
          <Text dimColor>  ↑↓ navigate · ↵/→ select · ← back · Esc close</Text>
        </Box>
      ) : ctrl.procFocus ? (
        /* Running-process manager (⌃P): navigate the live run_bash processes and kill with x. */
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text bold color="yellow">Running processes</Text>
          {ctrl.procList().length === 0 ? (
            <Text dimColor>  (none running)</Text>
          ) : ctrl.procList().map((p, i) => {
            const cur = i === Math.min(ctrl.procIndex, ctrl.procList().length - 1);
            const c0 = p.command ?? "";
            const cmd = c0.length > 50 ? c0.slice(0, 50) + "…" : c0;
            return (
              <Text key={p.id}>
                <Text color={cur ? "yellow" : "gray"} bold={cur}>{(cur ? "❯ " : "  ") + "⚙ " + cmd}</Text>
                <Text dimColor>{`  ${Math.max(0, Math.round((Date.now() - p.startedAt) / 1000))}s${p.pid ? ` · pid ${p.pid}` : ""}${p.background ? " · bg" : ""}${p.killing ? " · killing…" : ""}`}</Text>
              </Text>
            );
          })}
          <Text dimColor>  ↑↓ navigate · x kill · Esc close</Text>
        </Box>
      ) : (
        /* Bordered input box. Stays EDITABLE while busy so prompts can be typed + queued; only an
           approval prompt borrows the frame. */
        <Box borderStyle="round" borderColor={ctrl.pending ? "yellow" : ctrl.busy ? "gray" : "cyan"} paddingX={1}>
          {ctrl.pending ? (
            <Text><Text color="yellow">⚠ approve {ctrl.pending.desc} </Text><Text dimColor>[y/N]</Text></Text>
          ) : (
            <Box>
              <Text color={ctrl.busy ? "gray" : modeColor(s.mode)} bold>{"› "}</Text>
              <TextInput
                key={inputKey}
                focus={!ctrl.upsellFocus && !ctrl.errorFocus}
                value={value}
                onChange={(v) => { setValue(v); setMenuIndex(0); }}
                onSubmit={(line) => {
                  // While the slash menu is open, Enter acts on the HIGHLIGHTED command (the footer
                  // promises "Enter run") — not on the raw partial text. An arg-taking command first
                  // completes to "/cmd " so the argument can be typed; everything else runs, which is
                  // what opens the /mode·/sandbox·… pickers straight from the menu. An exact-typed name
                  // wins over the highlight so "/skill" runs /skill, not the earlier-listed /skills.
                  if (menuOpen && matches[sel]) {
                    const trimmed = line.trim();
                    const cmd = (matches.find(([n]) => n === trimmed) ?? matches[sel])[0];
                    if (NEEDS_ARG.has(cmd) && trimmed !== cmd) { setAtEnd(cmd + " "); setMenuIndex(0); return; } // setAtEnd: cursor at end so the arg types correctly
                    setValue(""); setMenuIndex(0); void ctrl.onSubmit?.(cmd); return;
                  }
                  setValue(""); void ctrl.onSubmit?.(line);
                }}
                placeholder={ctrl.busy ? "queue another task — runs after the current one…" : ctrl.suggestion ? `${ctrl.suggestion}   ⇥ tab` : "type a task, or / for commands"}
              />
            </Box>
          )}
        </Box>
      )}
      {ctrl.upsellEligible() && !panelOpen && !menuOpen ? (
        // Prominent "Get Intelligent Models" call-to-action (Free LLM API users only). ↓ from the input
        // focuses it (inverted bar); Enter opens the pricing page; ↑/Esc return to the input.
        <Box paddingX={1}>
          {ctrl.upsellFocus ? (
            <Text>
              <Text backgroundColor="magenta" color="white" bold>{" ❯ ✨ Get Intelligent Models "}</Text>
              <Text dimColor>{"  Enter → view plans · ↑ back"}</Text>
            </Text>
          ) : (
            <Text>
              <Text color="magenta" bold>{"✨ Get Intelligent Models"}</Text>
              <Text dimColor>{"  ↓ to see plans"}</Text>
            </Text>
          )}
        </Box>
      ) : null}
      {ctrl.exitArmed ? (
        // ⌃C two-stage hint — rendered at the very bottom so it shows under ANY frame (input or a picker).
        <Box paddingX={1}><Text color="yellow" bold>{"  ⏻ Press Ctrl+C again to exit"}</Text></Box>
      ) : null}
      <StatusBar s={s} reasoning={ctrl.showReasoning} procs={ctrl.procList().length} agents={ctrl.agentsRunning()} busy={ctrl.busy} stopping={ctrl.stopping} genChars={ctrl.genChars} spin={ctrl.spinnerFrame} />
    </Box>
  );
}

// The fallback shown when a render error is caught: the children (and their useInput handlers) are
// unmounted, so it owns the keys — any key retries (re-mounts the UI; a transient bad value will have
// cleared), ⌃C exits cleanly. The session/state is intact; only this render frame failed.
function RenderErrorFallback({ ctrl, err, reset }: { ctrl: TuiController; err: Error; reset: () => void }) {
  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "C")) { ctrl.cancelTurn?.(); ctrl.procReg?.killAll(); ctrl.exit(); }
    else reset(); // any other key → re-mount and try rendering again
  });
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      <Text color="red" bold>⚠ UI render error — the interface hit a bug and paused. Your session is intact.</Text>
      <Text dimColor>{String(err?.message ?? err).slice(0, 200)}</Text>
      <Text dimColor>Press any key to retry · ⌃C to exit</Text>
    </Box>
  );
}

// App-wide error boundary: an unhandled throw in any child's render would otherwise tear down the
// ENTIRE Ink app (the user loses their session). Catch it, log it to scrollback, and show a recoverable
// fallback instead of crashing the process.
export class ErrorBoundary extends Component<{ ctrl: TuiController; children: ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { this.props.ctrl.reportRenderError(err); }
  reset = () => this.setState({ err: null });
  render() {
    return this.state.err
      ? <RenderErrorFallback ctrl={this.props.ctrl} err={this.state.err} reset={this.reset} />
      : this.props.children;
  }
}

export function startTui(ctrl: TuiController): { waitUntilExit: () => Promise<void> } {
  // exitOnCtrlC:false so ⌃C reaches our handler (clear prompt first, exit only when empty) instead of
  // Ink killing the app on the first press. The ErrorBoundary keeps a render throw from killing the app.
  const instance = render(<ErrorBoundary ctrl={ctrl}><TuiApp ctrl={ctrl} /></ErrorBoundary>, { exitOnCtrlC: false });
  return { waitUntilExit: async () => { await instance.waitUntilExit(); } };
}
