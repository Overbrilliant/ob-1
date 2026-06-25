import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function gitDir(cwd: string): string | null {
  const dotGit = join(cwd, ".git");
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (!st.isFile()) return null;
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
    if (!m) return null;
    return isAbsolute(m[1]) ? m[1] : resolve(cwd, m[1]);
  } catch {
    return null;
  }
}

function ignorePattern(cwd: string, dataDir: string): string | null {
  const rel = relative(cwd, dataDir).split(sep).join("/");
  if (!rel || rel === "." || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return null;
  return rel.endsWith("/") ? rel : `${rel}/`;
}

/** Keep OB-1's per-workspace state out of `git status` without editing the user's .gitignore. */
export function ensureOb1GitExclude(cwd: string, dataDir: string): boolean {
  const dir = gitDir(cwd);
  const pattern = ignorePattern(cwd, dataDir);
  if (!dir || !pattern) return false;

  const exclude = join(dir, "info", "exclude");
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const lines = current.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.includes(pattern) || lines.includes(pattern.replace(/\/$/, ""))) return false;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}# OB-1 local state\n${pattern}\n`);
    return true;
  } catch {
    return false;
  }
}
