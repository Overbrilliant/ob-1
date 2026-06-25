// Smoke test for package-manager friendly CLI flags. These must exit before onboarding/auth/REPL startup.
// Usage: bun run scripts/cli-flags-smoke.ts
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; name: string };
let fail = false;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function run(arg: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", "run", "src/index.ts", arg], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1" },
  });
  return { code: p.exitCode ?? 1, stdout: text(p.stdout), stderr: text(p.stderr) };
}

const version = run("--version");
check("--version exits 0", version.code === 0, version.stderr.trim());
check("--version prints package version", version.stdout.trim() === pkg.version, version.stdout.trim());

const help = run("--help");
check("--help exits 0", help.code === 0, help.stderr.trim());
check("--help prints usage", help.stdout.includes("Usage:") && help.stdout.includes("ob1 login") && help.stdout.includes("Inside OB-1"));
check("package name is scoped to Overbrilliant", pkg.name === "@overbrilliant/ob1", pkg.name);

if (fail) { console.error("\n✗ cli flags smoke FAILED"); process.exit(1); }
console.log("\n✓ cli flags smoke passed");
