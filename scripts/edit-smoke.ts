// Deterministic test for the lenient edit-apply engine (no API key).
// Covers exact match, replace_all, ambiguity guard, and whitespace/indentation-flexible fallback.
// Usage: bun run scripts/edit-smoke.ts
import { applyFlexibleEdit } from "../src/agent/tools.ts";
import { diffLines, renderDiff } from "../src/cli/ui.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

// --- exact ---
const r1 = applyFlexibleEdit("let x = 1;\nlet y = 2;\n", "let x = 1;", "let x = 9;");
check("exact: replaces + mode=exact", r1.content.includes("let x = 9;") && r1.mode === "exact" && r1.replacements === 1);

// --- ambiguity guard (exact) ---
check("exact: ambiguous without replace_all throws", throws(() => applyFlexibleEdit("a\na\n", "a", "b")));
const r2 = applyFlexibleEdit("a\na\na\n", "a", "b", true);
check("exact: replace_all counts all", r2.replacements === 3 && r2.content === "b\nb\nb\n");

// --- new_string with regex-special chars stays literal ---
const r3 = applyFlexibleEdit("price = OLD;", "OLD", "$1 & $&");
check("new_string keeps $ literal (no regex expansion)", r3.content === "price = $1 & $&;");

// --- whitespace/indentation-flexible fallback (tabs vs spaces; indent drift) ---
const srcTabs = "if (x) {\n\treturn 1;\n}\n";          // tab-indented body
const oldSpaces = "if (x) {\n    return 1;\n}";        // model wrote 4-space indent → exact fails
const r4 = applyFlexibleEdit(srcTabs, oldSpaces, "if (x) {\n\treturn 2;\n}");
check("flexible: matches across tab/space indent drift, mode=flexible", r4.content.includes("return 2;") && r4.mode === "flexible");

const srcIndent = "  function f() {\n      doThing();\n  }";  // 6-space inner indent
const oldIndent = "function f() {\n  doThing();\n}";          // 2-space inner indent
const r5 = applyFlexibleEdit(srcIndent, oldIndent, "function f() {\n  doOther();\n}");
check("flexible: matches under different indentation", r5.content.includes("doOther();") && r5.mode === "flexible");

// --- genuinely-absent text still throws (actionable) ---
check("missing: throws after exact+flexible both fail", throws(() => applyFlexibleEdit("alpha\nbeta\n", "gamma delta", "x")));

// --- diff viewer ---
const dl = diffLines("a\nb\nc", "a\nB\nc");
check("diff: one line changed (1×- 1×+ 2×keep)", dl.filter((l) => l.t === "-").length === 1 && dl.filter((l) => l.t === "+").length === 1 && dl.filter((l) => l.t === " ").length === 2);
check("diff: identical → all keep", diffLines("x\ny", "x\ny").every((l) => l.t === " "));
check("renderDiff: empty string when identical", renderDiff("x\ny", "x\ny") === "");
check("renderDiff: non-empty + path on change", renderDiff("x", "y", "f.ts").includes("f.ts") && renderDiff("x", "y").length > 0);
const prevNoColor = process.env.NO_COLOR;
process.env.NO_COLOR = "1";
check("renderDiff: NO_COLOR strips ANSI escapes", !/\x1b\[/.test(renderDiff("x", "y", "f.ts")));
if (prevNoColor === undefined) delete process.env.NO_COLOR;
else process.env.NO_COLOR = prevNoColor;

if (fail) { console.error("\n✗ edit smoke FAILED"); process.exit(1); }
console.log("\n✓ edit smoke passed (exact + replace_all + ambiguity guard + whitespace-flexible fallback + diff)");
