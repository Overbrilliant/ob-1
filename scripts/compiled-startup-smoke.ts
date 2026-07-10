// Smoke: the standalone binary must start without runtime node_modules assets.
// Homebrew installs the release binary only, so optional native/WASM accelerators must fall back.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let fail = false;
const dec = new TextDecoder();
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail = true;
};

const scriptDir = dirname(Bun.fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const tmp = mkdtempSync(join(tmpdir(), "ob1-compiled-"));
const runCwd = mkdtempSync(join(tmpdir(), "ob1-compiled-run-"));
const env = { ...process.env };
for (const key of [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OB1_API_KEY",
  "OB1_BASE_URL",
  "OB1_MODEL",
  "OB1_PROVIDER",
  "OB1_SETTINGS_DIR",
  "OB1_TOKEN",
  "OB1_TREESITTER",
  "OB1_VEC",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]) delete env[key];
env.HOME = join(runCwd, "home");
env.OB1_SETTINGS_DIR = join(runCwd, "settings");
env.NO_COLOR = "1";
mkdirSync(env.HOME, { recursive: true });

try {
  const bin = join(tmp, process.platform === "win32" ? "ob1.exe" : "ob1");
  const build = Bun.spawnSync(["bun", "run", join(scriptDir, "build-bin.ts"), bin], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const buildOut = dec.decode(build.stdout) + dec.decode(build.stderr);
  check("compiled binary builds", (build.exitCode ?? 1) === 0, buildOut.trim());

  if ((build.exitCode ?? 1) === 0) {
    const run = Bun.spawnSync(["sh", "-c", "printf '/exit\\n' | \"$1\"", "sh", bin], {
      cwd: runCwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const out = dec.decode(run.stdout) + dec.decode(run.stderr);
    check("compiled binary starts and exits", (run.exitCode ?? 1) === 0, out.trim().slice(-300));
    check("NO_COLOR strips ANSI escapes from startup output", !/\x1b\[/.test(out));
    check("standalone skips web-tree-sitter wasm loader", !out.includes("tree-sitter.wasm"));
    check("standalone uses regex repo-map fallback", !out.includes("repo map: tree-sitter"));
    check("standalone uses cosine memory fallback", !out.includes("memory: sqlite-vec KNN index"));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(runCwd, { recursive: true, force: true });
}

if (fail) {
  console.error("\n✗ compiled startup smoke FAILED");
  process.exit(1);
}
console.log("\n✓ compiled startup smoke passed (standalone startup · native/WASM fallback)");
process.exit(0);
