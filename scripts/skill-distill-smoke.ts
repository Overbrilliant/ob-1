// Deterministic test for automatic skill learning — Phase B (no API key: the brain is a stub).
//   • countToolCalls / substance gate (trivial turns are skipped)
//   • parseLearnDecision tolerates code fences + surrounding prose; rejects junk
//   • maybeLearnSkill: create + refine(update) via a stubbed brain, written to .ob1/skills
//   • guardrails: skip when the turn already called manage_skill; skip on "none"/incomplete; never throws
//   • collision protection still applies (won't overwrite a shipped/user skill)
// Usage: bun run scripts/skill-distill-smoke.ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../src/providers/types.ts";
import { countToolCalls, parseLearnDecision, buildLearnPrompt, maybeLearnSkill } from "../src/skills/learn.ts";
import { listSkills, readSkill, findSkill } from "../src/skills/registry.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// A transcript slice with 2 tool calls (substantive) — read_file + run_bash.
const work: Message[] = [
  { role: "user", content: "set up retries" },
  { role: "assistant", content: [{ type: "text", text: "I'll add backoff." }, { type: "tool_use", name: "read_file", input: { path: "a.ts" } }] as any },
  { role: "user", content: [{ type: "tool_result", content: "file body" }] as any },
  { role: "assistant", content: [{ type: "tool_use", name: "run_bash", input: { command: "bun test" } }] as any },
  { role: "user", content: [{ type: "tool_result", content: "exit 0" }] as any },
  { role: "assistant", content: "Done — added exponential backoff with jitter." },
];
const trivial: Message[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];

// ── pure helpers ────────────────────────────────────────────────────────────
check("countToolCalls: counts tool_use blocks", countToolCalls(work) === 2 && countToolCalls(trivial) === 0);
check("buildLearnPrompt: includes existing skills + transcript", (() => { const p = buildLearnPrompt(work, []); return p.includes("Existing skills:") && p.includes("run_bash"); })());

check("parseLearnDecision: plain JSON", parseLearnDecision('{"action":"none"}')?.action === "none");
check("parseLearnDecision: fenced + prose", (() => { const d = parseLearnDecision('Sure!\n```json\n{"action":"create","name":"x","description":"d","body":"b"}\n```'); return d?.action === "create" && d?.name === "x"; })());
check("parseLearnDecision: junk → null", parseLearnDecision("no json here") === null);
check("parseLearnDecision: bad action → null", parseLearnDecision('{"action":"frobnicate"}') === null);

const dir = mkdtempSync(join(tmpdir(), "ob1-distill-"));
try {
  // A shipped skill to test collision protection during auto-learn.
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "skills", "shipped.md"), "---\nname: shipped\ndescription: shipped\n---\n\nShipped.\n");

  // ── substance gate ──────────────────────────────────────────────────────
  const askNever = async () => { throw new Error("brain should not be called for a trivial turn"); };
  const t1 = await maybeLearnSkill({ cwd: dir, slice: trivial, existing: [], ask: askNever });
  check("maybeLearnSkill: trivial turn skipped (brain not called)", t1.action === "none");

  // ── skip when the turn already managed a skill ──────────────────────────
  const managed: Message[] = [...work, { role: "assistant", content: [{ type: "tool_use", name: "manage_skill", input: { action: "create", name: "x" } }] as any }];
  const t2 = await maybeLearnSkill({ cwd: dir, slice: managed, existing: [], ask: askNever });
  check("maybeLearnSkill: skipped when turn already called manage_skill", t2.action === "none");

  // ── create via stubbed brain ────────────────────────────────────────────
  const askCreate = async () => '{"action":"create","name":"Retry With Backoff","description":"add retries with exponential backoff","body":"## When\\nFlaky network calls.\\n## Steps\\n1. wrap in retry\\n2. exponential backoff + jitter","reason":"task taught a general method"}';
  const c1 = await maybeLearnSkill({ cwd: dir, slice: work, existing: [], ask: askCreate });
  check("maybeLearnSkill: create returns action=create + name", c1.action === "create" && c1.name === "Retry With Backoff");
  check("maybeLearnSkill: skill written + discoverable", listSkills(dir).some((s) => s.name === "retry-with-backoff"));
  check("maybeLearnSkill: learned skill carries origin=agent", findSkill(dir, "retry-with-backoff")?.origin === "agent");
  check("maybeLearnSkill: body loadable via registry", (readSkill(dir, "retry-with-backoff") ?? "").includes("exponential backoff"));

  // ── refine(update) an existing learned skill (writeSkill overwrites; reports update) ──
  const askUpdate = async () => '{"action":"update","name":"retry-with-backoff","description":"add retries with exponential backoff","body":"## When\\nFlaky calls.\\n## Steps\\n1. retry\\n2. backoff+jitter\\n3. cap attempts","reason":"added a cap"}';
  const c2 = await maybeLearnSkill({ cwd: dir, slice: work, existing: listSkills(dir), ask: askUpdate });
  check("maybeLearnSkill: refine returns action=update", c2.action === "update" && c2.name === "retry-with-backoff");
  check("maybeLearnSkill: refined body applied", (readSkill(dir, "retry-with-backoff") ?? "").includes("cap attempts"));

  // ── none / incomplete / collision are all safe no-ops ───────────────────
  check("maybeLearnSkill: action=none is a no-op", (await maybeLearnSkill({ cwd: dir, slice: work, existing: [], ask: async () => '{"action":"none","reason":"nothing general"}' })).action === "none");
  check("maybeLearnSkill: incomplete create skipped", (await maybeLearnSkill({ cwd: dir, slice: work, existing: [], ask: async () => '{"action":"create","name":"x"}' })).action === "none");
  check("maybeLearnSkill: won't overwrite a shipped skill", (await maybeLearnSkill({ cwd: dir, slice: work, existing: [], ask: async () => '{"action":"create","name":"shipped","description":"d","body":"b"}' })).action === "none");
  check("maybeLearnSkill: brain error is swallowed (no throw)", (await maybeLearnSkill({ cwd: dir, slice: work, existing: [], ask: async () => { throw new Error("boom"); } })).action === "none");
  check("maybeLearnSkill: unparseable reply → none", (await maybeLearnSkill({ cwd: dir, slice: work, existing: [], ask: async () => "I think no." })).action === "none");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (fail) { console.error("✗ skill-distill (Phase B) smoke FAILED"); process.exit(1); }
console.log("✓ skill-distill (Phase B) smoke passed");
