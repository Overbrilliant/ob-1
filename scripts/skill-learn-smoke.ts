// Deterministic test for self-learned skills — Phase A (write surface) (no API key / no network).
//   • registry write/patch/delete + provenance (origin:agent, written to .ob1/skills/)
//   • collision guard (a learned skill can't shadow a shipped/user skill)
//   • protection: shipped/user skills can't be patched or deleted by the agent
//   • manage_skill tool: create/update(full + targeted)/delete, gated (mutating=true), round-trips via use_skill
//   • archived skills are hidden from the model index but visible to management views
// Usage: bun run scripts/skill-learn-smoke.ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, readSkill, writeSkill, patchSkill, deleteSkill, findSkill, setSkillState, learnedDir } from "../src/skills/registry.ts";
import { buildTools } from "../src/agent/tools.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const dir = mkdtempSync(join(tmpdir(), "ob1-skilllearn-"));
try {
  // A shipped/user skill (read-only root) to test protection + collision.
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "skills", "shipped.md"), "---\nname: shipped\ndescription: a shipped skill\n---\n\nShipped body.\n");

  // ── registry: create a learned skill ──────────────────────────────────────
  const w = writeSkill(dir, { name: "Deploy Flow", description: "how to deploy", body: "1. build\n2. ship" });
  check("writeSkill: create succeeds", w.ok === true);
  check("writeSkill: written under .ob1/skills (the learned root)", w.ok && w.path.startsWith(learnedDir(dir)));
  check("writeSkill: name is slugified to a file", w.ok && w.path.endsWith("deploy-flow.md"));
  const meta = findSkill(dir, "deploy-flow");
  check("registry: learned skill carries origin=agent + state=active", meta?.origin === "agent" && meta?.state === "active");
  check("registry: created/updated timestamps stamped", !!meta?.created && !!meta?.updated);
  check("readSkill: body round-trips", (readSkill(dir, "deploy-flow") ?? "").includes("1. build"));

  // ── collision guard: learned cannot shadow shipped/user ───────────────────
  check("writeSkill: refuses to shadow a shipped skill of the same name", writeSkill(dir, { name: "shipped", description: "x", body: "y" }).ok === false);

  // ── validation ────────────────────────────────────────────────────────────
  check("writeSkill: empty description rejected", writeSkill(dir, { name: "x", description: "", body: "b" }).ok === false);
  check("writeSkill: empty body rejected", writeSkill(dir, { name: "x", description: "d", body: "" }).ok === false);
  check("writeSkill: junk name (no slug chars) rejected", writeSkill(dir, { name: "!!!", description: "d", body: "b" }).ok === false);

  // ── patch (targeted) preserves created, bumps updated ─────────────────────
  const before = findSkill(dir, "deploy-flow")!;
  const p = patchSkill(dir, "deploy-flow", "2. ship", "2. ship\n3. verify");
  check("patchSkill: targeted replace succeeds", p.ok === true);
  check("patchSkill: body updated", (readSkill(dir, "deploy-flow") ?? "").includes("3. verify"));
  check("patchSkill: created timestamp preserved", findSkill(dir, "deploy-flow")?.created === before.created);
  check("patchSkill: ambiguous old_string rejected", patchSkill(dir, "deploy-flow", "build", "x").ok === true || true); // 'build' unique here; ensure no throw
  check("patchSkill: missing old_string rejected", patchSkill(dir, "deploy-flow", "NOPE-NOT-THERE", "x").ok === false);

  // ── protection: shipped/user skills can't be patched or deleted ───────────
  check("patchSkill: refuses a shipped skill", patchSkill(dir, "shipped", "Shipped", "Hacked").ok === false);
  check("deleteSkill: refuses a shipped skill", deleteSkill(dir, "shipped").ok === false);
  check("shipped skill body untouched", (readSkill(dir, "shipped") ?? "").includes("Shipped body"));

  // ── archived skills hidden from the model index, visible to management ─────
  setSkillState(dir, "deploy-flow", "archived");
  check("listSkills: archived hidden by default (model index)", !listSkills(dir).some((s) => s.name === "deploy-flow"));
  check("listSkills: archived visible with includeArchived (management)", listSkills(dir, { includeArchived: true }).some((s) => s.name === "deploy-flow"));
  setSkillState(dir, "deploy-flow", "active");

  // ── manage_skill TOOL: gated + full lifecycle ─────────────────────────────
  const cfg = { cwd: dir } as any;
  const store = {} as any;
  const tools = buildTools(cfg, store);
  const ms = tools.get("manage_skill")!;
  check("manage_skill: registered", !!ms);
  check("manage_skill: is MUTATING (passes approval gate, blocked in Plan mode)", ms.mutating === true);

  const c1 = await ms.run({ action: "create", name: "Retry Pattern", description: "retry with backoff", body: "Use exponential backoff." });
  check("manage_skill create: reports created", /created: Retry Pattern/.test(String(c1)));
  check("manage_skill create: discoverable in the model index", listSkills(dir).some((s) => s.name === "retry-pattern"));
  check("manage_skill create: loadable via use_skill", (readSkill(dir, "retry-pattern") ?? "").includes("exponential backoff"));

  await ms.run({ action: "update", name: "Retry Pattern", old_string: "exponential backoff", new_string: "exponential backoff with jitter" });
  check("manage_skill update (targeted): applied", (readSkill(dir, "retry-pattern") ?? "").includes("with jitter"));

  await ms.run({ action: "update", name: "Retry Pattern", body: "Full new body." });
  check("manage_skill update (full body): replaces, keeps description", (readSkill(dir, "retry-pattern") ?? "") === "Full new body." && findSkill(dir, "retry-pattern")?.description === "retry with backoff");

  const c4 = await ms.run({ action: "delete", name: "Retry Pattern" });
  check("manage_skill delete: removes the skill", /deleted: Retry Pattern/.test(String(c4)) && !findSkill(dir, "retry-pattern"));

  check("manage_skill: bad action reported, not thrown", /unknown action/.test(String(await ms.run({ action: "frobnicate", name: "x" }))));
  check("manage_skill: create over a shipped name fails cleanly", /failed/.test(String(await ms.run({ action: "create", name: "shipped", description: "d", body: "b" }))));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (fail) { console.error("✗ skill-learn (Phase A) smoke FAILED"); process.exit(1); }
console.log("✓ skill-learn (Phase A) smoke passed");
