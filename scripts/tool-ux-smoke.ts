// Deterministic guard for small tool UX affordances found during live agent runs.
// Usage: bun run scripts/tool-ux-smoke.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTools } from "../src/agent/tools.ts";

let fail = false;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail = true;
};

const dir = mkdtempSync(join(tmpdir(), "ob1-tool-ux-"));
try {
  writeFileSync(join(dir, "app.js"), "const x = 1;\n");
  const tools = buildTools({ cwd: dir } as any, {} as any);

  const missing = await tools.get("list_dir")!.run({ path: "docs" });
  check("list_dir missing path returns a friendly message", String(missing).includes("directory not found: docs"), String(missing));

  let editError = "";
  try {
    await tools.get("edit_file")!.run({ path: "app.js", old_string: "const y = 2;", new_string: "const y = 3;" });
  } catch (e) {
    editError = (e as Error).message;
  }
  check("edit_file mismatch tells the model to re-read a narrow range", editError.includes("Re-read the narrow line range"), editError);
  check("edit_file mismatch discourages whole-file rewrites", editError.includes("Do NOT rewrite the whole file"), editError);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fail) { console.error("\n✗ tool-ux smoke FAILED"); process.exit(1); }
console.log("\n✓ tool-ux smoke passed");
