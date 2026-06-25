// No-model TUI streaming probe: drives a TuiController through startTui (real Ink render) so a PTY
// driver (scripts/stream-pty.py) can watch the actual screen over time. Exercises (a) the blank-line
// gap between tool calls and (b) line-by-line streaming, to check both stay visible / don't vanish.
// Not a standalone test — run via scripts/stream-pty.py.
import { TuiController, startTui } from "../src/cli/tui.tsx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctrl = new TuiController({ model: "probe", mode: "solo", plan: false, inTok: 0, outTok: 0, cacheTok: 0 });
const app = startTui(ctrl);

(async () => {
  await sleep(250);
  // A turn starts: busy is set FIRST (as in the real drain loop), so the whole turn's output streams
  // into <Static> with no tall dynamic region beneath it.
  ctrl.setBusy(true);
  // Gap test: an empty pushLine between two content lines should render a VISIBLE blank row.
  ctrl.pushLine("GAPABOVE marker line");
  ctrl.pushLine("");
  ctrl.pushLine("GAPBELOW marker line");
  // Simulate a tool call with the loop's leading blank-line gap.
  ctrl.pushLine("");
  ctrl.pushLine("  → run_bash: echo TOOLCALL");
  await sleep(300);

  // Realistic case: a response TALLER than the terminal, with normal per-line newlines. Stream ~30
  // short lines; the screen scrolls so early lines legitimately leave the viewport, but the most
  // recent lines must stay visible and stable (no vanish, no duplicated input box / garbage).
  let resp = "";
  for (let i = 1; i <= 30; i++) resp += `STREAML${i} line number ${i} of a long streamed answer\n`;
  // Stream in small chunks with a per-chunk pause ABOVE the driver's 30ms settle window, so each chunk
  // produces a settled, sampleable intermediate frame (that's what the progressive / pinned-input checks
  // observe). The driver's read cap (raised generously) must exceed the resulting total runtime even on a
  // slow CI runner — otherwise it cut off mid-stream and never saw the final lines (STREAML30).
  for (const ch of resp.match(/.{1,6}/gs) ?? []) { ctrl.stream(ch); await sleep(35); }

  await sleep(1200); // MID checkpoint — recent lines visible & stable while the screen scrolls
  ctrl.endStream();
  ctrl.setBusy(false);
  await sleep(600);  // END checkpoint — all five lines committed & visible
  ctrl.exit();
})();

await app.waitUntilExit();
// Let Ink's final frame fully drain to the (P)TY before hard-exiting. process.exit(0) can otherwise
// terminate mid-write on a slower CI runner, truncating the last repaint — the captured screen then
// shows a half-written final line and drops the most recent streamed line (CI-only flake). The delay
// lets the buffered terminal write reach the fd first.
await sleep(300);
process.exit(0);
