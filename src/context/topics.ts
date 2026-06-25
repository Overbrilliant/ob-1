// On-demand topic files (Phase-1 spill tier). Detailed notes that don't belong in the always-loaded
// AGENTS.md index live in topic files (debugging.md, conventions.md, architecture.md, …) and are
// pulled in JUST-IN-TIME via the read_topic tool — keeping the base context lean (R3/R6).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TopicFile { name: string; path: string }

// Recognized root-level spill files (the plan names debugging.md / conventions.md explicitly).
const ROOT_TOPICS = ["debugging.md", "conventions.md", "architecture.md", "testing.md"];

/** List available on-demand topic files: every *.md under .ob1/topics|topics, plus recognized
 *  root-level spill files. AGENTS.md and README are deliberately excluded (index, not a topic). */
export function listTopics(cwd: string): TopicFile[] {
  const found = new Map<string, string>();
  for (const d of [".ob1/topics", "topics"]) {
    const dir = join(cwd, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) found.set(f.replace(/\.md$/, ""), join(dir, f));
  }
  for (const f of ROOT_TOPICS) {
    const key = f.replace(/\.md$/, "");
    const p = join(cwd, f);
    if (existsSync(p) && !found.has(key)) found.set(key, p);
  }
  return [...found].map(([name, path]) => ({ name, path }));
}

/** Read a topic file by name (with or without the .md suffix). Bounded. null if unknown. */
export function readTopic(cwd: string, name: string): string | null {
  const key = name.replace(/\.md$/, "");
  const t = listTopics(cwd).find((x) => x.name === key);
  if (!t) return null;
  try { return readFileSync(t.path, "utf8").slice(0, 25_000); } catch { return null; }
}
