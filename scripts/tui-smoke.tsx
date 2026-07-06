// Deterministic test for the Ink TUI (no TTY / no API key) via ink-testing-library.
// Verifies status bar, live token/cost meter, scrollback, mode/phase reflection, streaming, approval.
// Usage: bun run scripts/tui-smoke.tsx
import { render } from "ink-testing-library";
import { TuiController, TuiApp, ErrorBoundary, renderTable, isTableSeparator, renderScroll, contextBar, clipToRow, fitTail, lineRows } from "../src/cli/tui.tsx";
import { ProcRegistry } from "../src/agent/procs.ts";
import { AgentRegistry } from "../src/agent/agent-registry.ts";
import { TodoRegistry } from "../src/agent/todo-registry.ts";

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");
process.env.OB1_RENDER_FRAME_MS = "0"; // disable render batching so each 20ms tick captures the latest frame
const tick = () => new Promise((r) => setTimeout(r, 20)); // let React flush out-of-React updates
let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const ctrl = new TuiController({ model: "qwen/qwen3.6-plus", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
ctrl.pushLine("hello from scrollback");
const { lastFrame, stdin } = render(<TuiApp ctrl={ctrl} />);
await tick();
let f = strip(lastFrame() ?? "");
check("status bar shows OB-1 + model", f.includes("OB-1") && f.includes("qwen/qwen3.6-plus"));
check("status bar shows mode + phase", f.includes("solo") && f.includes("act"));
check("scrollback shows a pushed line", f.includes("hello from scrollback"));
check("token meter present", f.includes("0.0k in") && f.includes("0.0k out"));

ctrl.addTokens(1500, 500);
await tick();
f = strip(lastFrame() ?? "");
check("token meter updates live", f.includes("1.5k in") && f.includes("0.5k out"));
check("cost estimate appears once tokens spent", f.includes("$"));

ctrl.setStatus({ mode: "council", plan: true });
await tick();
f = strip(lastFrame() ?? "");
check("mode + phase switch reflected", f.includes("council") && f.includes("plan"));

// Subscription footer: a paid plan shows a monthly credits-REMAINING bar (drains as you spend) and HIDES
// the $ cost (subscribers pay a flat plan); free/custom keeps the $ cost and shows no credits bar. Reuse
// the existing render (the ctrl has tokens, so a $ cost is showing) — avoids a second concurrent Ink mount.
check("free/custom footer shows the $ cost and no credits bar", f.includes("$") && !f.includes("% left"));
ctrl.setSubscription(true, 25, 100); // 25 of 100 monthly credits used → 75% remaining
await tick();
f = strip(lastFrame() ?? "");
check("subscribed footer shows a credits-remaining bar (% left)", f.includes("credits ") && f.includes("75% left"));
check("subscribed footer hides the $ cost", !f.includes("$"));
ctrl.setSubscription(false); // restore for subsequent assertions
await tick();

ctrl.stream("streaming ");
ctrl.stream("text…");
await tick();
f = strip(lastFrame() ?? "");
check("live streaming region shows deltas", f.includes("streaming text…"));
ctrl.endStream();
await tick();
// <Static> writes each line once (a later append isn't re-shown by lastFrame — a harness quirk,
// matching real-terminal behavior), so assert the commit on the controller's authoritative state.
check("endStream commits stream into scrollback + clears live region",
  ctrl.streaming === "" && ctrl.lines.some((l) => l.text.includes("streaming text…")));

// busy → an animated "working" loader + a live token counter that climbs as text streams; the input
// box STAYS pinned (streamed lines render in a bounded viewport above it, not in <Static>), queued
// prompts, and the autopilot marker.
ctrl.setBusy(true);
ctrl.enqueue("queued task alpha");
ctrl.stream("a streamed line\n");    // a completed line → goes to the turn viewport (not <Static>)
ctrl.setStatus({ autopilot: true });
await tick();
f = strip(lastFrame() ?? "");
check("busy shows the working loader (+ Esc-to-stop hint)", f.includes("working") && f.includes("Esc to stop"));
check("loader shows a live ~token counter that builds as text streams", f.includes("tok") && ctrl.genChars === "a streamed line\n".length);
check("streamed line renders in the live turn viewport", f.includes("a streamed line"));
check("turn line is buffered (not yet in <Static> scrollback)", ctrl.turnBuf.some((l) => l.text.includes("a streamed line")) && !ctrl.lines.some((l) => l.text.includes("a streamed line")));
check("queued prompt listed while busy", f.includes("queued #1: queued task alpha"));
check("input box stays pinned + editable while busy (queue hint)", f.includes("queue another task"));
check("autopilot marker shows in status bar", f.includes("autopilot"));
ctrl.endStream(); ctrl.dequeue(); ctrl.setBusy(false); ctrl.setStatus({ autopilot: false });
await tick();
f = strip(lastFrame() ?? "");
check("input prompt restored after the turn clears", f.includes("type a task, or /"));
check("loader cleared when not busy (no 'working' once the turn ends)", !f.includes("working") && ctrl.busy === false);

// inline Markdown in model output renders (bold + code); the markers are consumed
ctrl.stream("inline **strongly** and `snippet` text");   // partial line → shown live (not Static)
await tick();
const md = lastFrame() ?? "";
check("markdown markers removed from model output", strip(md).includes("inline strongly and") && !strip(md).includes("**"));
check("markdown bold emits a bold SGR", md.includes("[1mstrongly"));
ctrl.endStream();
await tick();

// interactive list picker — the shared ↑↓ + Enter selection used by /settings, /models, and the
// bare /mode · /sandbox · /skill · /agents commands (no typing).
const pk = ctrl.pick("Mode  ↑↓ · Enter · Esc", [
  { label: "solo", hint: "one model, one pass", value: "solo" },
  { label: "fusion", hint: "best-of-N candidates", value: "fusion" },
], "solo");
await tick();
f = strip(lastFrame() ?? "");
check("picker renders title + items + hints", f.includes("Mode") && f.includes("solo") && f.includes("one model, one pass"));
check("picker highlights the current value", f.includes("❯ solo"));
ctrl.pickerMove(1);                       // ↓ — what the down-arrow key drives on a real terminal
await tick();
check("pickerMove changes the highlight (↓)", strip(lastFrame() ?? "").includes("❯ fusion"));
ctrl.pickerConfirm();                      // Enter
const chosen = await pk;
check("pickerConfirm resolves with the highlighted value", chosen === "fusion");
await tick();                              // let the close re-render flush
check("picker closes after confirm (input restored)", strip(lastFrame() ?? "").includes("type a task, or /"));
// Esc cancels → resolves null, leaving state unchanged.
const pk2 = ctrl.pick("Sandbox", [{ label: "off", value: "off" }, { label: "read-only", value: "read-only" }], "off");
await tick();
ctrl.pickerCancel();
check("pickerCancel (Esc) resolves null", (await pk2) === null);

// Left/right arrow nav (driven through real keystrokes): → selects (forward) like Enter; ← backs out
// ONE level (dismiss=back; in /settings this returns a sub-picker to the menu); Esc leaves (dismiss=escape).
{
  const pr = ctrl.pick("Mode", [{ label: "solo", value: "solo" }, { label: "fusion", value: "fusion" }], "solo");
  await tick();
  stdin.write("\x1b[B");                     // ↓ → fusion
  await tick();
  stdin.write("\x1b[C");                     // → selects (forward)
  check("right arrow selects (forward) in a picker", (await pr) === "fusion" && ctrl.pickerDismiss === "select");
  const pr2 = ctrl.pick("Sandbox", [{ label: "off", value: "off" }, { label: "read-only", value: "read-only" }], "off");
  await tick();
  stdin.write("\x1b[D");                     // ← backs out one level
  check("left arrow backs out a picker (null, dismiss=back)", (await pr2) === null && ctrl.pickerDismiss === "back");
  const pr3 = ctrl.pick("Sandbox", [{ label: "off", value: "off" }], "off");
  await tick();
  stdin.write("\x1b");                       // Esc leaves
  check("Esc closes a picker (null, dismiss=escape)", (await pr3) === null && ctrl.pickerDismiss === "escape");
}

// A picker opened inside a busy turn (e.g. /settings) renders cleanly above the pinned input.
ctrl.setBusy(true);
const pk3 = ctrl.pick("Mode", [{ label: "solo", value: "solo" }], "solo");
await tick();
f = strip(lastFrame() ?? "");
check("picker renders while busy (over the turn viewport)", f.includes("solo") && f.includes("↑↓ navigate"));
ctrl.pickerCancel(); await pk3; ctrl.setBusy(false);
await tick();

// approval modal + promise resolution
const p = ctrl.approve("write_file foo.ts");
await tick();
f = strip(lastFrame() ?? "");
check("approval modal renders with desc + [y/N]", f.includes("approve") && f.includes("foo.ts") && f.includes("[y/N]"));
ctrl.answer(true);
const ans = await p;
check("approval resolves to the given answer", ans === true);

// ── Slash menu: ↑↓-navigate then Enter RUNS the highlighted command (regression: Enter used to
//    autocomplete the partial text into the input, so navigating to /mode and pressing Enter just
//    wrote "/mode " instead of opening the picker). Driven through real keystrokes via stdin. ──
{
  const ctrl2 = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let dispatched: string | null = null;
  ctrl2.onSubmit = (line) => { dispatched = line; };
  const { stdin, lastFrame: lf } = render(<TuiApp ctrl={ctrl2} />);
  await tick();
  stdin.write("/");          // open the menu (highlight starts on the first command, /help)
  await tick();
  stdin.write("[B");   // ↓ to the second command (/settings)
  await tick();
  check("menu highlight visible before Enter", strip(lf() ?? "").includes("/clear"));
  stdin.write("\r");          // Enter — should RUN the highlighted command, not autocomplete it
  await tick();
  check("menu Enter runs the highlighted command (not the raw partial text)", dispatched === "/clear");
  check("menu Enter cleared the input (didn't write the name in)", !strip(lf() ?? "").includes("› /clear"));
  // An arg-taking command (/fanout) instead COMPLETES so its task can be typed.
  let dispatched2: string | null = null;
  ctrl2.onSubmit = (line) => { dispatched2 = line; };
  stdin.write("/fanout");     // exact name typed; menu still open
  await tick();
  stdin.write("\r");
  await tick();
  check("arg-taking command runs on a full-typed name + Enter", dispatched2 === "/fanout");
}

// ── ⌃C: a non-empty prompt is CLEARED first (never arms/exits); an empty prompt is a TWO-STAGE exit
//    (first press arms + shows a hint, a second press within the window exits). ──
{
  const cc = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { stdin: cin, lastFrame: cl } = render(<TuiApp ctrl={cc} />);
  await tick();
  cin.write("hello world");   // type a prompt
  await tick();
  check("prompt text visible before ⌃C", strip(cl() ?? "").includes("hello world"));
  cin.write("\x03");          // ⌃C — clears the prompt, must NOT arm or exit
  await tick();
  check("⌃C with a prompt clears it and does not exit", !strip(cl() ?? "").includes("hello world") && cc.exited === false && cc.exitArmed === false);
  cin.write("\x03");          // ⌃C #1 on the now-empty prompt → ARMS (hint shown), does not exit yet
  await tick();
  check("first ⌃C on an empty prompt arms (does not exit)", cc.exited === false && cc.exitArmed === true);
  check("the 'press Ctrl+C again' hint is shown", strip(cl() ?? "").includes("Ctrl+C again"));
  cin.write("\x03");          // ⌃C #2 within the window → exit
  await tick();
  check("second ⌃C exits", cc.exited === true);
}

// ⌃C now works INSIDE a picker too (it's a two-stage exit everywhere) — first press arms, second exits.
{
  const cp = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { stdin: pin } = render(<TuiApp ctrl={cp} />);
  await tick();
  void cp.pick("Pick one", [{ label: "a", value: "a" }, { label: "b", value: "b" }]);
  await tick();
  pin.write("\x03");          // ⌃C #1 inside a picker → arms, must not exit yet
  await tick();
  check("⌃C inside a picker arms (does not exit on the first press)", cp.exited === false && cp.exitArmed === true);
  pin.write("\x03");          // ⌃C #2 → exits even from inside the picker
  await tick();
  check("a second ⌃C exits from inside a picker", cp.exited === true);
}

// disarmExit() drops the armed state (the window-expiry path) so the next ⌃C re-arms instead of exiting.
{
  const cd = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  cd.armOrExit();
  check("armOrExit arms on the first call", cd.exitArmed === true && cd.exited === false);
  cd.disarmExit();
  check("disarmExit clears the armed state", cd.exitArmed === false);
  cd.armOrExit();
  check("after disarm, the next ⌃C re-arms (does not exit)", cd.exitArmed === true && cd.exited === false);
}

// ── User messages are committed as `user` lines (grey bar) — distinct from model output ──
{
  const uc = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { lastFrame: uf } = render(<TuiApp ctrl={uc} />);
  await tick();
  uc.pushUser("hello world\nsecond line");
  await tick();
  check("pushUser commits user-flagged lines", uc.lines.filter((l) => l.user).length === 2);
  check("first user line is prefixed with ›", uc.lines.some((l) => l.user && l.text === "› hello world"));
  check("continuation user line is indented (not re-prefixed)", uc.lines.some((l) => l.user && l.text === "  second line"));
  check("a normal pushLine is NOT user-flagged", (() => { uc.pushLine("plain"); return uc.lines.some((l) => !l.user && l.text === "plain"); })());
  check("user message content shows in the frame", strip(uf() ?? "").includes("› hello world"));
}

// ── Next-step suggestion: shown as the input placeholder, Tab fills the input with it ──
{
  const sc = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { stdin: sin, lastFrame: sf } = render(<TuiApp ctrl={sc} />);
  await tick();
  sc.setSuggestion("run the tests");
  await tick();
  const before = strip(sf() ?? "");
  check("suggestion shows as the input placeholder with a tab hint", before.includes("run the tests") && before.toLowerCase().includes("tab"));
  sin.write("\t"); // Tab accepts the suggestion
  await tick();
  const after = strip(sf() ?? "");
  check("Tab fills the input with the suggestion", after.includes("› run the tests"));
  check("accepting clears the stored suggestion (hint gone)", sc.suggestion === "" && !after.toLowerCase().includes("⇥ tab"));
  // Cursor must land at the END: a typed char appends, not inserts at offset 0.
  sin.write("!");
  await tick();
  check("cursor lands at the end of the accepted suggestion", strip(sf() ?? "").includes("run the tests!"));
}

// ── App-wide error boundary: a child render throw degrades to a recoverable fallback, not a crash ──
{
  const Boom = (): any => { throw new Error("boom-render-xyz"); };
  const ec = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let threw = false, frame = "";
  try { const { lastFrame: ef } = render(<ErrorBoundary ctrl={ec}><Boom /></ErrorBoundary>); await tick(); frame = strip(ef() ?? ""); }
  catch { threw = true; }
  check("error boundary catches a child render throw (process survives)", !threw);
  check("error boundary shows a recoverable fallback", frame.includes("UI render error") && frame.includes("retry"));
}

// ── Render safety: a proc with no command must NOT crash the render (it killed the whole app) ──
{
  const pr = new ProcRegistry();
  pr.add(undefined as any, () => {});   // malformed: undefined command
  const pc = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 }, pr);
  let threw = false, frame = "";
  try { const { lastFrame: pf } = render(<TuiApp ctrl={pc} />); await tick(); frame = strip(pf() ?? ""); } catch { threw = true; }
  check("render survives a proc with no command (no crash)", !threw && frame.includes("⚙"));
}

// ── Task list (update_tasks): the registry renders above the input, with statuses marked ──
{
  const td = new TodoRegistry();
  const tc = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 }, undefined, undefined, td);
  const { lastFrame: tf } = render(<TuiApp ctrl={tc} />);
  await tick();
  check("no task panel when the list is empty", !strip(tf() ?? "").includes("tasks ("));
  td.set([
    { content: "Design the schema", status: "completed" },
    { content: "Write the migration", status: "in_progress" },
    { content: "Backfill rows", status: "pending" },
  ]);
  await tick();
  const frame = strip(tf() ?? "");
  check("task panel shows the progress header", frame.includes("tasks (1/3)"));
  check("completed task marked ☑", frame.includes("☑") && frame.includes("Design the schema"));
  check("in-progress task marked ▸", frame.includes("▸") && frame.includes("Write the migration"));
  check("pending task marked ☐", frame.includes("☐") && frame.includes("Backfill rows"));
  td.clear();
  await tick();
  check("task panel disappears when cleared", !strip(tf() ?? "").includes("tasks ("));
}

// ── Markdown tables → aligned box-drawn output ──
check("isTableSeparator detects a |---| row", isTableSeparator("|---|:--:|--:|") && isTableSeparator("--- | ---") && !isTableSeparator("| a | b |"));
const tbl = renderTable(["| Name | Score |", "|---|--:|", "| Alice | 9 |", "| Bob | 42 |"]);
check("renderTable returns box-drawn lines", !!tbl && tbl.length === 6); // top, header, sep, 2 rows, bottom
const tplain = (tbl ?? []).map((l) => strip(l));
check("renderTable draws a top + bottom border", tplain[0].startsWith("┌") && tplain[0].includes("┬") && tplain[tplain.length - 1].startsWith("└"));
check("renderTable renders header + cells", tplain.some((l) => l.includes("Name") && l.includes("Score")) && tplain.some((l) => l.includes("Alice")) && tplain.some((l) => l.includes("Bob")));
// "Score" col (--:) has width 5 (max of "Score"=5, "9", "42"); "9" right-aligned → padded left to "    9".
check("renderTable right-aligns a --: column", (() => { const row = tplain.find((l) => l.includes("Alice"))!; return row.includes("    9"); })());
check("renderTable aligns columns to equal width", (() => { const a = tplain.find((l) => l.includes("Alice"))!, b = tplain.find((l) => l.includes("Bob"))!; return a.length === b.length; })());
check("renderTable returns null for a non-table", renderTable(["| just | text |", "| no separator | here |"]) === null);

// Controller buffers a streamed table and commits it FORMATTED (not raw pipe lines).
const tctrl = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
tctrl.stream("Here is a table:\n");
tctrl.stream("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
tctrl.stream("done.\n");
tctrl.endStream();
const allText = tctrl.lines.map((l) => strip(l.text)).join("\n");
check("streamed table is rendered as a box (┌ present)", allText.includes("┌") && allText.includes("│") && allText.includes("└"));
check("streamed table keeps surrounding prose", allText.includes("Here is a table:") && allText.includes("done."));
check("streamed table did NOT commit raw pipe rows", !tctrl.lines.some((l) => /^\| --- \|/.test(l.text)));

// ── Reasoning channel (Ctrl+O toggle) ──
const rctrl = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
rctrl.reasoningDelta("hidden thought\n");
check("reasoning is DROPPED while toggle is off", !rctrl.lines.some((l) => l.text.includes("hidden thought")));
rctrl.toggleReasoning();
check("toggleReasoning turns it on", rctrl.showReasoning === true);
rctrl.reasoningDelta("step one\nstep two");          // 1 complete line + a partial
check("reasoning commits completed lines (dim, gutter)", rctrl.lines.some((l) => l.text === "▏ step one" && l.dim === true));
check("partial reasoning waits in the live region", rctrl.reasoning === "step two");
rctrl.stream("Answer begins");                         // answer text → flush trailing reasoning first
check("answer start flushes the trailing reasoning line", rctrl.lines.some((l) => l.text === "▏ step two" && l.dim === true) && rctrl.reasoning === "");
rctrl.endStream();
check("the answer itself is not dimmed", rctrl.lines.some((l) => l.text.includes("Answer begins") && !l.dim));
rctrl.toggleReasoning();
check("toggleReasoning turns it back off", rctrl.showReasoning === false);

// Ctrl+O reasoning indicator renders in the status bar.
const { lastFrame: rf } = render(<TuiApp ctrl={rctrl} />);
await tick();
check("status bar shows the ⌃O reasoning hint when off", strip(rf() ?? "").includes("reasoning"));
rctrl.toggleReasoning();
await tick();
check("status bar shows 💭reasoning when on", strip(rf() ?? "").includes("reasoning"));

// ── ESC-to-stop: requestCancel invokes the drain loop's cancel handle; loader shows the hint ──
const cctrl = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
let cancelled = false;
cctrl.cancelTurn = () => { cancelled = true; };
cctrl.requestCancel();
check("requestCancel invokes the turn's cancel handle (ESC)", cancelled);
cctrl.setBusy(true);
const { lastFrame: cf } = render(<TuiApp ctrl={cctrl} />);
await tick();
check("busy loader shows the 'Esc to stop' hint", strip(cf() ?? "").includes("Esc to stop"));
cctrl.setBusy(false);

// ── ESC in the input box: with TEXT it wipes the draft (never stops the turn); EMPTY it's a hard stop
//    (requestCancel→cancelTurn aborts the turn + clears the queue + kills bash). Driven via real keys. ──
{
  const e = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let stopped = false; e.cancelTurn = () => { stopped = true; };
  e.setBusy(true);
  const { stdin, lastFrame: lf } = render(<TuiApp ctrl={e} />);
  await tick();
  stdin.write("hello draft");
  await tick();
  check("typed draft shows in the input", strip(lf() ?? "").includes("hello draft"));
  stdin.write("\x1b");                       // Esc with text → wipe the draft only
  await tick();
  check("Esc with text wipes the draft", !strip(lf() ?? "").includes("hello draft"));
  check("Esc with text does NOT stop the turn", !stopped);
  stdin.write("\x1b");                       // Esc on the now-empty input → hard stop
  await tick();
  check("Esc on an empty input hard-stops the turn", stopped);
  e.setBusy(false);
}

// ── ↑ recall: a QUEUED task comes back into the input (marked "editing"); Enter re-sends it and removes
//    the original from the queue (runs once, with edits, not twice). ──
{
  const q = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let sent: string | null = null;
  q.onSubmit = (line) => { sent = line; };
  q.setBusy(true);
  q.enqueue("queued bravo");
  const { stdin, lastFrame: lf } = render(<TuiApp ctrl={q} />);
  await tick();
  check("queued task shown before recall", strip(lf() ?? "").includes("queued #1: queued bravo"));
  stdin.write("\x1b[A");                     // ↑ → pull the queued task back into the input
  await tick();
  check("↑ marks the pulled queued task as editing", strip(lf() ?? "").includes("✎ editing above"));
  stdin.write("\r");                         // Enter → re-send it
  await tick();
  check("Enter re-sends the recalled queued task", sent === "queued bravo");
  check("re-sending a recalled queued task unqueues the original (no double-run)", q.queue.length === 0);
  q.setBusy(false);
}

// ── ↑/↓ recall walks this session's prompt history (newest first); ↓ steps back toward newer; Enter
//    re-sends a recalled prompt and leaves history intact. ──
{
  const h = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let sent2: string | null = null;
  h.onSubmit = (line) => { sent2 = line; };
  h.recordHistory("first prompt");
  h.recordHistory("second prompt");
  h.recordHistory("/clear");                 // slash-commands are NOT recorded (skipped inside recordHistory)
  check("slash-commands are excluded from recall history", h.history.length === 2);
  const { stdin, lastFrame: lf } = render(<TuiApp ctrl={h} />);
  await tick();
  stdin.write("\x1b[A");                     // ↑ → newest first
  await tick();
  check("↑ recalls the most recent history prompt first", strip(lf() ?? "").includes("second prompt"));
  stdin.write("\x1b[A");                     // ↑ → older
  await tick();
  check("↑ again steps to the older history prompt", strip(lf() ?? "").includes("first prompt") && !strip(lf() ?? "").includes("second prompt"));
  stdin.write("\x1b[B");                     // ↓ → back toward newer
  await tick();
  check("↓ steps back toward newer history", strip(lf() ?? "").includes("second prompt"));
  stdin.write("\r");                         // Enter → re-send the recalled prompt
  await tick();
  check("Enter re-sends a recalled history prompt", sent2 === "second prompt");
  check("re-sending a history prompt leaves history intact", h.history.length === 2);
}

// ── Picker dismiss reason: ← (back) vs Esc (exit) — drives /settings ← → menu, Esc → leave. Both
//    resolve null; they differ via pickerDismiss so plain consumers (/models, /skill) are unaffected. ──
{
  const d = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const d1 = d.pick("M", [{ label: "a", value: "a" }], "a"); await tick(); d.pickerConfirm(); await d1;
  check("pickerConfirm → dismiss=select", d.pickerDismiss === "select");
  const d2 = d.pick("M", [{ label: "a", value: "a" }], "a"); await tick(); d.pickerBack();
  check("pickerBack (←) resolves null + dismiss=back", (await d2) === null && d.pickerDismiss === "back");
  const d3 = d.pick("M", [{ label: "a", value: "a" }], "a"); await tick(); d.pickerCancel();
  check("pickerCancel (Esc) resolves null + dismiss=escape", (await d3) === null && d.pickerDismiss === "escape");
}

// ── ask_user clarification: radio (single), checkbox (multi), the free-text escape hatch, cancel. ──
{
  const a = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  // single-select (radio): ↓ to MySQL, Enter selects it
  const s1 = a.askUser({ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "MySQL" }], multi: false });
  await tick(); a.askMove(1); a.askEnter();
  check("ask single-select resolves the highlighted label", (await s1) === "MySQL");
  // multi-select (checkbox): tick TS (0) and Rust (2), confirm
  const s2 = a.askUser({ question: "Pick langs", options: [{ label: "TS" }, { label: "Go" }, { label: "Rust" }], multi: true });
  await tick(); a.askToggle(); a.askMove(2); a.askToggle(); a.askConfirm();
  check("ask multi-select resolves all ticked labels in order", (await s2) === "TS, Rust");
  // free-text escape hatch (single): move to the last row, Enter opens the editor, type, submit
  const s3 = a.askUser({ question: "Name?", options: [{ label: "A" }], multi: false });
  await tick(); a.askMove(1); a.askEnter();
  check("ask opens the free-text editor on the last row", a.ask?.editing === true);
  a.askEditChange("a custom answer"); a.askEditSubmit();
  check("ask free-text resolves the typed answer", (await s3) === "a custom answer");
  // free-text in multi: edit text, then Enter on the free row confirms (text already present)
  const s4 = a.askUser({ question: "q", options: [{ label: "X" }], multi: true });
  await tick(); a.askToggle();            // tick X
  a.askMove(1); a.askEnter();             // free row → editor
  a.askEditChange("extra"); a.askEditSubmit(); // saves + ticks the free row
  a.askEnter();                            // free row, text present → confirm
  check("ask multi free-text appends the typed answer", (await s4) === "X, extra");
  // cancel
  const s5 = a.askUser({ question: "x", options: [{ label: "A" }], multi: false });
  await tick(); a.askCancel();
  check("ask cancel (←/Esc) resolves null", (await s5) === null);
}

// ask_user rendering: question + header + options + the free-text row; radio vs checkbox markers.
{
  const a = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { lastFrame: af } = render(<TuiApp ctrl={a} />);
  const r1 = a.askUser({ question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "ACID" }, { label: "MySQL" }], multi: false });
  await tick();
  let fr = strip(af() ?? "");
  check("ask renders header + question + options + free-text row",
    fr.includes("DB") && fr.includes("Which database?") && fr.includes("Postgres") && fr.includes("ACID") && fr.includes("Something else"));
  check("ask single-select renders radio markers", fr.includes("(•)") && fr.includes("( )"));
  a.askCancel(); await r1; await tick();
  const r2 = a.askUser({ question: "q", options: [{ label: "X" }, { label: "Y" }], multi: true });
  await tick();
  check("ask multi-select renders checkbox markers", strip(af() ?? "").includes("[ ]"));
  a.askToggle(); await tick();
  check("ask Space ticks a checkbox ([x])", strip(af() ?? "").includes("[x]"));
  a.askCancel(); await r2;
  // progress counter shown when a question is part of a batch
  const r3 = a.askUser({ question: "q", options: [{ label: "X" }], progress: { n: 2, total: 3 } });
  await tick();
  check("ask shows a (n/total) counter for a batched question", strip(af() ?? "").includes("(2/3)"));
  a.askCancel(); await r3;
}

// ── Running-process manager (⌃P): footer indicator, inline list, navigate + kill with x. ──
{
  const reg = new ProcRegistry();
  const killed: Array<string | number | undefined> = [];
  const id1 = reg.add("npm run dev", (sig) => killed.push("dev:" + sig), 111);
  reg.add("sleep 99", (sig) => killed.push("sleep:" + sig), 222);
  const p = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 }, reg);
  check("controller mirrors the process registry", p.procList().length === 2);

  const { lastFrame: pf, stdin: psin } = render(<TuiApp ctrl={p} />);
  await tick();
  let fr = strip(pf() ?? "");
  check("footer shows the running-process count (⚙2)", fr.includes("⚙2 proc"));
  check("inline list shows the running commands + manage hint", fr.includes("npm run dev") && fr.includes("sleep 99") && fr.includes("⌃P"));

  // ⌃P opens the manager (driven through real keystrokes)
  psin.write("\x10"); // Ctrl+P
  await tick();
  check("⌃P opens the process manager", p.procFocus === true && strip(pf() ?? "").includes("Running processes"));

  // ↓ then x kills the highlighted process (the 2nd one)
  psin.write("\x1b[B"); // ↓ → second row
  await tick();
  psin.write("x");
  await tick();
  check("x kills the highlighted process (SIGTERM to that one)", killed.length === 1 && killed[0] === "sleep:SIGTERM");
  check("a killed-but-not-yet-exited process shows 'killing…'", p.procList().some((q) => q.killing));

  // when the registry empties, the manager auto-closes
  reg.remove(id1);
  reg.remove(p.procList().find((q) => q.command === "sleep 99")!.id);
  await tick();
  check("manager auto-closes once no processes remain", p.procFocus === false && p.procList().length === 0);
  // ⌃P is a no-op when there are no processes (never opens an empty panel)
  p.toggleProcs();
  check("⌃P does not open an empty manager", p.procFocus === false);
}

// ── Context-usage bar: % of the model's context window used, colored green<80% · yellow<90% · red≥90%. ──
{
  // threshold colors (unit — Ink's `color=` is stripped in ink-testing-library, so test the logic directly)
  check("contextBar GREEN under 80%", contextBar(100_000, 1_000_000).color === "green" && contextBar(790_000, 1_000_000).color === "green");
  check("contextBar YELLOW at 80–89%", contextBar(800_000, 1_000_000).color === "yellow" && contextBar(880_000, 1_000_000).color === "yellow");
  check("contextBar threshold is consistent with the shown % (89.5%→90%→red, not a yellow '90%')", contextBar(895_000, 1_000_000).pct === 90 && contextBar(895_000, 1_000_000).color === "red");
  check("contextBar RED at ≥90%", contextBar(900_000, 1_000_000).color === "red" && contextBar(999_000, 1_000_000).color === "red");
  check("contextBar reports the percentage", contextBar(420_000, 1_000_000).pct === 42 && contextBar(0, 1_000_000).pct === 0);
  check("contextBar clamps at 100% (never overflows)", contextBar(2_000_000, 1_000_000).pct === 100 && contextBar(2_000_000, 1_000_000).filled === 8);
  check("contextBar fill tracks the percentage", contextBar(500_000, 1_000_000).filled === 4 && contextBar(1_000_000, 1_000_000).filled === 8);

  // footer renders the bar + percentage, and reflects setContext live (qwen → 1,000,000 window)
  const cx = new TuiController({ model: "qwen/qwen3.6-plus", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { lastFrame: cxf } = render(<TuiApp ctrl={cx} />);
  await tick();
  check("footer shows the context bar at 0% on start", strip(cxf() ?? "").includes("ctx") && strip(cxf() ?? "").includes("0%"));
  cx.setContext(850_000);
  await tick();
  check("footer context % updates live (85%) with a filled bar", strip(cxf() ?? "").includes("85%") && (cxf() ?? "").includes("█"));
  cx.setContext(0);
  await tick();
  check("footer context bar returns to 0% (e.g. after /clear)", strip(cxf() ?? "").includes("0%"));
}

// ── Subagent progress (spawn_subagents): footer 🤖N indicator + live panel showing each agent's work. ──
{
  const reg = new AgentRegistry();
  reg.begin();
  const a1 = reg.start("subagent-1", "audit the auth middleware");
  const a2 = reg.start("subagent-2", "research caching options");
  const a = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 }, undefined, reg);
  check("controller mirrors the agent registry", a.agentList().length === 2 && a.agentsRunning() === 2);

  const { lastFrame: af } = render(<TuiApp ctrl={a} />);
  await tick();
  let fr = strip(af() ?? "");
  check("footer shows the running-subagent count (🤖2 agents)", fr.includes("🤖2 agent"));
  check("live panel lists each subagent + its task", fr.includes("subagent-1") && fr.includes("audit the auth") && fr.includes("subagent-2") && fr.includes("research caching"));
  check("panel header shows running/total progress", fr.includes("2 running / 2"));

  // a subagent starts working → its activity (current tool call) shows live
  reg.event(a1, { label: "subagent-1", phase: "start" });
  reg.event(a1, { label: "subagent-1", phase: "tool", tool: "read_file", input: { path: "src/auth.ts" } });
  await tick();
  fr = strip(af() ?? "");
  check("running subagent shows its current activity (the tool call)", fr.includes("read_file") && fr.includes("src/auth.ts"));

  // one finishes, one still running → panel STAYS up and shows the finished one alongside the running one
  reg.event(a1, { label: "subagent-1", phase: "done", inputTokens: 100, outputTokens: 40, ok: true });
  await tick();
  fr = strip(af() ?? "");
  check("panel stays while any subagent runs (shows finished + running)", fr.includes("1 running / 2") && fr.includes("subagent-1") && fr.includes("subagent-2"));

  // whole batch done → the panel COLLAPSES away (we don't linger a finished batch on screen), even
  // though the registry still holds the entries until the turn ends.
  reg.event(a2, { label: "subagent-2", phase: "done", inputTokens: 0, outputTokens: 0, ok: false });
  await tick();
  fr = strip(af() ?? "");
  check("finished batch collapses the panel (nothing running → hidden)", !fr.includes("🤖") && a.agentsRunning() === 0 && a.agentList().length === 2);

  reg.clear();
  await tick();
  check("clearing the registry removes the footer panel", !strip(af() ?? "").includes("🤖"));
}

// ── Even spacing: gap() inserts ONE deduped blank line between stream blocks (user msg · response · tool). ──
{
  const g = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  g.gap();
  check("gap on an empty transcript is a no-op", g.lines.length === 0);
  g.pushLine("› a user message"); g.gap(); g.gap();   // two gaps in a row → still one blank
  g.pushLine("assistant response"); g.gap();
  g.pushLine("  → run_bash: ls");
  const seq = g.lines.map((l) => l.text);
  check("gap never doubles a blank (even spacing)", JSON.stringify(seq) === JSON.stringify(["› a user message", "", "assistant response", "", "  → run_bash: ls"]));
  // during a turn the gap goes into the turn viewport buffer, deduping against the scrollback's last line
  const g2 = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  g2.pushLine("› turn start"); g2.setBusy(true); g2.gap(); g2.pushLine("response");
  check("gap during a turn separates from the prior scrollback line", g2.turnBuf[0]?.text === "" && g2.turnBuf.some((l) => l.text === "response"));
}

// ── Fenced ``` code blocks: the raw fence is replaced by a rule, code lines are VERBATIM (no md). ──
{
  const cb = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  cb.stream("intro **bold**\n```ts\nconst x = `y` + **z**;\n```\noutro\n");
  cb.endStream();
  const t = cb.lines.map((l) => l.text);
  check("prose outside the fence still gets Markdown (md flagged)", cb.lines[0].md === true && t[0] === "intro **bold**");
  check("opening ``` fence replaced by a rule (raw backticks hidden, lang shown)", /╭─ ts/.test(t[1]) && !t[1].includes("```"));
  check("code line is flagged code + kept VERBATIM (no md mangling)", cb.lines[2].code === true && t[2] === "const x = `y` + **z**;");
  check("closing ``` fence replaced by a rule", /╰─/.test(t[3]) && !t[3].includes("```"));
  check("prose after the fence resumes Markdown", cb.lines[4].md === true && t[4] === "outro");
  check("endStream resets the fence state", cb.inCode === false);
  const codeRendered = strip(renderScroll(cb.lines[2]));
  check("a code line renders with a gutter + verbatim text (no bold/inline-code SGR)",
    codeRendered.includes("const x = `y` + **z**;") && codeRendered.startsWith("▏ ") && !renderScroll(cb.lines[2]).includes("[1m"));
}

// ── Provider setup tab (opened from /models): blurb + Local/Remote toggle + URL/key fields + Test/Save/Cancel. ──
{
  const su = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let tested: { url: string; key: string } | null = null;
  const sp = su.providerSetup({
    title: "Set up OpenRouter",
    blurb: ["bring your own OpenRouter key", "for 300+ hosted models"],
    presets: [{ label: "Local", hint: "this machine", url: "http://localhost:3001/v1" }, { label: "Remote", hint: "another host", url: "https://" }],
    keyPrefix: "sk-or-",
    initialUrl: "http://localhost:3001/v1",
    initialKey: "",
    onTest: async (url, key) => { tested = { url, key }; return "✓ connected — 3 model(s) available"; },
  });
  const { lastFrame: sf } = render(<TuiApp ctrl={su} />);
  await tick();
  let fr = strip(sf() ?? "");
  check("setup tab renders title + blurb (users know what it is)", fr.includes("Set up OpenRouter") && fr.includes("bring your own OpenRouter key"));
  check("setup tab shows the Local/Remote location toggle", fr.includes("Location") && fr.includes("◀ Local ▶"));
  check("setup tab shows the prefilled URL + a masked-empty key", fr.includes("http://localhost:3001/v1") && fr.includes("(none)"));
  check("setup tab shows Test/Save/Cancel actions", fr.includes("Test connection") && fr.includes("Save & use") && fr.includes("Cancel"));

  // ←/→ on the location row cycles presets and applies the URL (Local → Remote → https://)
  su.setupCycle(1);
  await tick();
  check("location toggle cycles to Remote + applies its URL", strip(sf() ?? "").includes("◀ Remote ▶") && su.setup?.url === "https://");
  su.setupCycle(1); // back to Local
  check("location toggle wraps back to Local", su.setup?.url === "http://localhost:3001/v1");

  // edit the key field
  su.setupMove(1); // location → url
  su.setupMove(1); // url → key
  check("cursor lands on the key row", su.setupRowKinds()[su.setup!.index] === "key");
  su.setupActivate(); // open the key editor
  check("activating the key row opens the editor", su.setup?.editing === "key");
  su.setupEditChange("sk-or-abc123"); su.setupEditSubmit();
  check("typed key is stored + editor closed", su.setup?.key === "sk-or-abc123" && su.setup?.editing === null);
  await tick();
  check("key renders masked (never shows the raw token)", strip(sf() ?? "").includes("•") && !strip(sf() ?? "").includes("sk-or-abc123"));

  // run the live test → status line appears
  su.setupMove(1); // key → test
  su.setupActivate();
  await tick();
  check("Test connection invokes onTest with the entered url/key", !!tested && (tested as any).url === "http://localhost:3001/v1" && (tested as any).key === "sk-or-abc123");
  check("test result renders under the form", strip(sf() ?? "").includes("✓ connected"));

  // Save resolves with {url, key}
  su.setupMove(1); // test → save
  su.setupActivate();
  const result = await sp;
  check("Save resolves with the entered url + key", !!result && result.url === "http://localhost:3001/v1" && result.key === "sk-or-abc123");
  await tick();
  check("setup tab closes after Save (input restored)", strip(sf() ?? "").includes("type a task, or /"));
}
{
  // Cancel (and Save-with-empty-fields guard)
  const su = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const sp = su.providerSetup({ title: "Set up X", blurb: [], presets: [], keyPrefix: undefined, initialUrl: "", initialKey: "", onTest: async () => "noop" });
  await tick();
  // no presets → the form starts on the url row
  check("with no presets the form has no location row", !su.setupRowKinds().includes("location"));
  // jump to Save with empty url/key → guarded, stays open with a hint
  const rows = su.setupRowKinds();
  su.setup!.index = rows.indexOf("save");
  su.setupActivate();
  check("Save is guarded when url/key are empty (form stays open)", su.setup !== null && (su.setup?.status ?? "").includes("URL and a key"));
  su.setupCancel();
  check("setupCancel resolves null", (await sp) === null);
}

// clipToRow: live partials are clamped to one terminal row (the tail) so a long unbroken line can't
// overflow the dynamic region and corrupt scrollback. Short text passes through unchanged.
{
  check("clipToRow: short text is unchanged", clipToRow("hello", 80) === "hello");
  const long = "x".repeat(500);
  const clipped = clipToRow(long, 40);
  check("clipToRow: long text is clamped to the width", clipped.length === 40);
  check("clipToRow: clamp keeps the TAIL with a leading ellipsis", clipped.startsWith("…") && clipped.endsWith("x"));
  check("clipToRow: a tiny width is floored (never throws / negative)", clipToRow(long, 1).length === 8);
}

// fitTail / lineRows: the live turn viewport must be bounded by real TERMINAL ROWS (wrapping included),
// not logical lines — otherwise a long agent response (or queued prompts / slash menu pushing it down)
// overflows the dynamic region and Ink's <Static> erase wipes committed scrollback. Regression for the
// "agent output disappears, prompt bars remain" report.
{
  const mk = (text: string, i: number) => ({ id: i, text });
  check("lineRows: a short line is 1 row", lineRows(mk("hello", 0), 80) === 1);
  check("lineRows: an empty line is 1 row", lineRows(mk("", 0), 80) === 1);
  check("lineRows: a wide line wraps (ceil width/cols)", lineRows(mk("x".repeat(170), 0), 80) === 3);

  const items = ["a", "b", "c", "d", "e"].map(mk);
  check("fitTail: takes the trailing lines that fit", fitTail(items, 3, 80).map((i) => i.text).join("") === "cde");
  check("fitTail: returns all when they fit", fitTail(items, 99, 80).length === 5);
  check("fitTail: maxRows<=0 → none", fitTail(items, 0, 80).length === 0);
  check("fitTail: always keeps the newest line even if it alone overflows", fitTail([mk("x".repeat(300), 0)], 1, 80).length === 1);

  // a wide middle line counts as 2 rows, so only 2 logical lines fit in 3 terminal rows
  const wide = [mk("a", 0), mk("x".repeat(160), 1), mk("c", 2)];
  const ft = fitTail(wide, 3, 80);
  check("fitTail: counts WRAPPED rows, not logical lines", ft.length === 2 && ft[0].text.length === 160 && ft[1].text === "c");
}

// Integration: a long busy turn (+ queued prompts taking dynamic-region rows) must render a BOUNDED live
// viewport — the newest lines show, the oldest are held back in turnBuf (flushed to <Static> at turn end).
{
  const vc = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  vc.setBusy(true);
  vc.enqueue("queued one"); vc.enqueue("queued two"); // these consume dynamic-region rows (chrome)
  for (let i = 0; i < 120; i++) vc.pushLine(`turnline-${i}`); // busy → into turnBuf, not <Static>
  const { lastFrame: vf } = render(<TuiApp ctrl={vc} />);
  await tick();
  const vfr = strip(vf() ?? "");
  check("viewport renders the NEWEST turn line", vfr.includes("turnline-119"));
  check("viewport is BOUNDED (oldest turn line held back, not rendered)", !vfr.includes("turnline-0"));
  vc.setBusy(false);
}

// router-resolved footer: an `auto` request that resolved to a concrete model shows "auto → <label>",
// prices/sizes off the resolved model, and marks an estimated meter with "(est)".
{
  const rc = new TuiController({ model: "auto", mode: "solo", plan: false, inTok: 1000, outTok: 500, cacheTok: 0 });
  const { lastFrame } = render(<TuiApp ctrl={rc} />);
  await tick();
  check("auto with no resolution yet shows the bare alias", strip(lastFrame() ?? "").includes("auto"));
  rc.setStatus({ resolvedModel: "deepseek/deepseek-v4-pro", estTok: true });
  await tick();
  const rf = strip(lastFrame() ?? "");
  check("resolved router model renders 'auto → <label>'", rf.includes("auto → DeepSeek V4 Pro"));
  check("estimated meter is marked (est)", rf.includes("(est)"));
}

// ── /rewind input prefill: the controller can drop a rewound prompt back into the input box ──
{
  const rc = new TuiController({ model: "qwen/qwen3.6-plus", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { lastFrame: rcf } = render(<TuiApp ctrl={rc} />);
  await tick();
  check("ctrl.setInput is registered by the TuiApp", typeof rc.setInput === "function");
  check("input box starts without the rewound text", !strip(rcf() ?? "").includes("the rewound prompt"));
  rc.setInput?.("the rewound prompt");
  await tick();
  check("setInput repopulates the input box (rewound prompt reappears, ready to edit/run)", strip(rcf() ?? "").includes("the rewound prompt"));
}

// ── "Get Intelligent Models" footer button: shown only when eligible; ↓ focuses, Enter activates, ↑ returns ──
{
  // Not eligible (default) → no banner.
  const ne = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  const { lastFrame: nef } = render(<TuiApp ctrl={ne} />);
  await tick();
  check("upsell banner hidden when not eligible", !strip(nef() ?? "").includes("Get Intelligent Models"));

  // Eligible (Free LLM API) → banner shows with the ↓ hint.
  const uc = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let opened = 0;
  uc.upsellEligible = () => true;
  uc.onUpsell = () => { opened++; };
  const { stdin: uin, lastFrame: ucf } = render(<TuiApp ctrl={uc} />);
  await tick();
  check("upsell banner shows when eligible", strip(ucf() ?? "").includes("✨ Get Intelligent Models"));
  check("banner shows the ↓ hint while input is focused", strip(ucf() ?? "").includes("↓ to see plans"));

  uin.write("\x1b[B"); // ↓ — move focus onto the button
  await tick();
  check("↓ focuses the button", uc.upsellFocus === true);
  check("focused button shows the Enter/↑ hints", strip(ucf() ?? "").includes("Enter") && strip(ucf() ?? "").includes("↑ back"));

  uin.write("\r"); // Enter — open the pricing page
  await tick();
  check("Enter on the button opens the pricing page (onUpsell fired)", opened === 1);
  check("activating returns focus to the input", uc.upsellFocus === false);

  uin.write("\x1b[B"); // ↓ again to re-focus
  await tick();
  check("↓ re-focuses the button", uc.upsellFocus === true);
  uin.write("\x1b[A"); // ↑ — back to the input without opening
  await tick();
  check("↑ returns to the input without opening the page", uc.upsellFocus === false && opened === 1);
}

// ── Most-recent error action: ↑ from the input focuses it, Enter opens it, ↓/Esc return; next prompt clears ──
{
  const ec = new TuiController({ model: "m", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
  let openedUrl = "";
  ec.onErrorAction = (url) => { openedUrl = url; };
  const { stdin: ein, lastFrame: ef } = render(<TuiApp ctrl={ec} />);
  await tick();
  check("no error-action banner when there's no parked action", !strip(ef() ?? "").includes("↗"));

  // A turn ends with an actionable error → park the action.
  ec.setErrorAction({ label: "Upgrade your plan", url: "http://localhost:8787/upgrade" });
  await tick();
  let f = strip(ef() ?? "");
  check("error-action banner shows the label + ↑ hint", f.includes("↗ Upgrade your plan") && f.includes("↑ to open"));

  ein.write("\x1b[A"); // ↑ — focus the action
  await tick();
  check("↑ focuses the error action", ec.errorFocus === true);
  check("focused action shows Enter/↓ hints", strip(ef() ?? "").includes("Enter → open") && strip(ef() ?? "").includes("↓ back"));

  ein.write("\r"); // Enter — open it in the browser
  await tick();
  check("Enter opens the parked url (onErrorAction fired with the url)", openedUrl === "http://localhost:8787/upgrade");
  check("activating returns focus to the input", ec.errorFocus === false);

  ein.write("\x1b[A"); // ↑ re-focus, then Esc returns without re-opening
  await tick();
  check("↑ re-focuses the action", ec.errorFocus === true);
  ein.write("\x1b"); // Esc
  await tick();
  check("Esc returns to the input without re-opening", ec.errorFocus === false);

  // Submitting a new prompt clears the parked action.
  ec.pushUser("next task");
  await tick();
  check("a new prompt clears the parked error action", ec.lastErrorAction === undefined && !strip(ef() ?? "").includes("↗ Upgrade"));
}

if (fail) { console.error("\n✗ tui smoke FAILED"); process.exit(1); }
console.log("\n✓ tui smoke passed (status bar + live token/cost meter + scrollback + streaming + approval + provider setup tab + upsell footer button + clip/router-footer)");
process.exit(0);
