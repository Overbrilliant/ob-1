#!/usr/bin/env python3
# PTY driver for scripts/_stream_probe.tsx: runs the probe under a real pseudo-terminal, feeds its
# output into a pyte screen, and samples the reconstructed screen over time. Then checks that:
#   1. an empty pushLine renders a VISIBLE blank row (the gap between tool calls), and
#   2. streamed lines, once they appear, STAY visible (don't vanish mid-stream) and all show at the end.
# Exit 0 = pass. Usage: /tmp/obvenv/bin/python scripts/stream-pty.py   (needs pyte)
import os, pty, sys, time, select, struct, fcntl, termios
try:
    import pyte
except ImportError:
    print("pyte not installed; skipping (install in the venv to run this check)"); sys.exit(0)

ROWS, COLS = 20, 70  # small terminal so a long streamed block overflows the screen height
HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "_stream_probe.tsx")

def run():
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    pid, fd = pty.fork()
    if pid == 0:  # child → exec the probe under the PTY
        os.environ["TERM"] = "xterm"; os.environ["COLUMNS"] = str(COLS); os.environ["LINES"] = str(ROWS)
        # Ink (via is-in-ci) drops to NON-interactive rendering when CI/CONTINUOUS_INTEGRATION is set —
        # it then paints only the final frame, so the mid-stream/progressive checks below never see an
        # intermediate state and fail (only under CI). We drive a REAL pty here, so the honest thing to
        # test is the interactive behavior a real user gets; scrub the leaked CI vars so Ink renders live.
        for k in ("CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS"): os.environ.pop(k, None)
        os.execvp("bun", ["bun", "run", PROBE])
        os._exit(127)
    # Tell the child its terminal is exactly ROWS×COLS (matching the pyte screen), so the app sizes its
    # bounded viewport to the same height pyte renders.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    snapshots = []  # (t, [line, ...]) screen states over time
    t0 = time.time()
    last_snap = -1.0
    alive = True
    try:
        while alive:
            # Settle the screen before sampling: drain ALL currently-available output until the stream
            # has been quiet for ~30ms. Ink repaints by erasing rows then rewriting them; sampling on a
            # blind timer can land BETWEEN the erase and the rewrite and capture a half-drawn frame (the
            # input box / content momentarily "gone"). Only snapshotting a settled stream guarantees each
            # capture is a COMPLETE frame, which is what we actually want to assert about — and removes the
            # CI-only flakiness where the slower box happened to be mid-repaint at the 150ms tick.
            while True:
                r, _, _ = select.select([fd], [], [], 0.03)
                if not r:
                    break  # quiet → Ink's frame is fully written
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    alive = False; break
                if not data:
                    alive = False; break
                stream.feed(data)
            now = time.time() - t0
            if now - last_snap >= 0.1:  # pace settled samples ~every 100ms
                snapshots.append((now, [screen.display[i].rstrip() for i in range(ROWS)]))
                last_snap = now
            if now > 40:  # generous cap: must exceed the probe's full runtime (~12s) even on a slow CI
                break        # runner — the loop normally ends earlier on EOF when the probe exits.
    finally:
        try: os.close(fd)
        except OSError: pass
        try: os.waitpid(pid, 0)
        except OSError: pass
    # final snapshot
    snapshots.append((time.time() - t0, [screen.display[i].rstrip() for i in range(ROWS)]))
    return snapshots

def visible(snap_lines, needle):
    return any(needle in ln for ln in snap_lines)

def first_seen(snaps, needle):
    for i, (_, lines) in enumerate(snaps):
        if visible(lines, needle):
            return i
    return -1

def main():
    snaps = run()
    fails = []
    def check(name, ok):
        print(("✓" if ok else "✗") + " " + name)
        if not ok: fails.append(name)

    final = snaps[-1][1]

    # 1. Gap visibility — in the earliest snapshot showing both gap markers (before they scroll off),
    #    there is a VISIBLE blank row between them (an empty pushLine renders a real row).
    gap_ok = False; gap_seen = False
    for _, lines in snaps:
        a = next((i for i, ln in enumerate(lines) if "GAPABOVE" in ln), -1)
        b = next((i for i, ln in enumerate(lines) if "GAPBELOW" in ln), -1)
        if a >= 0 and b >= 0:
            gap_seen = True
            gap_ok = (b - a == 2 and lines[a + 1].strip() == "")
            break
    check("gap markers rendered with a VISIBLE blank row between them", gap_seen and gap_ok)

    # 2. The input box STAYS visible while streaming (the user's requirement) and is NEVER duplicated.
    is_input = lambda ln: ("type a task" in ln) or ("another task" in ln)
    input_counts = [sum(1 for ln in lines if is_input(ln)) for _, lines in snaps]
    check("input box never duplicated (no overflow garbage)", max(input_counts) <= 1)
    mid = [lines for _, lines in snaps if visible(lines, "STREAML") and not visible(lines, "STREAML30")]
    check("input box stays visible WHILE streaming (does not disappear)",
          len(mid) > 0 and all(any(is_input(ln) for ln in lines) for lines in mid))
    check("final screen has exactly one clean input box", sum(1 for ln in final if is_input(ln)) == 1)

    # 3. Streaming stays coherent — after content first appears, no snapshot has a blank/garbled content
    #    area (a "vanish"); every later snapshot still shows some streamed line.
    started_at = next((i for i, (_, lines) in enumerate(snaps) if visible(lines, "STREAML")), -1)
    coherent = started_at >= 0 and all(visible(snaps[j][1], "STREAML") for j in range(started_at, len(snaps)))
    check("streamed content stays on screen throughout (no vanish to blank)", coherent)

    # 4. Progressive — lines appear DURING streaming, not only at the end (some snapshot shows streamed
    #    lines while the final line STREAML30 is not yet present).
    progressive = any(visible(lines, "STREAML") and not visible(lines, "STREAML30") for _, lines in snaps)
    check("lines render progressively while streaming (not only at the end)", progressive)

    # 5. The most recent lines are visible & stable at the end.
    check("final screen shows the most recent streamed lines", visible(final, "STREAML30") and visible(final, "STREAML29"))

    # 6. Busy loader: an animated "working" indicator + a live ~token counter are visible WHILE
    #    streaming. (That the loader CLEARS when busy ends is deterministic React state, checked in
    #    tui-smoke — not asserted on the final PTY frame: Ink leaves the last dynamic frame painted on
    #    unmount, so the post-exit capture can still show the busy footer on slow runners.)
    mid_busy = [lines for _, lines in snaps if visible(lines, "STREAML") and not visible(lines, "STREAML30")]
    check("loader 'working' indicator shown while streaming", len(mid_busy) > 0 and any(visible(lines, "working") for lines in mid_busy))
    check("live token counter ('tok') shown while streaming", any(visible(lines, "tok") for lines in mid_busy))

    if fails:
        print("\n--- FINAL SCREEN ---")
        for ln in final:
            if ln.strip(): print("  | " + ln)
        print(f"\n✗ stream PTY probe FAILED: {', '.join(fails)}")
        sys.exit(1)
    print("\n✓ stream PTY probe passed (gap visible · no garbage · progressive · stable)")
    sys.exit(0)

if __name__ == "__main__":
    main()
