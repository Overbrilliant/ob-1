#!/usr/bin/env python3
"""Fresh-install embedded free-models journey smoke.

Drives an installed `ob1` binary through the real first-run path:
Start free -> skip adding keys -> send one tiny prompt through the embedded free router.
The live first-token step soft-warns when public free pools are temporarily exhausted.
"""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b[=>cM]|\r")
sys.stdout.reconfigure(line_buffering=True)


def strip_ansi(buf: bytearray | bytes) -> str:
    raw = bytes(buf) if isinstance(buf, bytearray) else buf
    return ANSI.sub(b"", raw).decode("utf-8", "replace")


def fail(message: str, output: str = "") -> None:
    print(f"x {message}")
    if output:
        print("\n--- captured output tail ---")
        print(output[-5000:])
    sys.exit(1)


def soft_warn(message: str, detail: str = "") -> int:
    print(f"::warning::{message}")
    print(f"- {message}")
    if detail:
        print(detail[-5000:])
    return 0


def looks_like_public_pool_exhaustion(text: str) -> bool:
    return bool(
        re.search(
            r"\b(401|403|429|502|503|504)\b|rate.?limit|too many requests|quota|capacity|exhaust|"
            r"temporar(il)?y|unavailable|busy|no available|provider.*down|all free models",
            text,
            re.IGNORECASE,
        )
    )


def cleanup(tmp: str) -> None:
    if os.environ.get("OB1_KEEP_FREE_E2E_TMP") == "1":
        print(f"- kept temp dir: {tmp}")
        return
    shutil.rmtree(tmp, ignore_errors=True)


def run_onboard(ob1_bin: str, env: dict[str, str], work_dir: str, settings_dir: str) -> None:
    buf = bytearray()
    pid = None
    fd = None
    child_exit_code = None

    try:
        print("-> running `ob1 onboard` in a real terminal")
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(work_dir)
                os.execvpe(ob1_bin, [ob1_bin, "onboard"], env)
            except Exception as exc:
                sys.stderr.write(f"exec failed: {exc}\n")
            os._exit(127)

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

        def pump(window: float = 0.25) -> None:
            end = time.time() + window
            while time.time() < end:
                try:
                    ready, _, _ = select.select([fd], [], [], max(0, end - time.time()))
                except OSError:
                    return
                if fd not in ready:
                    return
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                buf.extend(data)

        def poll_child() -> bool:
            nonlocal child_exit_code
            if child_exit_code is not None:
                return True
            if pid is None:
                return False
            try:
                done, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return child_exit_code is not None
            if done:
                child_exit_code = os.waitstatus_to_exitcode(status)
                return True
            return False

        def wait_for(needle: str, timeout: float) -> bool:
            deadline = time.time() + timeout
            while time.time() < deadline:
                pump(0.2)
                if needle in strip_ansi(buf):
                    return True
                if poll_child():
                    return needle in strip_ansi(buf)
            return False

        if not wait_for("How do you want to run models?", 30):
            fail("onboarding picker did not render", strip_ansi(buf))
        os.write(fd, b"\r")  # Start free is the default selection.

        if not wait_for("Add your free API keys now?", 30):
            fail("free keys prompt did not render", strip_ansi(buf))
        os.write(fd, b"\x1b")  # Esc skips adding keys; keyless providers should still work.

        deadline = time.time() + 60
        exit_code = None
        while time.time() < deadline:
            pump(0.2)
            if poll_child():
                exit_code = child_exit_code
                break
        if exit_code is None:
            os.kill(pid, signal.SIGKILL)
            fail("onboarding did not exit after selecting free setup", strip_ansi(buf))
        if exit_code != 0:
            fail(f"onboarding exited {exit_code}", strip_ansi(buf))

        output = strip_ansi(buf)
        if "Free models are on" not in output:
            fail("onboarding did not report free-model activation", output)

        settings_path = os.path.join(settings_dir, "settings.json")
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
        if settings.get("providerProfile") != "free" or settings.get("model") != "auto":
            fail(f"expected free/auto settings, got {settings}", output)
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def run_first_token(ob1_bin: str, env: dict[str, str], work_dir: str) -> int:
    print("-> sending first prompt through the embedded free router")
    prompt = "Reply with exactly: OB-1 online.\n"
    proc = subprocess.run(
        [ob1_bin],
        input=prompt,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=work_dir,
        env=env,
        timeout=180,
    )
    output = strip_ansi(proc.stdout.encode("utf-8", "replace"))
    if proc.returncode == 0 and re.search(r"OB-1 online|online", output, re.IGNORECASE):
        print("ok first-token prompt succeeded")
        return 0
    if looks_like_public_pool_exhaustion(output):
        return soft_warn("Embedded free router installed, but public keyless pools were unavailable.", output)
    fail(f"first-token prompt failed with exit {proc.returncode}", output)
    return 1


def main() -> int:
    ob1_bin = os.environ.get("OB1_BIN") or shutil.which("ob1")
    if not ob1_bin:
        fail("set OB1_BIN or put ob1 on PATH")

    tmp = tempfile.mkdtemp(prefix="ob1-free-first-token-")
    settings_dir = os.path.join(tmp, "settings")
    home_dir = os.path.join(tmp, "home")
    work_dir = os.path.join(tmp, "work")
    os.makedirs(settings_dir, exist_ok=True)
    os.makedirs(home_dir, exist_ok=True)
    os.makedirs(work_dir, exist_ok=True)

    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": home_dir,
        "OB1_SETTINGS_DIR": settings_dir,
        "OB1_NO_UPDATE_CHECK": "1",
        "OB1_TRUST_GATE": "0",
        "TERM": "xterm-256color",
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
    }

    try:
        run_onboard(ob1_bin, env, work_dir, settings_dir)
        return run_first_token(ob1_bin, env, work_dir)
    finally:
        cleanup(tmp)


if __name__ == "__main__":
    sys.exit(main())
