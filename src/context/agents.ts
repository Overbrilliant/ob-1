// AGENTS.md — the always-loaded project memory index (R6 convergent standard; R3 index tier).
// OB-1 owns only clearly-marked blocks; human notes outside those blocks are preserved. Detailed,
// fast-changing context lives in .ob1/episodes and topic files, with AGENTS.md acting as a concise index.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepoMap } from "./repomap.ts";

export interface ProjectInfo {
  stack: string[];
  build?: string;
  test?: string;
  run?: string;
}

export interface AgentsMemory {
  validatedChecks?: string[];
  validatedBehaviorChecks?: string[];
  projectFacts?: string[];
  qualityPatterns?: string[];
  failurePatterns?: string[];
  knownIssues?: string[];
  lastEpisode?: { id: string; title: string; ts: string };
}

const PROJECT_BEGIN = "<!-- OB1:BEGIN project -->";
const PROJECT_END = "<!-- OB1:END project -->";
const MEMORY_BEGIN = "<!-- OB1:BEGIN memory -->";
const MEMORY_END = "<!-- OB1:END memory -->";

function readFile(cwd: string, f: string): string | null {
  try { return readFileSync(join(cwd, f), "utf8"); } catch { return null; }
}

export function detectProject(cwd: string): ProjectInfo {
  const info: ProjectInfo = { stack: [] };
  const pkg = readFile(cwd, "package.json");
  if (pkg) {
    const pm = readFile(cwd, "bun.lock") || readFile(cwd, "bun.lockb") ? "bun run"
      : readFile(cwd, "pnpm-lock.yaml") ? "pnpm"
      : readFile(cwd, "yarn.lock") ? "yarn"
      : "npm run";
    info.stack.push(pm.startsWith("bun") ? "TypeScript / Bun" : "Node / TypeScript");
    try {
      const s = (JSON.parse(pkg).scripts ?? {}) as Record<string, string>;
      if (s.build) info.build = `${pm} build`;
      if (s.test) info.test = `${pm} test`;
      if (s.start) info.run = `${pm} start`;
    } catch { /* ignore */ }
  }
  if (readFile(cwd, "go.mod")) { info.stack.push("Go"); info.build ??= "go build ./..."; info.test ??= "go test ./..."; }
  if (readFile(cwd, "Cargo.toml")) { info.stack.push("Rust"); info.build ??= "cargo build"; info.test ??= "cargo test"; }
  if (readFile(cwd, "pyproject.toml") || readFile(cwd, "requirements.txt")) info.stack.push("Python");
  return info;
}

function projectBlock(cwd: string): string {
  const info = detectProject(cwd);
  let map;
  try { map = buildRepoMap(cwd, { maxFiles: 500 }); } catch { map = null; }
  const keyFiles = map ? map.files.slice(0, 10).map((f) => `- \`${f.path}\``).join("\n") : "";

  const cmds = [
    info.build ? `- build: \`${info.build}\`` : null,
    info.test ? `- test: \`${info.test}\`` : null,
    info.run ? `- run: \`${info.run}\`` : null,
  ].filter(Boolean).join("\n");

  const topics = [".ob1/topics/progress.md", ".ob1/topics/testing.md", ".ob1/topics/architecture.md"];
  const existingTopics = topics.filter((p) => existsSync(join(cwd, p)));

  return `${PROJECT_BEGIN}
## Project index

### Stack
${info.stack.length ? info.stack.map((s) => `- ${s}`).join("\n") : "- (not detected)"}

### Commands
${cmds || "- (none detected — add build/test/run here)"}

### Key files
${keyFiles || "- (none detected)"}

### Topic files
${existingTopics.length ? existingTopics.map((p) => `- \`${p}\``).join("\n") : "- Detailed notes live in `.ob1/topics/` when they exist."}
${PROJECT_END}`;
}

function memoryBlock(memory: AgentsMemory = {}): string {
  const checks = memory.validatedChecks?.length ? memory.validatedChecks : ["(none recorded yet)"];
  const behavior = memory.validatedBehaviorChecks?.length ? memory.validatedBehaviorChecks : ["(none recorded yet)"];
  const facts = memory.projectFacts?.length ? memory.projectFacts : ["(none promoted yet)"];
  const quality = memory.qualityPatterns?.length ? memory.qualityPatterns : ["(none promoted yet)"];
  const failures = memory.failurePatterns?.length ? memory.failurePatterns : ["(none recorded)"];
  const issues = memory.knownIssues?.length ? memory.knownIssues : ["(none recorded)"];
  const episode = memory.lastEpisode
    ? `- Last episode: \`${memory.lastEpisode.id}\` — ${memory.lastEpisode.title} (${memory.lastEpisode.ts})`
    : "- Last episode: (none yet)";
  return `${MEMORY_BEGIN}
## Project memory

### Validated checks
${checks.map((x) => `- ${x}`).join("\n")}

### Validated behavior checks
${behavior.map((x) => `- ${x}`).join("\n")}

### Durable facts
${facts.map((x) => `- ${x}`).join("\n")}

### Quality patterns
${quality.map((x) => `- ${x}`).join("\n")}

### Failure patterns
${failures.map((x) => `- ${x}`).join("\n")}

### Known issues / follow-ups
${issues.map((x) => `- ${x}`).join("\n")}

### Episodes
${episode}
- Episode files: \`.ob1/episodes/*.md\` (local, ignored)
${MEMORY_END}`;
}

function defaultHumanTail(): string {
  return `## Conventions
- (add project-specific conventions, gotchas, and house style here)`;
}

function renderAgentsMd(cwd: string, memory: AgentsMemory = {}, humanTail = defaultHumanTail()): string {
  return `# AGENTS.md

> OB-1 project memory index. OB-1 refreshes only the marked blocks below; edit freely outside them.
> Keep this concise (under ~200 lines). Put detailed notes in topic files and let episodes hold history.

${projectBlock(cwd)}

${memoryBlock(memory)}

${humanTail.trim()}
`;
}

export function generateAgentsMd(cwd: string, memory: AgentsMemory = {}): string {
  return renderAgentsMd(cwd, memory);
}

function replaceBlock(text: string, begin: string, end: string, next: string): string {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start >= 0 && stop > start) return text.slice(0, start) + next + text.slice(stop + end.length);
  return `${text.replace(/\s+$/, "")}\n\n${next}\n`;
}

function legacyHumanTail(text: string): string {
  const conventions = text.match(/^## Conventions\b/m);
  if (conventions) return text.slice(conventions.index).trim();
  const headings = [...text.matchAll(/^## /gm)].map((m) => m.index ?? 0);
  const firstCustom = headings.find((i) => {
    const h = text.slice(i, text.indexOf("\n", i) === -1 ? undefined : text.indexOf("\n", i));
    return !/^## (Stack|Commands|Key files)/.test(h);
  });
  return firstCustom == null ? defaultHumanTail() : text.slice(firstCustom).trim();
}

export function refreshAgentsMd(cwd: string, memory: AgentsMemory = {}): { path: string; created: boolean; updated: boolean } {
  const path = join(cwd, "AGENTS.md");
  if (!existsSync(path)) {
    writeFileSync(path, generateAgentsMd(cwd, memory));
    return { path, created: true, updated: true };
  }
  const current = readFileSync(path, "utf8");
  const generated = current.includes("Auto-generated by OB-1 on first run");
  const managed = current.includes(PROJECT_BEGIN) || current.includes(MEMORY_BEGIN);
  if (!generated && !managed) return { path, created: false, updated: false };
  const next = generated
    ? renderAgentsMd(cwd, memory, legacyHumanTail(current))
    : replaceBlock(replaceBlock(current, PROJECT_BEGIN, PROJECT_END, projectBlock(cwd)), MEMORY_BEGIN, MEMORY_END, memoryBlock(memory));
  if (next !== current) writeFileSync(path, next);
  return { path, created: false, updated: next !== current };
}

/** Create/update AGENTS.md only when OB-1 owns the file or marked blocks. */
export function ensureAgentsMd(cwd: string, memory: AgentsMemory = {}): { path: string; created: boolean; updated: boolean } {
  return refreshAgentsMd(cwd, memory);
}

/** Load AGENTS.md, bounded to the first maxLines/maxBytes (Memory Bank index pattern). */
export function loadAgentsMd(cwd: string, maxLines = 200, maxBytes = 25_000): string | null {
  const path = join(cwd, "AGENTS.md");
  if (!existsSync(path)) return null;
  let txt = readFileSync(path, "utf8").split("\n").slice(0, maxLines).join("\n");
  if (txt.length > maxBytes) txt = txt.slice(0, maxBytes);
  return txt;
}
