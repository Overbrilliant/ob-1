// Deterministic test for the OS sandbox argv construction (no real sandbox needed). Covers the
// platform-pure bwrap flag generator, the wrapCommand backend dispatch, and sandboxNote messaging.
// Usage: bun run scripts/sandbox-smoke.ts
import { platform } from "node:os";
import { bwrapArgs, wrapCommand, sandboxNote, sandboxAvailable } from "../src/safety/sandbox.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

/** Does argv contain the contiguous subsequence `seq`? */
const hasSeq = (argv: string[], seq: string[]) => {
  for (let i = 0; i + seq.length <= argv.length; i++) if (seq.every((s, j) => argv[i + j] === s)) return true;
  return false;
};

// --- bwrapArgs (platform-pure; testable on any OS) ---
const ro = bwrapArgs("read-only", "/work/repo");
const ww = bwrapArgs("workspace-write", "/work/repo");
check("bwrap: network unshared in read-only", ro.includes("--unshare-net"));
check("bwrap: network unshared in workspace-write", ww.includes("--unshare-net"));
check("bwrap: root bound read-only", hasSeq(ro, ["--ro-bind", "/", "/"]));
check("bwrap: die-with-parent set", ro.includes("--die-with-parent"));
check("bwrap: --unshare-pid present (required for fresh /proc)", ro.includes("--unshare-pid"));
check("bwrap: read-only does NOT make the workspace writable", !hasSeq(ro, ["--bind", "/work/repo", "/work/repo"]));
check("bwrap: workspace-write binds the workspace writable", hasSeq(ww, ["--bind", "/work/repo", "/work/repo"]));
// extraWrites (e.g. a worktree's external git-dir) bound writable in both modes
check("bwrap: extraWrites bound writable", hasSeq(bwrapArgs("read-only", "/work/repo", ["/ext/git"]), ["--bind", "/ext/git", "/ext/git"]));
// --- hardening (the former seccomp/Landlock TODO): bwrap-native privilege + namespace + session ---
check("bwrap: ALL capabilities dropped", hasSeq(ro, ["--cap-drop", "ALL"]));
check("bwrap: --new-session (blocks the TIOCSTI escape)", ro.includes("--new-session"));
check("bwrap: ipc + uts namespaces unshared", ro.includes("--unshare-ipc") && ro.includes("--unshare-uts"));
check("bwrap: cgroup + user namespaces unshared (best-effort)", ro.includes("--unshare-cgroup-try") && ro.includes("--unshare-user-try"));
check("bwrap: hardening applies in workspace-write too", hasSeq(ww, ["--cap-drop", "ALL"]) && ww.includes("--new-session"));
// Base tier (old-bwrap fallback): the probe drops the ≥0.5.0 hardening flags rather than disabling the
// sandbox, so a bwrap that predates --cap-drop still confines. Base keeps core isolation, omits cap-drop.
const baseRo = bwrapArgs("read-only", "/work/repo", [], { hardened: false });
check("bwrap base tier omits cap-drop + new-session (old-bwrap fallback)", !hasSeq(baseRo, ["--cap-drop", "ALL"]) && !baseRo.includes("--new-session"));
check("bwrap base tier keeps core isolation (net + ro-bind / + fresh /proc)", baseRo.includes("--unshare-net") && hasSeq(baseRo, ["--ro-bind", "/", "/"]) && baseRo.includes("--proc"));
check("bwrap base tier still confines workspace-write to the cwd", hasSeq(bwrapArgs("workspace-write", "/work/repo", [], { hardened: false }), ["--bind", "/work/repo", "/work/repo"]));

// --- wrapCommand dispatch ---
const off = wrapCommand("off", "/work", "echo hi");
check("off → plain bash (unsandboxed)", off.length === 3 && off[0] === "bash" && off[1] === "-lc" && off[2] === "echo hi");

const wrapped = wrapCommand("workspace-write", process.cwd(), "echo hi");
check("wrapCommand: command flows through unchanged", hasSeq(wrapped, ["bash", "-lc", "echo hi"]));
const p = platform();
if (p === "darwin") {
  check("darwin → sandbox-exec backend", wrapped[0] === "sandbox-exec" && wrapped.includes("-p"));
  // extraWrites must reach the generated Seatbelt profile (the -p argument)
  const withExtra = wrapCommand("workspace-write", process.cwd(), "echo hi", ["/ext/git"]);
  check("darwin: extraWrites reach the Seatbelt profile", withExtra.some((a) => a.includes('(allow file-write* (subpath "/ext/git"))')));
} else if (p === "linux" && sandboxAvailable()) {
  check("linux + bwrap → bwrap backend", wrapped[0] === "bwrap" && wrapped.includes("--unshare-net"));
} else {
  check("no usable backend → degrades to plain bash", wrapped[0] === "bash");
}

// --- sandboxNote ---
check("note: off is empty", sandboxNote("off") === "");
const note = sandboxNote("workspace-write");
check("note: non-off is non-empty", note.length > 0);
if (sandboxAvailable()) {
  const backend = p === "linux" ? "bwrap" : "Seatbelt";
  check("note: names the active backend + no network", note.includes(backend) && note.includes("no network"));
  check("note: read-only says no writes", sandboxNote("read-only").includes("no writes"));
} else {
  check("note: degrade is loud (UNSANDBOXED)", note.includes("UNSANDBOXED"));
}

if (fail) { console.error("\n✗ sandbox smoke FAILED"); process.exit(1); }
console.log(`\n✓ sandbox smoke passed (bwrap argv + wrapCommand dispatch + notes · backend: ${sandboxAvailable() ? (p === "linux" ? "bwrap" : "Seatbelt") : "none"})`);
