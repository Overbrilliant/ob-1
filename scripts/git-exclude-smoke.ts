import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOb1GitExclude } from "../src/context/git-exclude.ts";

function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const gitOk = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
if (!gitOk) {
  console.log("• skipped — git not available");
  process.exit(0);
}

const cwd = mkdtempSync(join(tmpdir(), "ob1-git-exclude-"));
Bun.spawnSync(["git", "init"], { cwd, stdout: "pipe", stderr: "pipe" });
writeFileSync(join(cwd, "README.md"), "# smoke\n");
Bun.spawnSync(["git", "add", "README.md"], { cwd, stdout: "pipe", stderr: "pipe" });

const dataDir = join(cwd, ".ob1");
check("adds .ob1/ to repo-local git exclude", ensureOb1GitExclude(cwd, dataDir));
const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
check("exclude contains .ob1/", exclude.includes(".ob1/"));
check("second call is idempotent", !ensureOb1GitExclude(cwd, dataDir));

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "memory.db"), "local");
const status = new TextDecoder().decode(Bun.spawnSync(["git", "status", "--short"], { cwd, stdout: "pipe", stderr: "pipe" }).stdout);
check(".ob1/ stays out of git status", !status.includes(".ob1"), status.trim() || "(clean)");

if (process.exitCode) process.exit(process.exitCode);
console.log("\n✓ git exclude smoke passed");
