#!/usr/bin/env python3
"""Fresh-install FreeLLMAPI journey smoke.

Drives an installed `ob1` binary through the real first-run onboarding path:
Start free -> auto-provision FreeLLMAPI -> read the saved local /v1 endpoint -> make a tiny chat
completion through the anonymous model route. Intended for the Linux fresh-install workflow where
Docker is available.
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
import urllib.error
import urllib.request


ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b[=>cM]|\r")


def strip_ansi(buf: bytearray) -> str:
    return ANSI.sub(b"", bytes(buf)).decode("utf-8", "replace")


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
        print(detail)
    return 0


def looks_like_anonymous_pool_exhaustion(error: str) -> bool:
    return bool(
        re.search(
            r"\b(429|502|503|504)\b|rate.?limit|too many requests|quota|capacity|exhaust|temporar(il)?y|"
            r"unavailable|busy|no available|provider.*down|upstream",
            error,
            re.IGNORECASE,
        )
    )


def request_json(method: str, url: str, *, token: str = "", body: dict | None = None, timeout: int = 60) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"accept": "application/json"}
    if body is not None:
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {url} -> HTTP {exc.code}: {raw[:1200]}") from exc
    except Exception as exc:
        raise RuntimeError(f"{method} {url} failed: {exc}") from exc


def cleanup(settings_dir: str, tmp: str) -> None:
    try:
        with open(os.path.join(settings_dir, "freellm.json"), "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        state = {}

    runtime = state.get("runtime")
    run_dir = state.get("dir")
    if runtime == "docker" and run_dir and os.path.isdir(run_dir):
        try:
            subprocess.run(["docker", "compose", "down", "-v"], cwd=run_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        except Exception:
            pass
    elif runtime == "node" and run_dir:
        try:
            with open(os.path.join(run_dir, ".ob1-pid"), "r", encoding="utf-8") as f:
                pid = int(f.read().strip())
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass

    if os.environ.get("OB1_KEEP_FREELLM_E2E_TMP") != "1":
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print(f"- kept temp dir: {tmp}")


def main() -> int:
    ob1_bin = os.environ.get("OB1_BIN") or shutil.which("ob1")
    if not ob1_bin:
        fail("set OB1_BIN or put ob1 on PATH")
    if not shutil.which("docker"):
        fail("docker is required for the fresh-install FreeLLMAPI e2e")
    try:
        subprocess.run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=30)
    except Exception as exc:
        fail(f"docker is installed but not available: {exc}")

    tmp = tempfile.mkdtemp(prefix="ob1-free-first-token-")
    settings_dir = os.path.join(tmp, "settings")
    home_dir = os.path.join(tmp, "home")
    work_dir = os.path.join(tmp, "work")
    os.makedirs(settings_dir, exist_ok=True)
    os.makedirs(home_dir, exist_ok=True)
    os.makedirs(work_dir, exist_ok=True)

    buf = bytearray()
    pid = None
    fd = None
    child_exit_code = None

    try:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": home_dir,
            "OB1_SETTINGS_DIR": settings_dir,
            "TERM": "xterm-256color",
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        }

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
        os.write(fd, b"\r")

        if not wait_for("Press Enter when you've added a provider key", 900):
            fail("FreeLLMAPI setup did not reach the dashboard skip prompt", strip_ansi(buf))
        os.write(fd, b"\r")

        deadline = time.time() + 60
        exit_code = None
        while time.time() < deadline:
            pump(0.2)
            if poll_child():
                exit_code = child_exit_code
                break
        if exit_code is None:
            os.kill(pid, signal.SIGKILL)
            fail("onboarding did not exit after the final Enter", strip_ansi(buf))
        if exit_code != 0:
            fail(f"onboarding exited {exit_code}", strip_ansi(buf))

        output = strip_ansi(buf)
        if "Connected OB-1 to your local proxy" not in output:
            fail("onboarding did not report a connected FreeLLMAPI proxy", output)

        settings_path = os.path.join(settings_dir, "settings.json")
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
        if settings.get("providerProfile") != "freellmapi":
            fail(f"expected freellmapi provider profile in settings, got {settings.get('providerProfile')!r}", output)

        base_url = settings.get("providerUrl", "").rstrip("/")
        key = settings.get("providerKey", "")
        if not base_url or not key:
            fail("FreeLLMAPI URL/key were not saved in settings", output)

        print(f"-> probing {base_url}/models")
        models_body = request_json("GET", f"{base_url}/models", token=key, timeout=60)
        models = models_body.get("data") if isinstance(models_body.get("data"), list) else []
        model_ids = [m.get("id") for m in models if isinstance(m, dict) and m.get("id")]
        if not model_ids:
            fail(f"FreeLLMAPI returned no models: {models_body}")
        print("- models: " + ", ".join(model_ids[:8]) + (" ..." if len(model_ids) > 8 else ""))

        candidates = []
        if "auto" in model_ids:
            candidates.append("auto")
        candidates.extend([m for m in model_ids[:6] if m not in candidates])

        errors = []
        for model in candidates:
            print(f"-> first-token chat via {model}")
            try:
                chat = request_json(
                    "POST",
                    f"{base_url}/chat/completions",
                    token=key,
                    timeout=90,
                    body={
                        "model": model,
                        "messages": [{"role": "user", "content": "Reply with exactly: OB-1 online."}],
                        "max_tokens": 32,
                        "stream": False,
                    },
                )
                choices = chat.get("choices") if isinstance(chat, dict) else None
                content = ""
                if choices and isinstance(choices, list):
                    msg = choices[0].get("message") if isinstance(choices[0], dict) else {}
                    content = msg.get("content", "") if isinstance(msg, dict) else ""
                if content.strip():
                    print(f"ok first-token chat succeeded with {model}: {content.strip()[:160]}")
                    return 0
                errors.append(f"{model}: empty assistant content")
            except Exception as exc:
                errors.append(f"{model}: {exc}")

        if errors and all(looks_like_anonymous_pool_exhaustion(e) for e in errors):
            return soft_warn(
                "FreeLLMAPI installed and exposed models, but anonymous public pools were unavailable.",
                "Add a provider key for release recording or retry later.\n" + "\n".join(errors),
            )

        fail("no anonymous FreeLLMAPI model completed a chat:\n" + "\n".join(errors), output)
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        cleanup(settings_dir, tmp)


if __name__ == "__main__":
    sys.exit(main())
