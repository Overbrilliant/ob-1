import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Message } from "../providers/types.ts";
import { refreshAgentsMd, type AgentsMemory } from "./agents.ts";

export interface EpisodeCommand { command: string; ok?: boolean; lines?: number }
export interface EpisodeRecord {
  id: string;
  ts: string;
  task: string;
  mode: string;
  tools: string[];
  files: string[];
  commands: EpisodeCommand[];
  finalText?: string;
}

export interface PromotionCandidate {
  id: string;
  kind: "validated-check" | "validated-behavior-check" | "project-fact" | "quality-pattern" | "failure-pattern" | "known-issue";
  text: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sourceEpisodes: string[];
  promoted?: boolean;
}

const memoryDir = (cwd: string) => join(cwd, ".ob1", "agents");
const episodesDir = (cwd: string) => join(cwd, ".ob1", "episodes");
const memoryPath = (cwd: string) => join(memoryDir(cwd), "memory.json");
const candidatesPath = (cwd: string) => join(memoryDir(cwd), "candidates.json");

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function safeSlug(s: string): string {
  return s.toLowerCase().replace(/[`'"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "episode";
}

function nowId(task: string): { id: string; ts: string } {
  const ts = new Date().toISOString();
  return { ts, id: `${ts.replace(/[:.]/g, "-")}-${safeSlug(task)}` };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
}

function compactFinalText(history: Message[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (text) return text.slice(0, 1200);
  }
  return undefined;
}

function changedFiles(cwd: string): string[] {
  try {
    const p = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd, stdout: "pipe", stderr: "pipe" });
    if ((p.exitCode ?? 1) !== 0) return [];
    return new TextDecoder().decode(p.stdout).split("\n")
      .map((line) => line.slice(3).trim())
      .filter((file) => file && !file.startsWith(".ob1/") && file !== ".ob1");
  } catch {
    return [];
  }
}

function lineCount(output: string): number {
  const body = output.replace(/^exit \d+\n?/, "").trimEnd();
  return body ? body.split("\n").length : 0;
}

function looksLikeCheck(command: string): boolean {
  return /\b(test|typecheck|tsc|lint|eslint|build|cargo check|cargo test|go test|pytest|ruff|mypy)\b/i.test(command);
}

function isOkResult(output: string): boolean | undefined {
  if (output === "exit 0" || output.startsWith("exit 0\n")) return true;
  if (/^(exit \d+|timed out)/.test(output)) return false;
  return undefined;
}

function extractFromHistory(cwd: string, history: Message[], task: string, mode: string): EpisodeRecord {
  const { id, ts } = nowId(task);
  const calls = new Map<string, { name: string; input: any }>();
  const tools = new Set<string>();
  const files = new Set<string>();
  const commands: EpisodeCommand[] = [];

  for (const m of history) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as any[]) {
        if (b?.type !== "tool_use") continue;
        calls.set(String(b.id), { name: String(b.name), input: b.input ?? {} });
        tools.add(String(b.name));
        const p = b.input?.path;
        if ((b.name === "write_file" || b.name === "edit_file") && typeof p === "string") files.add(p);
      }
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content as any[]) {
        if (b?.type !== "tool_result") continue;
        const call = calls.get(String(b.tool_use_id));
        if (!call || call.name !== "run_bash") continue;
        const command = String(call.input?.command ?? "").trim();
        if (!command) continue;
        const out = toolResultText(b.content);
        commands.push({ command, ok: isOkResult(out), lines: lineCount(out) });
      }
    }
  }

  for (const f of changedFiles(cwd)) files.add(f);
  return { id, ts, task, mode, tools: [...tools], files: [...files].sort(), commands, finalText: compactFinalText(history) };
}

function renderEpisode(ep: EpisodeRecord): string {
  return `# Episode: ${ep.task}

- id: \`${ep.id}\`
- time: ${ep.ts}
- mode: ${ep.mode}
- files: ${ep.files.length ? ep.files.map((f) => `\`${f}\``).join(", ") : "(none)"}
- tools: ${ep.tools.length ? ep.tools.map((t) => `\`${t}\``).join(", ") : "(none)"}

## Commands
${ep.commands.length ? ep.commands.map((cmd) => `- ${cmd.ok === true ? "✓" : cmd.ok === false ? "✗" : "•"} \`${cmd.command}\`${cmd.lines != null ? ` (${cmd.lines} output line${cmd.lines === 1 ? "" : "s"})` : ""}`).join("\n") : "- (none)"}

## Final response
${ep.finalText || "(no final text captured)"}
`;
}

export function loadAgentsMemory(cwd: string): AgentsMemory {
  return readJson<AgentsMemory>(memoryPath(cwd), {});
}

function saveAgentsMemory(cwd: string, memory: AgentsMemory): void {
  writeJson(memoryPath(cwd), memory);
}

function loadCandidates(cwd: string): PromotionCandidate[] {
  return readJson<PromotionCandidate[]>(candidatesPath(cwd), []);
}

function saveCandidates(cwd: string, candidates: PromotionCandidate[]): void {
  writeJson(candidatesPath(cwd), candidates);
}

function candidateId(kind: PromotionCandidate["kind"], text: string): string {
  return `${kind}:${safeSlug(text).slice(0, 80)}`;
}

function upsertCandidate(candidates: PromotionCandidate[], kind: PromotionCandidate["kind"], text: string, episode: EpisodeRecord): void {
  const id = candidateId(kind, text);
  const existing = candidates.find((c) => c.id === id);
  if (existing) {
    existing.count++;
    existing.lastSeen = episode.ts;
    if (!existing.sourceEpisodes.includes(episode.id)) existing.sourceEpisodes.push(episode.id);
    return;
  }
  candidates.push({ id, kind, text, count: 1, firstSeen: episode.ts, lastSeen: episode.ts, sourceEpisodes: [episode.id] });
}

function autoUpdateMemory(cwd: string, episode: EpisodeRecord): AgentsMemory {
  const memory = loadAgentsMemory(cwd);
  const checks = new Map<string, string>();
  for (const line of memory.validatedChecks ?? []) {
    const key = line.match(/`([^`]+)`/)?.[1] ?? line;
    checks.set(key, line);
  }
  for (const cmd of episode.commands) {
    if (cmd.ok && looksLikeCheck(cmd.command)) checks.set(cmd.command, `\`${cmd.command}\` passed (last verified ${episode.ts.slice(0, 10)})`);
  }
  memory.validatedChecks = [...checks.values()].slice(-8);
  memory.lastEpisode = { id: episode.id, title: episode.task.slice(0, 90), ts: episode.ts.slice(0, 10) };
  saveAgentsMemory(cwd, memory);
  refreshAgentsMd(cwd, memory);
  return memory;
}

function updateCandidates(cwd: string, episode: EpisodeRecord): PromotionCandidate[] {
  const candidates = loadCandidates(cwd);
  for (const cmd of episode.commands) {
    if (cmd.ok && looksLikeCheck(cmd.command)) upsertCandidate(candidates, "validated-check", `Use \`${cmd.command}\` to validate this project.`, episode);
  }
  if (episode.tools.includes("browser_check")) {
    upsertCandidate(candidates, "validated-behavior-check", "Use `browser_check` to validate interactive or visual UI changes.", episode);
  }
  if (episode.tools.includes("update_tasks")) {
    upsertCandidate(candidates, "quality-pattern", "For multi-step work, maintain the visible task list and update it as each step changes status.", episode);
  }
  const failedChecks = episode.commands.filter((cmd) => cmd.ok === false && looksLikeCheck(cmd.command));
  for (const cmd of failedChecks.slice(0, 3)) {
    upsertCandidate(candidates, "failure-pattern", `When \`${cmd.command}\` fails, inspect the failure output and rerun the smallest targeted check after fixing it.`, episode);
  }
  if (/pre-existing|known issue|follow[- ]?up|todo/i.test(episode.finalText ?? "")) {
    upsertCandidate(candidates, "known-issue", (episode.finalText ?? "").split("\n")[0].slice(0, 240), episode);
  }
  saveCandidates(cwd, candidates);
  return candidates;
}

export function rememberEpisode(cwd: string, task: string, mode: string, historySlice: Message[]): { episode: EpisodeRecord; candidates: PromotionCandidate[] } {
  const episode = extractFromHistory(cwd, historySlice, task, mode);
  mkdirSync(episodesDir(cwd), { recursive: true });
  writeFileSync(join(episodesDir(cwd), `${episode.id}.md`), renderEpisode(episode));
  const candidates = updateCandidates(cwd, episode);
  autoUpdateMemory(cwd, episode);
  return { episode, candidates };
}

export function listEpisodes(cwd: string, limit = 10): EpisodeRecord[] {
  const dir = episodesDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, limit).map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    const task = text.match(/^# Episode: (.+)$/m)?.[1] ?? basename(f, ".md");
    const ts = text.match(/^- time: (.+)$/m)?.[1] ?? "";
    const mode = text.match(/^- mode: (.+)$/m)?.[1] ?? "";
    return { id: basename(f, ".md"), ts, task, mode, tools: [], files: [], commands: [] };
  });
}

export function listPromotionCandidates(cwd: string, includePromoted = false): PromotionCandidate[] {
  const candidates = loadCandidates(cwd);
  return includePromoted ? candidates : candidates.filter((c) => !c.promoted);
}

function appendUnique(list: string[] | undefined, text: string): string[] {
  const out = list ? [...list] : [];
  if (!out.includes(text)) out.push(text);
  return out.slice(-12);
}

export function promoteCandidates(cwd: string, ids: string[] | "all"): { promoted: PromotionCandidate[]; memory: AgentsMemory } {
  const candidates = loadCandidates(cwd);
  const chosen = candidates.filter((c) => !c.promoted && (ids === "all" || ids.includes(c.id)));
  const memory = loadAgentsMemory(cwd);
  for (const c of chosen) {
    if (c.kind === "validated-check") memory.validatedChecks = appendUnique(memory.validatedChecks, c.text);
    else if (c.kind === "validated-behavior-check") memory.validatedBehaviorChecks = appendUnique(memory.validatedBehaviorChecks, c.text);
    else if (c.kind === "quality-pattern") memory.qualityPatterns = appendUnique(memory.qualityPatterns, c.text);
    else if (c.kind === "failure-pattern") memory.failurePatterns = appendUnique(memory.failurePatterns, c.text);
    else if (c.kind === "known-issue") memory.knownIssues = appendUnique(memory.knownIssues, c.text);
    else memory.projectFacts = appendUnique(memory.projectFacts, c.text);
    c.promoted = true;
  }
  saveAgentsMemory(cwd, memory);
  saveCandidates(cwd, candidates);
  refreshAgentsMd(cwd, memory);
  return { promoted: chosen, memory };
}
