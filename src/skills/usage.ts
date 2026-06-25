// Skill usage telemetry + curator (Phase C). A sidecar JSON tracks how often each learned skill is
// loaded; the curator ages skills active → stale → archived by inactivity (and reactivates on use), so
// a learned library self-prunes instead of growing unbounded. Deterministic + file-based — no LLM.
// Mirrors hermes-agent's .usage.json + curator, scoped to OB-1's single learned root (.ob1/skills).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { learnedDir, findSkill, setSkillState, listSkills, type SkillMeta } from "./registry.ts";

export interface UsageRecord { uses: number; lastUsed?: string }
export type UsageMap = Record<string, UsageRecord>;

function usagePath(cwd: string): string { return join(learnedDir(cwd), ".usage.json"); }

export function readUsage(cwd: string): UsageMap {
  const p = usagePath(cwd);
  if (!existsSync(p)) return {};
  try { const j = JSON.parse(readFileSync(p, "utf8")); return j && typeof j === "object" ? j : {}; }
  catch { return {}; }
}

function writeUsage(cwd: string, data: UsageMap): void {
  try { writeFileSync(usagePath(cwd), JSON.stringify(data, null, 2)); } catch { /* telemetry is best-effort */ }
}

const DAY_MS = 86_400_000;
function nowIso(): string { return new Date().toISOString(); }

/** Record that a skill was loaded (use_skill). Bumps the count + timestamp and, if the skill had been
 *  aged to stale/archived, reactivates it immediately. Never throws. */
export function recordSkillUse(cwd: string, name: string): void {
  try {
    const skill = findSkill(cwd, name);
    if (!skill) return;
    const key = skill.name;
    const u = readUsage(cwd);
    const rec = u[key] ?? { uses: 0 };
    rec.uses += 1;
    rec.lastUsed = nowIso();
    u[key] = rec;
    writeUsage(cwd, u);
    // Reactivate a learned skill the moment it proves useful again.
    if (skill.origin === "agent" && skill.state !== "active") setSkillState(cwd, key, "active");
  } catch { /* best-effort */ }
}

export interface CuratorResult { staled: string[]; archived: string[]; reactivated: string[] }

/** The most recent activity timestamp for a skill: max(created, updated, lastUsed). */
function lastActivityMs(skill: SkillMeta, usage: UsageMap): number {
  const stamps = [skill.created, skill.updated, usage[skill.name]?.lastUsed]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((n) => !Number.isNaN(n));
  return stamps.length ? Math.max(...stamps) : 0;
}

/** Age LEARNED skills by inactivity. active → stale after `staleDays`, stale → archived after
 *  `archiveDays`; anything used within `staleDays` is (re)activated. Only touches origin:agent skills.
 *  `nowMs` is injectable for deterministic tests. */
export function runCurator(cwd: string, opts: { staleDays?: number; archiveDays?: number; nowMs?: number } = {}): CuratorResult {
  const staleDays = opts.staleDays ?? 30;
  const archiveDays = opts.archiveDays ?? 60;
  const now = opts.nowMs ?? Date.now();
  const usage = readUsage(cwd);
  const out: CuratorResult = { staled: [], archived: [], reactivated: [] };

  for (const skill of listSkills(cwd, { includeArchived: true })) {
    if (skill.origin !== "agent") continue; // never age shipped/user skills (provenance gate)
    const ageDays = (now - lastActivityMs(skill, usage)) / DAY_MS;
    if (ageDays >= archiveDays) {
      if (skill.state !== "archived" && setSkillState(cwd, skill.name, "archived")) out.archived.push(skill.name);
    } else if (ageDays >= staleDays) {
      if (skill.state === "active" && setSkillState(cwd, skill.name, "stale")) out.staled.push(skill.name);
    } else {
      // Recent activity → ensure it's active (reactivate a stale/archived skill that got used).
      if (skill.state !== "active" && setSkillState(cwd, skill.name, "active")) out.reactivated.push(skill.name);
    }
  }
  return out;
}
