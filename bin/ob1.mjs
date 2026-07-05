#!/usr/bin/env node
// npm entry shim. The OB-1 CLI runs on the Bun runtime (src/index.ts, whose own shebang is
// `#!/usr/bin/env bun`). An npm install guarantees Node but NOT Bun, so shipping the bun-shebanged
// source directly as the bin gives users without Bun a cryptic `env: bun: No such file or directory`.
// This Node shim (Node is always present under npm) detects Bun and re-execs the real CLI under it, or
// prints an actionable install message when Bun is missing. Chosen over a preinstall/postinstall hook
// because it is the least fragile: it never runs (or fails) in CI at install time, and it still works if
// the user installs Bun AFTER installing this package. Homebrew/curl installs ship a COMPILED standalone
// binary and never touch this file — the bun-shebang problem is npm-only.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const args = process.argv.slice(2);

// Probe for Bun on PATH. spawnSync sets `.error` (ENOENT) when the executable can't be found.
const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
if (probe.error) {
  process.stderr.write(
    "\nOB-1 needs the Bun runtime, which was not found on your PATH.\n\n" +
      "Install Bun, then re-run `ob1`:\n" +
      "  curl -fsSL https://bun.sh/install | bash\n\n" +
      "…or install OB-1 as a standalone binary (no Bun required):\n" +
      "  curl -fsSL https://github.com/Overbrilliant/ob-1/releases/latest/download/install.sh | sh\n\n",
  );
  process.exit(1);
}

// Re-exec under Bun, inheriting the parent's stdio (so the Ink TUI gets a real TTY). Exit with the
// child's status; a signal-terminated child yields a null status → non-zero exit.
const res = spawnSync("bun", [entry, ...args], { stdio: "inherit" });
process.exit(res.status ?? 1);
