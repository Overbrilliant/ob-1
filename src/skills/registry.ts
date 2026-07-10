// On-demand Skills (Phase 2, R1) + self-learned procedural memory (skill-learning phases A–C).
//
// A skill is a markdown file with frontmatter:
//
//   ---
//   name: code-review
//   description: Review the current diff for bugs and cleanups
//   origin: agent          # "agent" = learned/curated by OB-1; absent/"user" = human-authored or shipped
//   state: active          # active | stale | archived  (curator-managed; archived skills are hidden)
//   created: 2026-06-22T...
//   updated: 2026-06-22T...
//   ---
//   <instructions…>
//
// Only name + description are surfaced to the model (cheap, always-on). The full body is loaded ONLY
// when the agent invokes `use_skill` — keeping base context small. Skills come from two roots:
//   • cwd/skills            — shipped/project skills (read-only)
//   • cwd/.ob1/skills       — LEARNED skills, the single WRITABLE root (manage_skill writes here)
// Learned skills carry origin:agent so the curator only ever ages/edits skills the agent itself made
// — human-authored skills are never touched (provenance gate, mirrors hermes-agent's design).
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export type SkillOrigin = "agent" | "user";
export type SkillState = "active" | "stale" | "archived";

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  origin: SkillOrigin;
  state: SkillState;
  created?: string;
  updated?: string;
}

/** Skills that ship WITH ob1 — the repo/install `skills/` dir, resolved relative to THIS module so they
 *  load no matter which directory ob1 runs in (registry.ts is at <root>/src/skills/, so skills/ is two up).
 *  This is what makes a shipped skill like design-skill available in EVERY project, not just the repo. */
function shippedDir(): string {
  try { return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills"); } catch { return ""; }
}

/** User-global skills root (~/.ob1/skills) — drop a markdown skill here to have it in every project. */
function globalDir(): string {
  return join(homedir(), ".ob1", "skills");
}

/** Resolution order, first match wins on a name clash: project (cwd/skills) → ob1's shipped skills →
 *  user-global (~/.ob1/skills) → the writable LEARNED root last (so any curated skill wins over a learned
 *  one). Shipped + global make skills available regardless of the working directory. */
function skillDirs(cwd: string): string[] {
  return [join(cwd, "skills"), shippedDir(), globalDir(), learnedDir(cwd)].filter(Boolean);
}

/** The single WRITABLE skills root — where learned/agent-created skills live. */
export function learnedDir(cwd: string): string {
  return join(cwd, ".ob1", "skills");
}

/** Filesystem-safe slug for a skill name → its file basename (`<slug>.md`). */
export function slugify(name: string): string {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = text.slice(3, end);
      const body = text.slice(end + 4).replace(/^\s*\n/, "");
      const meta: Record<string, string> = {};
      for (const line of fm.split("\n")) {
        const m = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
        if (m) meta[m[1]] = m[2].trim();
      }
      return { meta, body };
    }
  }
  return { meta: {}, body: text };
}

function toMeta(raw: Record<string, string>, file: string, path: string): SkillMeta {
  const origin: SkillOrigin = raw.origin === "agent" ? "agent" : "user";
  const state: SkillState = raw.state === "stale" || raw.state === "archived" ? raw.state : "active";
  return {
    name: raw.name || file.replace(/\.md$/, ""),
    description: raw.description || "(no description)",
    path,
    origin,
    state,
    created: raw.created || undefined,
    updated: raw.updated || undefined,
  };
}

/** List available skills (metadata only — bodies are not read here). Archived skills are hidden by
 *  default (the model should not see them); pass includeArchived for management/curation views. */
export function listSkills(cwd: string, opts: { includeArchived?: boolean } = {}): SkillMeta[] {
  const seen = new Set<string>();
  const out: SkillMeta[] = [];
  for (const dir of skillDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      let meta: SkillMeta;
      try { meta = toMeta(parseFrontmatter(readFileSync(path, "utf8")).meta, f, path); } catch { continue; }
      if (seen.has(meta.name)) continue;
      seen.add(meta.name);
      if (meta.state === "archived" && !opts.includeArchived) continue;
      out.push(meta);
    }
  }
  return out;
}

/** Find a skill's metadata by name (includes archived). Slug-tolerant: matches an exact name first,
 *  then by slug, so callers can pass either the display name ("Retry Pattern") or its slug
 *  ("retry-pattern") — learned skills are stored under their slug. */
export function findSkill(cwd: string, name: string): SkillMeta | null {
  const all = listSkills(cwd, { includeArchived: true });
  const exact = all.find((s) => s.name === name);
  if (exact) return exact;
  const slug = slugify(name);
  return all.find((s) => slugify(s.name) === slug) ?? null;
}

/** Load a skill's full instruction body on demand. Returns null if not found. */
export function readSkill(cwd: string, name: string): string | null {
  const skill = findSkill(cwd, name);
  if (!skill) return null;
  try { return parseFrontmatter(readFileSync(skill.path, "utf8")).body.trim(); }
  catch { return null; }
}

function nowIso(): string { return new Date().toISOString(); }

function renderSkillFile(m: { name: string; description: string; origin: SkillOrigin; state: SkillState; created: string; updated: string }, body: string): string {
  const fm = [
    `name: ${m.name}`,
    `description: ${m.description.replace(/\n/g, " ").trim()}`,
    `origin: ${m.origin}`,
    `state: ${m.state}`,
    `created: ${m.created}`,
    `updated: ${m.updated}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

export interface WriteSkillResult { ok: true; path: string; created: boolean }
export interface WriteSkillError { ok: false; error: string }

/** Create or fully replace a LEARNED skill under cwd/.ob1/skills. Refuses to shadow a shipped/user
 *  skill of the same name (suggest patch instead) — keeps learned and human skills disjoint. */
export function writeSkill(cwd: string, input: { name: string; description: string; body: string }): WriteSkillResult | WriteSkillError {
  const slug = slugify(input.name);
  if (!slug) return { ok: false, error: `invalid skill name: ${JSON.stringify(input.name)}` };
  if (!input.description?.trim()) return { ok: false, error: "a skill needs a one-line description" };
  if (!input.body?.trim()) return { ok: false, error: "a skill needs a non-empty body (the instructions)" };

  // Collision guard: a non-learned (shipped/user) skill with this name must not be shadowed.
  const existing = findSkill(cwd, slug) ?? findSkill(cwd, input.name);
  const dir = learnedDir(cwd);
  const path = join(dir, `${slug}.md`);
  if (existing && existing.path !== path) {
    return { ok: false, error: `a non-learned skill "${existing.name}" already exists — patch it with action="update" instead of creating a duplicate` };
  }

  const created = !existsSync(path);
  let createdAt = nowIso();
  if (!created) { try { createdAt = parseFrontmatter(readFileSync(path, "utf8")).meta.created || createdAt; } catch { /* keep new stamp */ } }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, renderSkillFile({ name: slug, description: input.description, origin: "agent", state: "active", created: createdAt, updated: nowIso() }, input.body));
  } catch (e) {
    return { ok: false, error: `could not write skill: ${(e as Error).message}` };
  }
  return { ok: true, path, created };
}

/** Patch a learned skill's BODY via search/replace (exact, must be unique). Bumps `updated`. Only
 *  operates on learned skills under .ob1/skills — shipped/user skills are protected. */
export function patchSkill(cwd: string, name: string, oldString: string, newString: string): WriteSkillResult | WriteSkillError {
  const skill = findSkill(cwd, name);
  if (!skill) return { ok: false, error: `unknown skill: ${name}` };
  if (skill.origin !== "agent" || !skill.path.startsWith(learnedDir(cwd))) return { ok: false, error: `"${name}" is a shipped/user skill and cannot be edited by the agent` };
  let raw: string;
  try { raw = readFileSync(skill.path, "utf8"); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const { meta, body } = parseFrontmatter(raw);
  const count = body.split(oldString).length - 1;
  if (count === 0) return { ok: false, error: "old_string not found in the skill body" };
  if (count > 1) return { ok: false, error: `old_string is ambiguous (${count} matches) — add surrounding context` };
  const newBody = body.replace(oldString, () => newString);
  try {
    writeFileSync(skill.path, renderSkillFile({ name: meta.name || name, description: meta.description || skill.description, origin: "agent", state: (meta.state as SkillState) || "active", created: meta.created || nowIso(), updated: nowIso() }, newBody));
  } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true, path: skill.path, created: false };
}

/** Delete a LEARNED skill. Refuses to touch shipped/user skills (provenance + path guard). */
export function deleteSkill(cwd: string, name: string): WriteSkillResult | WriteSkillError {
  const skill = findSkill(cwd, name);
  if (!skill) return { ok: false, error: `unknown skill: ${name}` };
  if (skill.origin !== "agent" || !skill.path.startsWith(learnedDir(cwd))) return { ok: false, error: `"${name}" is a shipped/user skill and cannot be deleted by the agent` };
  try { unlinkSync(skill.path); } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true, path: skill.path, created: false };
}

/** Set a learned skill's lifecycle state (curator). No-op-safe for missing/protected skills. Preserves
 *  `updated` — a state transition is metadata, NOT a content edit, so it must not reset the staleness
 *  clock (otherwise marking a skill stale would make it look freshly-touched and it could never age). */
export function setSkillState(cwd: string, name: string, state: SkillState): boolean {
  const skill = findSkill(cwd, name);
  if (!skill || skill.origin !== "agent" || !skill.path.startsWith(learnedDir(cwd))) return false;
  try {
    const { meta, body } = parseFrontmatter(readFileSync(skill.path, "utf8"));
    writeFileSync(skill.path, renderSkillFile({ name: meta.name || name, description: meta.description || skill.description, origin: "agent", state, created: meta.created || nowIso(), updated: meta.updated || meta.created || nowIso() }, body));
    return true;
  } catch { return false; }
}
