// Deterministic test for the ask_user clarification tool (no API key / no UI). Verifies the tool is
// registered only when an askUser callback is wired, that it shuttles a normalized request to the UI
// and returns the answer, tolerates string options + multi_select, and no-ops gracefully on bad input.
// Usage: bun run scripts/ask-smoke.ts
import { buildTools, normalizeToolOutput, type AskUserRequest, type ToolOutput } from "../src/agent/tools.ts";

/** ask_user always returns text — unwrap the ToolOutput union for the string assertions below. */
const text = (o: ToolOutput) => normalizeToolOutput(o).text;

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// buildTools only touches cfg/store inside run closures, so plain stubs suffice for these tool defs.
const cfg = { cwd: process.cwd() } as any;
const store = {} as any;

// 1. Registered + wired when an askUser callback is provided. The request is a GROUP of questions.
let received: AskUserRequest | null = null;
const tools = buildTools(cfg, store, async (req) => { received = req; return "The user answered: Postgres"; });
check("ask_user registered when an askUser callback is provided", tools.has("ask_user"));
const ask = tools.get("ask_user")!;
check("ask_user is read-only (no approval gate, allowed in Plan mode)", ask.mutating === false);

const r1 = await ask.run({ questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "MySQL", description: "popular" }] }] });
const got = received as AskUserRequest | null; // assigned inside the callback — cast past TS's null-narrowing
const q0 = got?.questions[0];
check("ask_user passes a normalized question group to the UI", !!q0 && got!.questions.length === 1 && q0.question === "Which database?" && q0.header === "DB" && q0.options.length === 2 && q0.options[1].description === "popular");
check("ask_user defaults a question to single-select (multiSelect=false)", !!q0 && q0.multiSelect === false);
check("ask_user returns the UI's answer verbatim", r1 === "The user answered: Postgres");

// 2. A batch of multiple questions passes through (agent may ask several at once).
let rcv2: AskUserRequest | null = null;
const t2b = buildTools(cfg, store, async (req) => { rcv2 = req; return "ok"; });
await t2b.get("ask_user")!.run({ questions: [
  { question: "DB?", options: ["Postgres", "MySQL"] },
  { question: "ORM?", options: [{ label: "Prisma" }], multi_select: true },
] });
const g2 = rcv2 as AskUserRequest | null;
check("ask_user supports a group of multiple questions", !!g2 && g2.questions.length === 2 && g2.questions[1].question === "ORM?" && g2.questions[1].multiSelect === true);

// 3. Tolerates string options, a single top-level question (no `questions` wrapper), trims + clamps.
const t2 = buildTools(cfg, store, async (req) => `n=${req.questions[0].options.length} multi=${req.questions[0].multiSelect} first=${req.questions[0].options[0].label}`);
const r2 = await t2.get("ask_user")!.run({ question: "Pick", options: ["  Alpha  ", "Beta", "Gamma"], multi_select: true });
check("ask_user accepts a top-level single question, string options, trims, honors multi_select", r2 === "n=3 multi=true first=Alpha");
const many = Array.from({ length: 10 }, (_, i) => ({ label: `o${i}` }));
const r3 = await t2.get("ask_user")!.run({ questions: [{ question: "Many", options: many }] });
check("ask_user caps each option list at 6", r3 === "n=6 multi=false first=o0");
// caps the question group at 4
const manyQ = Array.from({ length: 7 }, (_, i) => ({ question: `q${i}`, options: [{ label: "a" }] }));
let rcv4: AskUserRequest | null = null;
const t4q = buildTools(cfg, store, async (req) => { rcv4 = req; return "ok"; });
await t4q.get("ask_user")!.run({ questions: manyQ });
check("ask_user caps the question group at 4", (rcv4 as AskUserRequest | null)?.questions.length === 4);

// 4. Graceful no-op on missing questions/options (never throws, never calls the UI).
let called = false;
const t3 = buildTools(cfg, store, async () => { called = true; return "x"; });
const r4 = text(await t3.get("ask_user")!.run({ questions: [{ question: "", options: [{ label: "A" }] }] }));
check("ask_user no-ops when a question has no text (does not prompt)", r4.includes("proceeding without asking") && !called);
const r5 = text(await t3.get("ask_user")!.run({ questions: [{ question: "Q", options: [] }] }));
check("ask_user no-ops when a question has no options (does not prompt)", r5.includes("proceeding without asking") && !called);
const r6 = text(await t3.get("ask_user")!.run({ questions: [] }));
check("ask_user no-ops with an empty group (does not prompt)", r6.includes("proceeding without asking") && !called);

// 4. Absent entirely when no askUser callback is wired (e.g. a host without an interactive UI).
const t4 = buildTools(cfg, store);
check("ask_user absent without an askUser callback", !t4.has("ask_user"));

if (fail) { console.error("\n✗ ask smoke FAILED"); process.exit(1); }
console.log("\n✓ ask_user smoke passed (registration + request normalization + multi/clamp + graceful no-op)");
process.exit(0);
