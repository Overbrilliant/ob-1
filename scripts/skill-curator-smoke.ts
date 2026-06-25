// Deterministic test for skill usage telemetry + curator — Phase C (no API key / no network).
//   • recordSkillUse bumps the .usage.json sidecar + reactivates an aged skill on use
//   • use_skill tool records usage as a side effect
//   • runCurator ages learned skills active→stale→archived by inactivity (injected clock)
//   • recent activity (re)activates; shipped/user skills are NEVER aged (provenance gate)
// Usage: bun run scripts/skill-curator-smoke.ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSkill, findSkill, setSkillState } from "../src/skills/registry.ts";
import { recordSkillUse, readUsage, runCurator } from "../src/skills/usage.ts";
import { buildTools } from "../src/agent/tools.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

const dir = mkdtempSync(join(tmpdir(), "ob1-curator-"));
try {
  // A shipped/user skill (must never be aged), and a learned skill.
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "skills", "shipped.md"), "---\nname: shipped\ndescription: shipped\norigin: user\n---\n\nShipped.\n");
  writeSkill(dir, { name: "deploy-flow", description: "deploy", body: "steps" });

  const DAY = 86_400_000;
  const now = Date.parse("2026-06-22T00:00:00.000Z");

  // ── usage telemetry ───────────────────────────────────────────────────────
  check("readUsage: empty before any use", Object.keys(readUsage(dir)).length === 0);
  recordSkillUse(dir, "deploy-flow");
  recordSkillUse(dir, "deploy-flow");
  check("recordSkillUse: counts accumulate in the sidecar", readUsage(dir)["deploy-flow"]?.uses === 2);
  check("recordSkillUse: stamps lastUsed", !!readUsage(dir)["deploy-flow"]?.lastUsed);
  check("recordSkillUse: unknown skill is a safe no-op", (() => { recordSkillUse(dir, "nope"); return readUsage(dir)["nope"] === undefined; })());

  // use_skill tool records usage as a side effect
  const tools = buildTools({ cwd: dir } as any, {} as any);
  await tools.get("use_skill")!.run({ name: "deploy-flow" });
  check("use_skill: loading a skill bumps its usage", readUsage(dir)["deploy-flow"]?.uses === 3);

  // ── curator aging (injected clock) ────────────────────────────────────────
  // Backdate the skill (writeSkill stamps real-time created/updated) so it looks old, then run the
  // curator at several simulated times. Aging keys off max(created, updated, lastUsed).
  const skillFile = join(dir, ".ob1", "skills", "deploy-flow.md");
  const ageSkill = (stamp: string) => writeFileSync(skillFile, `---\nname: deploy-flow\ndescription: deploy\norigin: agent\nstate: active\ncreated: ${stamp}\nupdated: ${stamp}\n---\n\nsteps\n`);
  ageSkill("2026-01-01T00:00:00.000Z");
  writeFileSync(join(dir, ".ob1", "skills", ".usage.json"), JSON.stringify({ "deploy-flow": { uses: 3, lastUsed: "2026-01-01T00:00:00.000Z" } }));

  // 10 days after lastUsed → still active (under staleDays=30).
  let r = runCurator(dir, { staleDays: 30, archiveDays: 60, nowMs: Date.parse("2026-01-11T00:00:00.000Z") });
  check("curator: fresh skill stays active", findSkill(dir, "deploy-flow")?.state === "active" && r.staled.length === 0);

  // 40 days → stale.
  r = runCurator(dir, { staleDays: 30, archiveDays: 60, nowMs: Date.parse("2026-02-10T00:00:00.000Z") });
  check("curator: inactive ≥ staleDays → stale", findSkill(dir, "deploy-flow")?.state === "stale" && r.staled.includes("deploy-flow"));

  // 70 days → archived (and hidden from the model index).
  r = runCurator(dir, { staleDays: 30, archiveDays: 60, nowMs: Date.parse("2026-03-12T00:00:00.000Z") });
  check("curator: inactive ≥ archiveDays → archived", findSkill(dir, "deploy-flow")?.state === "archived" && r.archived.includes("deploy-flow"));

  // Used again → recordSkillUse reactivates immediately.
  recordSkillUse(dir, "deploy-flow");
  check("recordSkillUse: reactivates an archived skill on use", findSkill(dir, "deploy-flow")?.state === "active");

  // Curator also reactivates if activity is recent (archive an idle one, then 'use' resets the clock).
  setSkillState(dir, "deploy-flow", "stale");
  writeFileSync(join(dir, ".ob1", "skills", ".usage.json"), JSON.stringify({ "deploy-flow": { uses: 4, lastUsed: "2026-06-21T00:00:00.000Z" } }));
  r = runCurator(dir, { staleDays: 30, archiveDays: 60, nowMs: now });
  check("curator: recent activity reactivates a stale skill", findSkill(dir, "deploy-flow")?.state === "active" && r.reactivated.includes("deploy-flow"));

  // ── provenance gate: shipped/user skills are never aged ───────────────────
  r = runCurator(dir, { staleDays: 0, archiveDays: 0, nowMs: now });
  check("curator: shipped/user skill is never aged", findSkill(dir, "shipped")?.state === "active" && !r.archived.includes("shipped") && !r.staled.includes("shipped"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (fail) { console.error("✗ skill-curator (Phase C) smoke FAILED"); process.exit(1); }
console.log("✓ skill-curator (Phase C) smoke passed");
