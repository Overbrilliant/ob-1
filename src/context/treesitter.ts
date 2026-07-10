// Tree-sitter symbol extraction for the repo map (the R4/R7 Aider design, done properly).
//
// The original build shipped a regex extractor because tree-sitter "didn't load under Bun". That
// was a version-matching problem, not a hard limit: `web-tree-sitter@0.20.x` (the WASM runtime)
// + `tree-sitter-wasms` (grammars built with tree-sitter-cli 0.20) load fine under BOTH Bun and
// Node here. This module replaces the regex DEFINITION extractor with a real parse when available;
// repomap.ts keeps the regex path as an automatic fallback, so a host without the grammars (or an
// unsupported language) degrades gracefully instead of breaking.
//
// init is async (WASM load); parsing is sync afterwards. `initTreeSitter()` is awaited once at boot
// so buildRepoMap() stays synchronous and uses whatever grammars loaded.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { isBunStandaloneExecutable } from "../runtime.ts";
import type { Sym } from "./repomap.ts";

// extension → grammar name (the `tree-sitter-<name>.wasm` files in tree-sitter-wasms/out).
const EXT_GRAMMAR: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".cs": "c_sharp",
};

// Per-grammar definition node types → the `kind` we record. Names are tree-sitter node types.
const TS_DEFS: Record<string, string> = {
  function_declaration: "function", generator_function_declaration: "function",
  class_declaration: "class", abstract_class_declaration: "class", method_definition: "method",
  interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "enum",
  variable_declarator: "const", // only counted when its value is a function/arrow (see nodeName)
};
const JS_DEFS: Record<string, string> = {
  function_declaration: "function", generator_function_declaration: "function",
  class_declaration: "class", method_definition: "method", variable_declarator: "const",
};
const PY_DEFS: Record<string, string> = { function_definition: "def", class_definition: "class" };
const GO_DEFS: Record<string, string> = { function_declaration: "func", method_declaration: "func", type_spec: "type" };
const RUST_DEFS: Record<string, string> = { function_item: "fn", struct_item: "struct", enum_item: "enum", trait_item: "trait", mod_item: "mod" };
const JAVA_DEFS: Record<string, string> = { class_declaration: "class", interface_declaration: "interface", method_declaration: "method", enum_declaration: "enum" };
const RUBY_DEFS: Record<string, string> = { method: "def", singleton_method: "def", class: "class", module: "module" };
const C_DEFS: Record<string, string> = { function_definition: "function", struct_specifier: "struct", enum_specifier: "enum" };
const CPP_DEFS: Record<string, string> = { ...C_DEFS, class_specifier: "class" };

const GRAMMAR_DEFS: Record<string, Record<string, string>> = {
  typescript: TS_DEFS, tsx: TS_DEFS, javascript: JS_DEFS, python: PY_DEFS, go: GO_DEFS,
  rust: RUST_DEFS, java: JAVA_DEFS, ruby: RUBY_DEFS, c: C_DEFS, cpp: CPP_DEFS, c_sharp: JAVA_DEFS,
};

// tree-sitter reuses some "def" node types for type REFERENCES — a C/C++ `struct_specifier` also
// matches `struct Point *p`. Require a body (the field/enumerator list) before counting it a def.
const REQUIRE_BODY = new Set(["struct_specifier", "enum_specifier", "class_specifier"]);
// Plain identifiers only — drops computed (`['x']`, `[Symbol.iterator]`) + string-literal member names.
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Whether a node matched in GRAMMAR_DEFS is a real DEFINITION (vs a reference / object-literal member). */
function acceptDef(node: TsNode, parentType: string): boolean {
  // method_definition is ALSO object-literal shorthand; count it only as a member of a class body
  // (so config/route/tool objects don't spray phantom "method" symbols across the repo map).
  if (node.type === "method_definition" && parentType !== "class_body") return false;
  // A *_specifier with no body is a type reference (a param/return/local), not a definition.
  if (REQUIRE_BODY.has(node.type) && !node.childForFieldName("body")) return false;
  return true;
}

// Minimal structural typing of the bits of the web-tree-sitter API we touch (it's untyped here).
interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  namedChildCount: number;
  namedChild(i: number): TsNode | null;
  childForFieldName(field: string): TsNode | null;
}
interface TsParser { setLanguage(lang: unknown): void; parse(src: string): { rootNode: TsNode }; }

let initDone = false;
let ready = false;
const parsers = new Map<string, TsParser>(); // grammar name → a parser with that language set

/** Whether tree-sitter is active and which grammars loaded (for the startup note + tests). */
export function treeSitterStatus(): { ready: boolean; grammars: string[] } {
  return { ready, grammars: [...parsers.keys()].sort() };
}

/** Load web-tree-sitter + the grammar WASMs once. Best-effort: any failure leaves the regex
 *  extractor in charge. Idempotent. Disabled with OB1_TREESITTER=0. Returns whether it's active. */
export async function initTreeSitter(): Promise<boolean> {
  if (initDone) return ready;
  initDone = true;
  if (process.env.OB1_TREESITTER === "0" || isBunStandaloneExecutable()) return false;
  try {
    const mod: any = await import("web-tree-sitter");
    const Parser: any = mod.default ?? mod;
    await Parser.init();
    const req = createRequire(import.meta.url);
    const wasmDir = join(dirname(req.resolve("tree-sitter-wasms/package.json")), "out");
    const distinct = [...new Set(Object.values(EXT_GRAMMAR))];
    for (const grammar of distinct) {
      const file = join(wasmDir, `tree-sitter-${grammar}.wasm`);
      if (!existsSync(file)) continue;
      try {
        const Lang = await Parser.Language.load(new Uint8Array(readFileSync(file)));
        const p: TsParser = new Parser();
        p.setLanguage(Lang);
        p.parse("x"); // validate: a few grammars in this wasm build load but THROW on parse (e.g. ruby) — drop those
        parsers.set(grammar, p);
      } catch { /* skip a grammar that fails to load — its files fall back to regex */ }
    }
    ready = parsers.size > 0;
  } catch { ready = false; }
  return ready;
}

function nodeName(node: TsNode): string | undefined {
  if (node.type === "variable_declarator") {
    const val = node.childForFieldName("value");
    if (!val || !/^(arrow_function|function|function_expression)$/.test(val.type)) return undefined;
    return node.childForFieldName("name")?.text || undefined;
  }
  const nf = node.childForFieldName("name");
  if (nf?.text) return nf.text;
  // C/C++ wrap the name inside nested declarators — descend to the first identifier.
  let d: TsNode | null = node.childForFieldName("declarator");
  for (let guard = 0; d && guard < 8; guard++) {
    if (d.type === "identifier" || d.type === "field_identifier" || d.type === "type_identifier") return d.text;
    d = d.childForFieldName("declarator") ?? d.namedChild(0);
  }
  return undefined;
}

/** Parse `content` with the right grammar and return its symbol DEFINITIONS, or null to signal
 *  "fall back to the regex extractor" (no grammar for this file, parse error, or nothing found —
 *  so tree-sitter can only ever match or beat the regex coverage, never regress below it). */
export function extractSymbolsTS(path: string, content: string): Sym[] | null {
  if (!ready) return null;
  const grammar = EXT_GRAMMAR[extname(path)];
  if (!grammar) return null;
  const parser = parsers.get(grammar);
  const defs = GRAMMAR_DEFS[grammar];
  if (!parser || !defs) return null;
  try {
    const tree = parser.parse(content);
    const out: Sym[] = [];
    const stack: Array<{ node: TsNode; parent: string }> = [{ node: tree.rootNode, parent: "" }];
    while (stack.length) {
      const { node, parent } = stack.pop()!;
      const kind = defs[node.type];
      if (kind && acceptDef(node, parent)) {
        const name = nodeName(node);
        if (name && name !== "constructor" && IDENT_RE.test(name)) out.push({ name, kind, line: node.startPosition.row + 1 });
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const ch = node.namedChild(i);
        if (ch) stack.push({ node: ch, parent: node.type });
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}
