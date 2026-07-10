// OS sandbox for shell execution (Phase 2). Defense-in-depth alongside the approval gate.
//
// macOS: wrap commands in `sandbox-exec` with a generated Seatbelt profile (the exact
// primitive Claude Code and Codex CLI use — R6/R7). Network is denied; writes are denied
// except, in workspace-write mode, within the workspace and tmp.
//
// Linux: wrap commands in `bwrap` (bubblewrap — the primitive Codex CLI / Claude Code use on
// Linux). bubblewrap is a deny-by-default *bind* model (the inverse of Seatbelt's allow-default):
// the root is bound read-only so the toolchain still resolves, network is unshared (off), and
// only tmp (always) and the workspace (workspace-write only) are made writable.
//
// Syscall/privilege hardening (the former TODO) uses bwrap's NATIVE controls — no native libseccomp
// dependency: --cap-drop ALL drops every Linux capability (so even root-in-namespace gets nothing),
// every namespace is unshared (net/pid/ipc/uts, plus cgroup/user where the kernel allows), and
// --new-session detaches the controlling TTY to block the TIOCSTI terminal-injection escape (bwrap's
// own recommended substitute when you aren't loading a seccomp BPF). A full cBPF seccomp filter or a
// Landlock LSM ruleset would need native bindings unavailable in this TS/Bun runtime, so they are out
// of scope; the controls above are the practical equivalent. On platforms with no usable backend the
// modes degrade to unsandboxed — loudly logged via sandboxNote(), never silently.
import { platform, tmpdir } from "node:os";
import type { SandboxMode } from "../config.ts";

// Memoized Linux bwrap capability probe. PATH presence alone is NOT enough — some kernels disable
// unprivileged user namespaces (sysctl kernel.unprivileged_userns_clone=0) and some environments
// (nested containers, masked /proc, restrictive seccomp/AppArmor) block the fresh procfs/devtmpfs
// mounts bwrap needs, so bwrap would fail at spawn time even when installed. We probe with the EXACT
// flags wrapCommand emits at runtime (derived from bwrapArgs so the two can never drift) — a subset
// probe could pass while the real argv fails, falsely reporting the sandbox active. (R6 warns network
// policy can be silently ignored — so we verify the sandbox actually works rather than trusting PATH.)
// Probe which flag tier the host's bwrap actually accepts. The hardening flags (--cap-drop is bwrap
// ≥0.5.0; Ubuntu 20.04 / Debian 11 ship 0.4.1) would make bwrap die("Unknown option") and the probe
// fail — which must NOT silently drop a previously-working host to unsandboxed. So we probe the
// hardened argv first and, if it's rejected, fall back to the BASE argv (the old, widely-supported
// set) so an older bwrap still sandboxes. "none" only when even the base set won't run.
type BwrapTier = "hardened" | "base" | "none";
let bwrapTier: BwrapTier | undefined;
export function linuxBwrapTier(): BwrapTier {
  if (bwrapTier !== undefined) return bwrapTier;
  const bin = Bun.which("bwrap");
  if (!bin) return (bwrapTier = "none");
  const works = (hardened: boolean): boolean => {
    try {
      return Bun.spawnSync([bin, ...bwrapArgs("workspace-write", tmpdir(), [], { hardened }), "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch { return false; }
  };
  if (works(true)) return (bwrapTier = "hardened");
  if (works(false)) return (bwrapTier = "base");
  return (bwrapTier = "none");
}

export function sandboxAvailable(): boolean {
  const p = platform();
  if (p === "darwin") return true;             // Seatbelt via sandbox-exec
  if (p === "linux") return linuxBwrapTier() !== "none"; // bubblewrap (R6/R7)
  return false;
}

/** Generate a Seatbelt (SBPL) profile. allow-default, then deny broad, then allow specific
 *  (SBPL is last-match-wins). `extraWrites` are additional subpaths to allow writing (e.g. a git
 *  worktree's metadata dir that lives outside the workspace). */
function seatbeltProfile(mode: SandboxMode, cwd: string, extraWrites: string[] = []): string {
  const tmp = tmpdir();
  const lines = ["(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)"];
  // Guard `cwd` the SAME way extraWrites are guarded below: a workspace path containing a `"` or newline
  // would break out of the subpath literal and could inject/neutralize SBPL rules (last-match-wins). If
  // the path is unsafe to embed, skip the allow rule (writes stay denied) rather than emit a broken profile.
  if (mode === "workspace-write" && !/["\n]/.test(cwd)) {
    lines.push(`(allow file-write* (subpath "${cwd}"))`);
  }
  // Skip any path with a quote/newline — it would break (or inject into) the SBPL string. The only
  // caller derives extraWrites from git plumbing output, but the param widens the surface, so guard.
  for (const w of extraWrites) if (!/["\n]/.test(w)) lines.push(`(allow file-write* (subpath "${w}"))`);
  // tmp + /dev/null are needed for ordinary tool plumbing in both restricted modes
  lines.push(`(allow file-write* (subpath "${tmp}"))`);
  lines.push('(allow file-write-data (literal "/dev/null"))');
  return lines.join("\n");
}

/** Translate a sandbox mode into bubblewrap flags. Deny-by-default bind model (the inverse of
 *  Seatbelt's allow-default): bind the whole filesystem READ-ONLY so tools resolve, give fresh
 *  /dev + /proc, unshare the network in BOTH restricted modes (matching Seatbelt's `deny network*`),
 *  and make writable only tmp (always — parity with Seatbelt) and, in workspace-write, the cwd.
 *  `opts.hardened` (default true) adds the bwrap-native syscall/privilege hardening (no libseccomp):
 *  drop ALL capabilities, a new session (blocks the TIOCSTI escape), and the extra namespace unshares.
 *  Those need a newer bwrap (--cap-drop is ≥0.5.0), so the probe falls back to `hardened:false` (the
 *  widely-supported base set) on an older bwrap rather than disabling the sandbox. Last bind wins, so
 *  the workspace/tmp `--bind` overrides the earlier `--ro-bind /`. `extraWrites` are additional paths
 *  bound writable. Pure + exported for testing — does NOT itself check the host OS or bwrap presence. */
export function bwrapArgs(mode: SandboxMode, cwd: string, extraWrites: string[] = [], opts: { hardened?: boolean } = {}): string[] {
  const tmp = tmpdir();
  const hardened = opts.hardened !== false; // default on
  const a = ["--die-with-parent"]; // never outlive ob1
  if (hardened) a.push(
    "--new-session",          // detach the controlling TTY → blocks the TIOCSTI stdin-injection escape
    "--cap-drop", "ALL",      // drop EVERY Linux capability (privilege-surface reduction; bwrap ≥0.5.0)
  );
  a.push(
    "--unshare-net",          // network off (both modes; matches Seatbelt deny network*)
    "--unshare-pid",          // own PID namespace — REQUIRED to mount a fresh /proc unprivileged
  );
  if (hardened) a.push(
    "--unshare-ipc",          // own IPC namespace — no shared SysV/POSIX IPC with the host
    "--unshare-uts",          // own UTS namespace — hostname isolation
    "--unshare-cgroup-try",   // own cgroup namespace when the kernel supports it (don't fail otherwise)
    "--unshare-user-try",     // own user namespace when possible (extra privilege isolation)
  );
  a.push(
    "--ro-bind", "/", "/",    // whole filesystem read-only (mirrors Seatbelt allow-default reads)
    "--dev", "/dev",          // fresh minimal /dev (provides a writable /dev/null)
    "--proc", "/proc",        // fresh /proc (needs --unshare-pid above)
    "--bind", tmp, tmp,       // tmp writable in both modes (parity with Seatbelt)
  );
  if (mode === "workspace-write") a.push("--bind", cwd, cwd); // workspace writable
  for (const w of extraWrites) a.push("--bind", w, w);        // extra writable paths
  return a;
}

/** Build the argv to execute a command under the given sandbox mode. `extraWrites` are paths to
 *  allow writing beyond the workspace + tmp (e.g. a git worktree's external metadata dir). */
export function wrapCommand(mode: SandboxMode, cwd: string, command: string, extraWrites: string[] = []): string[] {
  if (mode === "off" || !sandboxAvailable()) return ["bash", "-lc", command];
  if (platform() === "linux") return ["bwrap", ...bwrapArgs(mode, cwd, extraWrites, { hardened: linuxBwrapTier() === "hardened" }), "bash", "-lc", command];
  return ["sandbox-exec", "-p", seatbeltProfile(mode, cwd, extraWrites), "bash", "-lc", command];
}

export function sandboxNote(mode: SandboxMode): string {
  if (mode === "off") return "";
  if (!sandboxAvailable()) {
    return platform() === "linux"
      ? " (bubblewrap unavailable — install `bwrap` + enable unprivileged user namespaces; running UNSANDBOXED)"
      : " (unsupported on this OS; running UNSANDBOXED)";
  }
  const backend = platform() === "linux"
    ? (linuxBwrapTier() === "base" ? "bwrap (legacy — no cap-drop)" : "bwrap")
    : "Seatbelt";
  return mode === "read-only"
    ? ` (${backend}: no writes, no network)`
    : ` (${backend}: writes confined to workspace + tmp, no network)`;
}
