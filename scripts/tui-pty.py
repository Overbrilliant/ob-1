#!/usr/bin/env python3
# Real-PTY end-to-end test for the OB-1 Ink TUI.
#
# The tui-smoke (ink-testing-library) renders <TuiApp> in memory — it can NOT exercise the one thing
# that only happens on a real terminal: Ink putting stdin into RAW MODE and the binary's
# `stdin.isTTY` branch choosing the Ink TUI over the readline REPL. This test spawns the ACTUAL
# binary attached to a pseudo-terminal, so isTTY is true and raw mode engages, then drives it with
# keystrokes and asserts the live rendering responds:
#   • boots into the Ink TUI (banner + "OB-1" status bar + input placeholder render in raw mode)
#   • a typed slash-command + Enter is accepted and dispatched (/help renders the command list)
#   • a command mutates live state (/mode fusion re-renders with the fusion description)
#   • PERSISTENCE: committed scrollback (the `› /help` echo, a pushLine→<Static> commit) is still on
#     screen at the END — this catches the "response appears then vanishes" class of bug, where a
#     mutated-in-place <Static> items array never flushes lines pushed after the first render. The
#     final screen is reconstructed with a real terminal emulator (pyte) honouring cursor-up/erase.
#   • /exit unwinds Ink cleanly and the process exits 0
#
# Hermetic: runs in a throwaway temp cwd with a clean env (no .env / API key / MCP config loaded),
# so it makes no network calls and spends no tokens. Works on macOS and Linux. The persistence check
# needs `pyte` (the only optional dep); if it's missing the check is SKIPPED with a loud note — CI
# installs it so the regression is always guarded there. Usage: python3 scripts/tui-pty.py
import os, sys, pty, select, time, re, shutil, tempfile, struct, fcntl, termios, signal
try:
    import pyte  # optional: real terminal emulator for the final-screen persistence assertion
except ImportError:
    pyte = None

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join(REPO, "src", "index.ts")
# Strip CSI/escape sequences (colors, cursor moves, erase-line) + bare CRs so we can match on text.
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b[=>cM]|\r")

failures = []
def check(name, ok, extra=""):
    mark = "✓" if ok else "✗"
    print(f"{mark} {name}" + (f" — {extra}" if extra else ""))
    if not ok:
        failures.append(name)

def fail_out(msg):
    print(f"✗ {msg}")
    failures.append(msg)

bun = shutil.which("bun")
if not bun:
    print("• skipped — bun not on PATH")
    sys.exit(0)

tmp = tempfile.mkdtemp(prefix="ob1-tui-pty-")
# Clean, minimal env, cwd=tmp so Bun loads no .env and finds no .ob1/mcp.json. A DUMMY OpenRouter key
# configures a provider (never used — we submit no model task) so /models opens the static model
# PICKER rather than the provider-setup tab (which is what /models does when nothing is configured).
# OB1_MODEL pins the highlight to the FIRST registry entry so one ↓ lands on a real model, not the
# appended "Connect FreeLLMAPI" row. NO inherited CI flag.
env = {
    "PATH": os.environ.get("PATH", ""),
    "HOME": tmp,
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",  # so hex colours (the grey user-message bar) pass through truecolor, not downsampled
    "LANG": os.environ.get("LANG", "en_US.UTF-8"),
    "OB1_SANDBOX": "off",
    "OPENROUTER_API_KEY": "dummy-tui-pty-test-key",
    "OB1_MODEL": "anthropic/claude-opus-4.8",
}

pid, fd = pty.fork()
if pid == 0:  # ── child: becomes the controlling TTY, then exec the real binary ──
    try:
        os.chdir(tmp)
        os.execve(bun, [bun, "run", ENTRY], env)
    except Exception as e:
        sys.stderr.write(f"exec failed: {e}\n")
    os._exit(127)

# ── parent: drive the PTY master ──────────────────────────────────────────────────────────────────
# Give Ink a real window size so it lays out the flex columns instead of wrapping to nothing.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

buf = bytearray()
eof = False

def pump(window=0.25):
    """Drain whatever the child has emitted into the cumulative buffer for up to `window` seconds."""
    global eof
    end = time.time() + window
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            break
        try:
            r, _, _ = select.select([fd], [], [], remaining)
        except (OSError, ValueError):
            eof = True
            break
        if fd not in r:
            break
        try:
            data = os.read(fd, 65536)
        except OSError:  # EIO on Linux when the slave side closes
            eof = True
            break
        if not data:
            eof = True
            break
        buf.extend(data)

def text():
    return ANSI.sub(b"", bytes(buf)).decode("utf-8", "replace")

def wait_for(substrs, timeout=10.0):
    """True once ALL substrings have appeared in the cumulative (ANSI-stripped) output."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pump(0.2)
        t = text()
        if all(s in t for s in substrs):
            return True
        if eof:
            break
    return all(s in text() for s in substrs)

def send(s):
    os.write(fd, s.encode())

def submit(line):
    """Type a line, let Ink render it, then send a LONE carriage return. Ink parses a multi-byte
    read as a paste, so `line\\r` in one write is NOT seen as the Return key — the \\r must arrive
    on its own for ink-text-input's onSubmit to fire."""
    send(line)
    pump(0.4)
    send("\r")
    pump(0.3)

# Hard ceiling so a hung TUI can never wedge CI.
def _timeout(signum, frame):
    try: os.kill(pid, signal.SIGKILL)
    except OSError: pass
    print("✗ TUI PTY test TIMED OUT")
    print("---- captured output ----")
    print(text()[-2000:])
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(1)
signal.signal(signal.SIGALRM, _timeout)
signal.alarm(90)

exit_code = None
try:
    # 1) Boots into the Ink TUI in raw mode (bun cold-start + first render can take a few seconds).
    booted = wait_for(["OB-1", "type a task, or / for commands"], timeout=30.0)
    t = text()
    check("TUI boots into Ink raw-mode on a real PTY (status bar + input render)", booted)
    check("banner rendered", "token-efficient coding agent" in t)
    check("status bar shows brand + mode + phase", ("OB-1" in t) and ("solo" in t) and ("act" in t))
    check("input prompt renders with placeholder", "type a task, or / for commands" in t)
    check("input box rendered with a rounded border", "╭" in t)
    if not booted:
        raise RuntimeError("TUI never reached interactive state")

    # 1a2) Ctrl+O toggles the reasoning indicator in the status bar (off shows "⌃O reasoning",
    #      on shows "💭reasoning"). A pure UI toggle — no model call needed.
    check("status bar shows the ⌃O reasoning hint by default", "⌃O reasoning" in text())
    send("\x0f")  # Ctrl+O
    on = wait_for(["💭reasoning"], timeout=4.0)
    check("Ctrl+O turns reasoning ON (💭reasoning shown)", on)
    send("\x0f")  # Ctrl+O again → back off
    pump(0.4)

    # 1b) Typing "/" opens the command menu (discovery without needing to know /help).
    send("/")
    menu = wait_for(["↑↓ navigate"], timeout=6.0)
    check("typing / opens the command menu", menu)
    send("\x7f")  # backspace clears the slash so the next step starts clean
    pump(0.3)

    # 2) A typed slash-command + Enter is accepted and dispatched in raw mode.
    submit("/help")
    helped = wait_for(["ranked repository map (symbols by centrality)"], timeout=10.0)  # a HELP-only line
    check("keystrokes + Enter accepted in raw mode (/help renders command list)", helped)

    # 3) A command mutates live state and the TUI re-renders.
    submit("/mode fusion")
    switched = wait_for(["synthesizer merges the best parts"], timeout=10.0)  # the fusion-mode note
    check("/mode fusion dispatched + live re-render", switched)

    # 3b) Settings are no longer one menu — the old /settings picker was removed and every setting is now
    #     a first-class command. /settings just prints a redirect to those commands; /permission opens the
    #     interactive ask/autopilot picker. Assert both: the redirect text, then drive the /permission
    #     picker to "ask" via arrow nav (no typing). The picker opens highlighted on the autopilot DEFAULT,
    #     so one ↑ moves to ask. "use with care" is the autopilot hint — unique to this picker, so matching
    #     it (not "autopilot", which the earlier /help list already printed) confirms the picker rendered.
    submit("/settings")
    redirect_ok = wait_for(["individual commands"], timeout=8.0)
    check("/settings redirects to the individual setting commands", redirect_ok)

    submit("/permission")
    perm_open = wait_for(["use with care"], timeout=8.0)
    check("/permission opens the ask/autopilot picker", perm_open)
    send("\x1b[A")                                   # autopilot (default highlight) → ask
    pump(0.4)
    send("\r")                                       # select ask
    autop = wait_for(["permission → ask"], timeout=6.0)
    check("/permission set to ask via the picker", autop)
    pump(0.5)

    # 3c) /models opens an interactive picker; arrow + Enter acts on the highlighted model. This PTY
    #     session has no managed-server subscription (no auth token), so frontier models are LOCKED (🔒)
    #     and selecting one routes to pricing instead of switching. We assert that gated flow — the
    #     no-typing arrow+Enter SELECTION mechanic is what's under test, not the destination.
    submit("/models")
    picker_open = wait_for(["Select a model", "navigate"], timeout=8.0)
    check("/models opens an interactive picker", picker_open)
    send("\x1b[B")   # down arrow moves the highlight to another model
    pump(0.4)
    send("\r")        # Enter selects the highlighted (locked) frontier model
    picked = wait_for(["opening pricing", "subscription"], timeout=6.0)
    check("arrow + Enter selects a model from the picker (locked → pricing)", picked)

    # 3d) BARE /mode (no argument) opens the same arrow-key picker — the no-typing selection flow.
    #     Mode is "fusion" here (set in step 3), so one ↓ lands deterministically on "council".
    submit("/mode")
    mode_picker = wait_for(["one model, one pass"], timeout=8.0)  # solo's hint — only the mode picker renders it
    check("bare /mode opens an interactive picker (no typing)", mode_picker)
    send("\x1b[B")   # fusion → council
    pump(0.4)
    send("\r")
    mode_set = wait_for(["mode → council"], timeout=6.0)
    check("arrow + Enter selects a mode from the picker", mode_set)

    # 3e) BARE /sandbox opens its picker too. Sandbox is "off" here, so one ↓ lands on "read-only".
    submit("/sandbox")
    sb_picker = wait_for(["the shell runs unrestricted"], timeout=8.0)  # off's hint — unique to the sandbox picker
    check("bare /sandbox opens an interactive picker (no typing)", sb_picker)
    send("\x1b[B")   # off → read-only
    pump(0.4)
    send("\r")
    sb_set = wait_for(["sandbox → read-only"], timeout=6.0)
    check("arrow + Enter selects a sandbox level from the picker", sb_set)

    # 4) /exit unwinds Ink cleanly and the process exits 0.
    submit("/exit")
    wait_for(["bye"], timeout=10.0)
    # Drain to EOF, then reap.
    while not eof:
        pump(0.3)
    _, status = os.waitpid(pid, 0)
    exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
    check("clean exit via /exit (process exits 0)", exit_code == 0, f"exit={exit_code}")
finally:
    signal.alarm(0)
    try: os.close(fd)
    except OSError: pass
    if exit_code is None:
        try: os.kill(pid, signal.SIGKILL)
        except OSError: pass
        try: os.waitpid(pid, 0)
        except OSError: pass
    shutil.rmtree(tmp, ignore_errors=True)

# 5) PERSISTENCE: reconstruct the FINAL screen (scrollback + viewport) and assert the committed
#    output is still there. Cumulative byte checks above pass even if content appears-then-vanishes,
#    so this is what actually catches the "<Static> never flushed post-render commits" regression.
if pyte is not None:
    screen = pyte.HistoryScreen(120, 40, history=1000, ratio=0.5)
    pyte.ByteStream(screen).feed(bytes(buf))
    top = ["".join(row[c].data for c in range(screen.columns)) for row in screen.history.top]
    final = "\n".join(top + screen.display)
    # The `› /help` echo is pushed via ctrl.pushLine → <Static> (the exact path that vanished); if the
    # commit didn't persist it won't be on the final screen even though it streamed by earlier.
    check("committed scrollback PERSISTS on final screen (no vanish)", "› /help" in final,
          "echo line missing from final render" if "› /help" not in final else "")
    check("/help body still visible at end", "ranked repository map (symbols by centrality)" in final)
    # The `› /help` echo is a USER message → rendered as a grey bar (non-default background, white text).
    # Find its row (history or live display) and assert at least one cell carries a background colour.
    def user_row_cells():
        for row in screen.history.top:
            if "› /help" in "".join(row[c].data for c in range(screen.columns)):
                return [row[c] for c in range(screen.columns)]
        for i, line in enumerate(screen.display):
            if "› /help" in line:
                return [screen.buffer[i][c] for c in range(screen.columns)]
        return None
    cells = user_row_cells()
    WHITE = ("ffffff", "brightwhite", "white")   # truecolor hex, or the named fallbacks
    DARK_GREY = ("3a3a3a",)                        # the bar's background (#3a3a3a)
    # Background: the bar is a dark grey (#3a3a3a) — not the terminal default.
    bg_grey = cells is not None and any(getattr(cl, "bg", "default") in DARK_GREY for cl in cells)
    check("user message renders on a dark-grey background (#3a3a3a)", bg_grey,
          "" if bg_grey else ("could not find the › /help row" if cells is None else "no cell on the › /help row had the grey background"))
    # Legibility: the text must be PURE white (#ffffff) — not the dull theme-dependent ANSI white that
    # rendered greyish. Check the glyph cells (skip the trailing padding).
    glyph = [cl for cl in (cells or []) if getattr(cl, "data", " ").strip()]
    fg_white = bool(glyph) and all(getattr(cl, "fg", "default") in WHITE for cl in glyph)
    check("user message text is pure white (#ffffff) for legibility", fg_white,
          "" if fg_white else "text on the › /help row is not pure white")
else:
    print("• persistence check SKIPPED — pyte not installed (pip install pyte). CI enforces it.")

if failures:
    print("\n✗ TUI PTY e2e FAILED")
    print("---- last 1500 chars of captured output ----")
    print(text()[-1500:])
    sys.exit(1)
print("\n✓ TUI PTY e2e passed — real pseudo-terminal: Ink raw-mode boot, keystroke dispatch, live re-render, clean exit")
sys.exit(0)
