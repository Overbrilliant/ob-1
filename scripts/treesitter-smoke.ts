// Smoke: tree-sitter symbol extraction (the repo-map upgrade). Verifies grammars load, that real
// parsing finds symbols the regex extractor CANNOT (class methods, nested defs), per-language
// coverage, graceful fallback (unsupported ext → null), and that buildRepoMap picks tree-sitter up.
// Runs under Bun (and Node). Usage: bun run scripts/treesitter-smoke.ts
import { initTreeSitter, treeSitterStatus, extractSymbolsTS } from "../src/context/treesitter.ts";
import { extractSymbols, buildRepoMap } from "../src/context/repomap.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

const ready = await initTreeSitter();
const st = treeSitterStatus();
check("tree-sitter initialized", ready && st.ready, st.grammars.join(","));
check("core grammars loaded (ts/js/python)", ["typescript", "javascript", "python"].every((g) => st.grammars.includes(g)), st.grammars.join(","));

const ts = `
export function alpha(x: number) { return x; }
export const beta = (y: number) => y * 2;
export class Gamma { delta() {} static eps() {} }
export interface Iota { m(): void }
export type Tau = string;
`;
const tsSyms = extractSymbolsTS("x.ts", ts) ?? [];
const tsNames = new Set(tsSyms.map((s) => s.name));
check("ts: top-level function/class/const/interface/type found",
  ["alpha", "beta", "Gamma", "Iota", "Tau"].every((n) => tsNames.has(n)), [...tsNames].join(","));
// The KEY upgrade: methods inside a class — the old regex extractor never captured these.
check("ts: class METHODS found (regex could not)", tsNames.has("delta") && tsNames.has("eps"));
const regexNames = new Set(extractSymbols("ts", ts).map((s) => s.name));
check("regex baseline genuinely MISSES the methods (proves upgrade)", !regexNames.has("delta") && !regexNames.has("eps"));

const py = `
class Animal:
    def speak(self):
        return "hi"
def helper():
    return 1
`;
const pyNames = new Set((extractSymbolsTS("x.py", py) ?? []).map((s) => s.name));
check("python: class + nested def + top-level def", ["Animal", "speak", "helper"].every((n) => pyNames.has(n)), [...pyNames].join(","));

// Graceful fallback: unsupported extension → null (caller uses regex / nothing).
check("unsupported ext → null (fallback signal)", extractSymbolsTS("notes.txt", "hello world") === null);
// Empty/symbol-less source → null so the regex path can run instead (never regress below it).
check("symbol-less source → null", extractSymbolsTS("x.ts", "const x = 1;\nlet y = 2;\n") === null);

// End-to-end: buildRepoMap on a temp project surfaces a class method (only tree-sitter finds it).
const dir = mkdtempSync(join(tmpdir(), "ob1-ts-"));
try {
  writeFileSync(join(dir, "svc.ts"), "export class Service {\n  handleRequest() { return helper(); }\n}\n");
  writeFileSync(join(dir, "util.ts"), "export function helper() { return 42; }\nexport class Service {}\n");
  const map = buildRepoMap(dir);
  const allSyms = map.files.flatMap((f) => f.symbols.map((s) => s.name));
  check("buildRepoMap surfaces the class method via tree-sitter", allSyms.includes("handleRequest"), allSyms.join(","));
} finally { rmSync(dir, { recursive: true, force: true }); }

// ── Precision (adversarial review): tree-sitter must not over-count vs the regex baseline ──
const cSyms = extractSymbolsTS("g.c", "struct Point { int x; };\nvoid move(struct Point *p){}\nstruct Point makeOrigin(void){ struct Point z; return z; }") ?? [];
check("c: struct definition counted once — type references ignored", cSyms.filter((s) => s.name === "Point").length === 1, `Point×${cSyms.filter((s) => s.name === "Point").length}`);
check("c: functions still found", cSyms.some((s) => s.name === "move") && cSyms.some((s) => s.name === "makeOrigin"));

const objNames = new Set((extractSymbolsTS("o.ts", "const api = { get(){}, set(v){} };\nclass S { constructor(){} handle(){} }\n") ?? []).map((s) => s.name));
check("ts: object-literal shorthand methods NOT counted", !objNames.has("get") && !objNames.has("set"));
check("ts: constructor NOT counted", !objNames.has("constructor"));
check("ts: real class method + class ARE counted", objNames.has("handle") && objNames.has("S"));

const dynNames = (extractSymbolsTS("d.ts", "class D { ['dyn'](){} [Symbol.iterator](){} real(){} }\n") ?? []).map((s) => s.name);
check("ts: computed/string-literal member names rejected (no bracket/quote junk)", !dynNames.some((n) => /[[\]'"]/.test(n)) && dynNames.includes("real"), dynNames.join(","));

check("broken grammars dropped from the advertised set (ruby throws on parse in this build)", !st.grammars.includes("ruby"), st.grammars.join(","));

if (fail) { console.error("\n✗ tree-sitter smoke FAILED"); process.exit(1); }
console.log("\n✓ tree-sitter smoke passed (grammars load · methods/nested defs found · regex fallback · buildRepoMap integration)");
process.exit(0);
