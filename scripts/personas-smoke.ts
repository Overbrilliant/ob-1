// Deterministic test for Personas (no API key needed). Verifies persona parsing (name/title/bio),
// the dialogue transcript, and the full former→dialogue→facilitator flow via an injected fake
// runner — including the collapse-to-Solo path and that every turn reads the conversation so far.
// Usage: bun run scripts/personas-smoke.ts
import { parsePersonas, Dialogue, runPersonas, DEFAULT_PERSONAS } from "../src/multimind/personas.ts";
import type { WorkerResult } from "../src/multimind/runtime.ts";
import { loadConfig } from "../src/config.ts";

const cfg = loadConfig();
let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

// --- parsePersonas ---
const two = parsePersonas('[{"name":"Mara","title":"Architect","bio":"design"},{"name":"Sol","title":"Skeptic","bio":"doubt"}]');
check("parse: two personas (name/title/bio)", two.length === 2 && two[0].name === "Mara" && two[0].title === "Architect" && two[1].bio === "doubt");
check("parse: embedded in prose/fence", parsePersonas('Here:\n```json\n[{"name":"Devin","title":"Security Auditor","bio":"safety"}]\n```').length === 1);
check("parse: malformed ⇒ empty", parsePersonas("[{name: Mara}]").length === 0);
check("parse: no array ⇒ empty", parsePersonas("no personas here").length === 0);
check("parse: missing title/bio tolerated", (() => { const p = parsePersonas('[{"name":"Lee"}]'); return p.length === 1 && p[0].title === "" && p[0].bio === ""; })());
const many = parsePersonas(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ name: `R${i}`, title: "t", bio: "b" }))), 3);
check("parse: clamps to max", many.length === 3);
check("parse: default max is 6", parsePersonas(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ name: `R${i}`, title: "t", bio: "b" })))).length === 6);
check("parse: dedups by name", parsePersonas('[{"name":"Arch","title":"a","bio":"a"},{"name":"arch","title":"b","bio":"b"}]').length === 1);
check("parse: clamps long name", parsePersonas('[{"name":"' + "x".repeat(80) + '","title":"t","bio":"b"}]')[0].name.length === 40);

// --- Dialogue transcript ---
const d = new Dialogue();
check("dialogue: empty render", d.render().startsWith("(the discussion"));
d.add("Mara", 1, "open with A");
d.add("Sol", 1, "doubt D");
d.add("Mara", 2, "refine A");
check("dialogue: render groups turns", d.render().includes("**Mara** (round 1):") && d.render().includes("open with A"));
check("dialogue: render(count) slices", d.render(2).includes("doubt D") && !d.render(2).includes("refine A"));

/** Fake runner scripted by label; records every call's task so we can assert dialogue-awareness. */
function fakeRunner(formerOut: string) {
  const calls: Array<{ label: string; task: string }> = [];
  const run = async (o: { label: string; task: string }): Promise<WorkerResult> => {
    calls.push({ label: o.label, task: o.task });
    const base = { label: o.label, inputTokens: 2, outputTokens: 3, ok: true };
    if (o.label === "former") return { ...base, text: formerOut };
    if (o.label === "facilitator") return { ...base, text: "FACILITATOR SYNTHESIS FINAL\n```ts\nok\n```" };
    if (o.label.startsWith("persona:")) return { ...base, text: `said-by:${o.label}` };
    return { ...base, text: "?" };
  };
  return { run, calls };
}

// --- Scenario A: 3 personas, 2 rounds → 6 dialogue turns, later turns see the convo, facilitator finalizes ---
const fA = fakeRunner('[{"name":"Mara","title":"Architect","bio":"design"},{"name":"Devin","title":"Security Auditor","bio":"safety"},{"name":"Sol","title":"Skeptic","bio":"doubt"}]');
const a = await runPersonas({ task: "design a thing", cfg, tools: new Map(), rounds: 2, _run: fA.run as any });
check("A: 3 personas, not collapsed", a.personas.length === 3 && a.collapsed === false);
check("A: dialogue has 6 turns (3×2)", a.dialogue.turns.length === 6);
check("A: facilitator finalized", a.final.includes("FACILITATOR SYNTHESIS FINAL") && fA.calls.some((c) => c.label === "facilitator"));
const secR2 = fA.calls.find((c) => c.label === "persona:devin:r2");
check("A: round-2 speaker saw the conversation", !!secR2 && secR2.task.includes("said-by:persona:mara:r1"));
const maraR1 = fA.calls.find((c) => c.label === "persona:mara:r1");
check("A: first speaker opens (no transcript yet)", !!maraR1 && maraR1.task.includes("opening the panel's discussion"));
check("A: facilitator is first-cast persona", a.personas[0].name === "Mara");
check("A: token accounting", a.totalInputTokens > 0 && a.totalOutputTokens > 0);

// --- Scenario B: Former casts ONE → collapses to Solo (no dialogue rounds, no facilitator) ---
const fB = fakeRunner('[{"name":"Fixer","title":"Bug Fixer","bio":"fix the typo"}]');
const b = await runPersonas({ task: "fix a typo", cfg, tools: new Map(), rounds: 2, _run: fB.run as any });
check("B: collapsed to solo", b.collapsed === true && b.personas.length === 1);
check("B: single turn, no facilitator", b.dialogue.turns.length === 1 && !fB.calls.some((c) => c.label === "facilitator"));
check("B: final is the sole persona's answer", b.final.startsWith("said-by:persona:fixer"));

// --- Scenario C: garbage Former output ⇒ falls back to the default panel ---
const fC = fakeRunner("sorry, I cannot do JSON today");
const cRes = await runPersonas({ task: "review architecture", cfg, tools: new Map(), rounds: 2, _run: fC.run as any });
check("C: fallback to default panel", cRes.personas.length === DEFAULT_PERSONAS.length && cRes.collapsed === false);
check("C: default panel ran the dialogue", cRes.personas[0].name === DEFAULT_PERSONAS[0].name && cRes.dialogue.turns.length === DEFAULT_PERSONAS.length * 2);

if (fail) { console.error("\n✗ personas smoke FAILED"); process.exit(1); }
console.log("\n✓ personas smoke passed (parse name/title/bio + dialogue transcript + former→dialogue→facilitator, collapse-to-solo, dialogue-awareness)");
