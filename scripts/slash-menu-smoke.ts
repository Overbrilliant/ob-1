// Regression guard: every user command advertised in /help must also be reachable from the TUI slash
// menu (SLASH_COMMANDS in src/cli/tui.tsx). These two lists are maintained by hand in different files,
// so it's easy to wire a command into the dispatch + /help but forget the menu — which is exactly how
// /rewind once went missing. Pure text comparison (no imports → no module side effects).
// Usage: bun run scripts/slash-menu-smoke.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf8");
const tuiSrc = readFileSync(join(root, "src", "cli", "tui.tsx"), "utf8");

// Canonical command set = the commands shown in the /help text (the const HELP = `…` block).
const helpStart = indexSrc.indexOf("const HELP = `");
const helpEnd = indexSrc.indexOf("`;", helpStart);
check("found the HELP block in index.ts", helpStart !== -1 && helpEnd > helpStart);
const help = indexSrc.slice(helpStart, helpEnd);
const helpCmds = new Set([...help.matchAll(/c\.cyan\("(\/[a-z]+)/g)].map((m) => m[1]));

// Menu set = the first column of SLASH_COMMANDS in tui.tsx.
const menuStart = tuiSrc.indexOf("SLASH_COMMANDS");
const menuEnd = tuiSrc.indexOf("];", menuStart);
const menu = new Set([...tuiSrc.slice(menuStart, menuEnd).matchAll(/\["(\/[a-z]+)"/g)].map((m) => m[1]));
check("parsed several commands from SLASH_COMMANDS", menu.size >= 10);

// Aliases intentionally NOT given their own menu row (a synonym already appears).
const ALIAS = new Set(["/model" /* → /models */, "/quit" /* → /exit */]);

const missing = [...helpCmds].filter((cmd) => !menu.has(cmd) && !ALIAS.has(cmd));
check(`every /help command is in the slash menu${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`, missing.length === 0);

// Explicit pin for the one that regressed (so this exact bug can't come back).
check("/rewind is in the slash menu", menu.has("/rewind"));

// Sanity: the menu shouldn't advertise commands /help never mentions (catches typos / dead entries).
const stray = [...menu].filter((cmd) => !helpCmds.has(cmd) && !ALIAS.has(cmd));
check(`no stray menu entries absent from /help${stray.length ? ` (stray: ${stray.join(", ")})` : ""}`, stray.length === 0);

console.log("");
if (fail) { console.error("✗ slash-menu smoke FAILED"); process.exit(1); }
console.log("✓ slash-menu smoke passed");
