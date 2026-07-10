// Repository map (Phase 1) — codebase context without dumping whole files (R4, the Aider design).
//
// Extract symbol definitions per file, build a graph where an edge A→B means "file A
// references a symbol defined in file B", then rank files by PageRank centrality and emit
// a budgeted listing of the most-referenced files + their key symbols.
//
// Symbol extraction uses tree-sitter (R4/R7 — the Aider design) when its grammars are loaded
// (see treesitter.ts; `initTreeSitter()` is awaited at boot), and transparently falls back to the
// per-language regex extractor below when a grammar is missing, a parse fails, or tree-sitter is
// disabled. So accuracy upgrades where tree-sitter is available without ever regressing coverage.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { extractSymbolsTS } from "./treesitter.ts";

export interface Sym { name: string; kind: string; line: number; }
export interface RankedFile { path: string; rank: number; symbols: Sym[]; }
export interface RepoMap { files: RankedFile[]; totalFiles: number; totalSymbols: number; }

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".ob1", "dist", "build", ".next", "out", "vendor",
  "target", "__pycache__", ".venv", "venv", ".cache", "coverage",
]);

const EXT_LANG: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
  ".rb": "ruby", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".cs": "csharp",
};

// Per-language line patterns: [regex, kind]. Conservative — favour precision over recall.
const PATTERNS: Record<string, [RegExp, string][]> = {
  ts: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/, "class"],
    [/^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/, "interface"],
    [/^\s*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/, "type"],
    [/^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$,\s]*)\s*=>/, "const"],
  ],
  python: [
    [/^\s*def\s+([A-Za-z0-9_]+)/, "def"],
    [/^\s*class\s+([A-Za-z0-9_]+)/, "class"],
  ],
  go: [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/, "func"],
    [/^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/, "type"],
  ],
  rust: [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/, "fn"],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/, "type"],
  ],
  java: [
    [/^\s*(?:public|private|protected)?\s*(?:abstract\s+)?(?:final\s+)?class\s+([A-Za-z0-9_]+)/, "class"],
    [/^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z0-9_]+)/, "interface"],
  ],
  ruby: [
    [/^\s*def\s+([A-Za-z0-9_?!]+)/, "def"],
    [/^\s*class\s+([A-Za-z0-9_]+)/, "class"],
  ],
};
PATTERNS.js = PATTERNS.ts;
PATTERNS.csharp = PATTERNS.java;
PATTERNS.cpp = [[/^\s*(?:class|struct)\s+([A-Za-z0-9_]+)/, "type"]];
PATTERNS.c = PATTERNS.cpp;

function langOf(path: string): string | undefined { return EXT_LANG[extname(path)]; }

/** Pluggable symbol extractor (swap for tree-sitter on Node). */
export function extractSymbols(lang: string, content: string): Sym[] {
  const pats = PATTERNS[lang];
  if (!pats) return [];
  const out: Sym[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [re, kind] of pats) {
      const m = re.exec(lines[i]);
      if (m) { out.push({ name: m[1], kind, line: i + 1 }); break; }
    }
  }
  return out;
}

function walk(root: string, maxFiles: number): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length && found.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith(".") && name !== ".") continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (!IGNORE_DIRS.has(name)) stack.push(full); }
      else if (langOf(full) && st.size <= 500_000) found.push(full);
    }
  }
  return found;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

export function buildRepoMap(root: string, opts: { maxFiles?: number } = {}): RepoMap {
  const maxFiles = opts.maxFiles ?? 2000;
  const paths = walk(root, maxFiles);

  const fileSyms = new Map<string, Sym[]>();
  const contents = new Map<string, string>();
  const symbolToFiles = new Map<string, Set<string>>();
  let totalSymbols = 0;

  for (const p of paths) {
    let content: string;
    try { content = readFileSync(p, "utf8"); } catch { continue; }
    const lang = langOf(p)!;
    const syms = extractSymbolsTS(p, content) ?? extractSymbols(lang, content);
    fileSyms.set(p, syms);
    contents.set(p, content);
    totalSymbols += syms.length;
    for (const s of syms) {
      if (s.name.length < 2) continue;
      let set = symbolToFiles.get(s.name);
      if (!set) symbolToFiles.set(s.name, (set = new Set()));
      set.add(p);
    }
  }

  // Edges: file A → file B when A mentions a symbol defined in B (A ≠ B). Weighted by count.
  const edges = new Map<string, Map<string, number>>();
  const outWeight = new Map<string, number>();
  for (const [p, content] of contents) {
    const m = content.match(IDENT);
    if (!m) continue;
    const local = new Set((fileSyms.get(p) ?? []).map((s) => s.name));
    const seen = new Map<string, number>();
    for (const id of m) {
      const defs = symbolToFiles.get(id);
      if (!defs || local.has(id)) continue;
      for (const target of defs) if (target !== p) seen.set(target, (seen.get(target) ?? 0) + 1);
    }
    if (seen.size) {
      edges.set(p, seen);
      let w = 0; for (const v of seen.values()) w += v;
      outWeight.set(p, w);
    }
  }

  // PageRank over the file graph.
  const nodes = [...contents.keys()];
  const N = nodes.length || 1;
  const d = 0.85;
  let rank = new Map(nodes.map((n) => [n, 1 / N]));
  const incoming = new Map<string, [string, number][]>();
  for (const [src, tos] of edges) for (const [dst, w] of tos) {
    (incoming.get(dst) ?? incoming.set(dst, []).get(dst)!).push([src, w]);
  }
  for (let iter = 0; iter < 25; iter++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const n of nodes) if (!outWeight.get(n)) dangling += rank.get(n)! / N;
    for (const n of nodes) {
      let sum = 0;
      for (const [src, w] of incoming.get(n) ?? []) sum += rank.get(src)! * (w / outWeight.get(src)!);
      next.set(n, (1 - d) / N + d * (sum + dangling));
    }
    rank = next;
  }

  const files: RankedFile[] = nodes
    .map((p) => ({ path: relative(root, p), rank: rank.get(p)!, symbols: fileSyms.get(p) ?? [] }))
    .filter((f) => f.symbols.length > 0)
    .sort((a, b) => b.rank - a.rank);

  return { files, totalFiles: paths.length, totalSymbols };
}

// ── Auto repo map: a cached, budgeted summary injected into EVERY system prompt so the model always
// knows the codebase structure without having to call the repo_map tool. Built on first use and reused
// until invalidateRepoMap() is called (after a file-mutating turn), so it costs a rebuild only when the
// tree actually changed — not every turn. Whether it's injected is gated by the CALLER (cfg.repoMap /
// the /settings toggle / OB1_REPO_MAP); here we just build it. Tune size with OB1_REPO_MAP_BUDGET.
let _summaryCache: { root: string; text: string } | null = null;

/** The cached repo-map summary for context injection ("" when empty or on error). */
export function repoMapSummary(root: string): string {
  if (_summaryCache && _summaryCache.root === root) return _summaryCache.text;
  let text = "";
  try {
    const map = buildRepoMap(root, { maxFiles: 800 });
    const budget = Math.max(500, Number(process.env.OB1_REPO_MAP_BUDGET) || 3000);
    text = map.files.length ? renderRepoMap(map, { budgetChars: budget, maxFiles: 30 }) : "";
  } catch { text = ""; }
  _summaryCache = { root, text };
  return text;
}

/** Drop the cached summary so the next repoMapSummary() rebuilds it — call after files change. */
export function invalidateRepoMap(): void { _summaryCache = null; }

/** Render a budgeted, ranked map for injection into context. */
export function renderRepoMap(
  map: RepoMap,
  opts: { maxFiles?: number; maxSymbols?: number; budgetChars?: number } = {},
): string {
  const maxFiles = opts.maxFiles ?? 25;
  const maxSymbols = opts.maxSymbols ?? 12;
  const budget = opts.budgetChars ?? 4000;
  const shown = map.files.slice(0, maxFiles);
  const lines = [`Repository map — top ${shown.length} of ${map.totalFiles} files by reference centrality:`, ""];
  let chars = lines.join("\n").length;
  for (const f of shown) {
    const syms = f.symbols.slice(0, maxSymbols).map((s) => `${s.name}${s.kind === "function" || s.kind === "def" || s.kind === "fn" ? "()" : ""}`);
    const block = `${f.path}\n  ${syms.join(" · ")}`;
    if (chars + block.length > budget) { lines.push(`… (${shown.length - lines.length + 2} more files truncated for budget)`); break; }
    lines.push(block);
    chars += block.length + 1;
  }
  return lines.join("\n");
}
