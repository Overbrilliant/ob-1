import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
if (!pkg.version) throw new Error("package.json is missing version");

const path = "src/version.ts";
const contents = `// Generated from package.json by scripts/generate-version.ts.\nexport const CLI_VERSION = ${JSON.stringify(pkg.version)};\n`;
const current = (() => { try { return readFileSync(path, "utf8"); } catch { return ""; } })();

if (process.argv.includes("--check")) {
  if (current !== contents) {
    console.error(`${path} is stale; run: bun run scripts/generate-version.ts`);
    process.exit(1);
  }
  process.exit(0);
}

if (current !== contents) writeFileSync(path, contents);
console.log(`✓ ${path} = ${pkg.version}`);
