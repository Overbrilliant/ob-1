// Deterministic test for on-demand topic files (no API key). Usage: bun run scripts/topics-smoke.ts
import { listTopics, readTopic } from "../src/context/topics.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

const dir = mkdtempSync(join(tmpdir(), "ob1-topics-"));
try {
  mkdirSync(join(dir, ".ob1", "topics"), { recursive: true });
  writeFileSync(join(dir, ".ob1", "topics", "debugging.md"), "# Debug\nuse the debugger");
  writeFileSync(join(dir, "conventions.md"), "# Conventions\n2-space indent");
  writeFileSync(join(dir, "AGENTS.md"), "# index — should NOT be a topic");

  const list = listTopics(dir);
  check("lists .ob1/topics/*.md", list.some((t) => t.name === "debugging"));
  check("lists recognized root spill files", list.some((t) => t.name === "conventions"));
  check("excludes AGENTS.md (it's the index, not a topic)", !list.some((t) => t.name === "AGENTS"));
  check("readTopic by name", (readTopic(dir, "debugging") ?? "").includes("debugger"));
  check("readTopic tolerates .md suffix", (readTopic(dir, "conventions.md") ?? "").includes("indent"));
  check("unknown topic → null", readTopic(dir, "nope") === null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fail) { console.error("\n✗ topics smoke FAILED"); process.exit(1); }
console.log("\n✓ topics smoke passed (listing + read + index exclusion)");
