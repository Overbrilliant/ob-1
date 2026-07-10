// Smoke test for the skills registry (no API key needed). Usage: bun run scripts/skills-smoke.ts
import { listSkills, readSkill } from "../src/skills/registry.ts";

const skills = listSkills(process.cwd());
console.log("discovered skills:");
for (const s of skills) console.log(`  - ${s.name}: ${s.description}`);

const body = readSkill(process.cwd(), "code-review");
console.log(`\ncode-review body loaded: ${body ? body.length + " chars" : "NULL"}`);
console.log(`first line: ${body?.split("\n")[0]}`);

const missing = readSkill(process.cwd(), "does-not-exist");

const ok =
  skills.some((s) => s.name === "code-review" && s.description.length > 0) &&
  !!body && body.includes("Code Review") &&
  missing === null;

if (!ok) { console.error("\n✗ skills smoke FAILED"); process.exit(1); }
console.log("\n✓ skills registry smoke test passed (metadata listed, body lazy-loaded, missing → null)");
