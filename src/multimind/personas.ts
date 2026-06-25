// Personas mode (Phase 6) — a goal-driven expert panel that holds a DIALOGUE, then a facilitator
// writes one comprehensive solution (R6 MetaGPT-made-dynamic + plan Diagram 7).
//
// 1. A **Persona Former** reads the user's goal and casts a small panel of named experts tailored to
//    THAT goal — each with a name, title, and one-line bio. It picks as many as the goal warrants
//    (1–6); a single-expert cast collapses to a direct Solo solve so simple work isn't over-staffed
//    (the R5/R6 honesty caveat: rigid role pipelines over-engineer simple tasks).
// 2. The panel holds a **dialogue**: personas speak in turn, round-robin, each reading the whole
//    conversation so far and building on / pushing back against it. The discussion runs for `rounds`
//    passes — a real back-and-forth rather than parallel monologues.
// 3. The **facilitator** (the first-cast persona) reads the full dialogue and writes the single
//    comprehensive, complete final solution.
//
// Personas run as isolated read-only workers on the Phase 3 runtime; the main agent applies any
// resulting changes through the normal approval gate.
import { runWorker, readOnlyTools, type WorkerResult, type WorkerEvent } from "./runtime.ts";
import type { Config } from "../config.ts";
import type { Tool } from "../agent/tools.ts";

export interface Persona { name: string; title: string; bio: string }
export interface DialogueTurn { persona: string; round: number; text: string }
export interface PersonasResult {
  personas: Persona[];
  collapsed: boolean;     // Former cast a single expert ⇒ ran as Solo
  rounds: number;         // dialogue rounds actually run
  dialogue: Dialogue;
  final: string;          // facilitator synthesis (or the sole persona's answer when collapsed)
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** The panel's conversation — an ordered transcript of who said what, in which round. */
export class Dialogue {
  turns: DialogueTurn[] = [];
  add(persona: string, round: number, text: string): void { this.turns.push({ persona, round, text }); }
  /** Render the conversation as markdown; optionally only the first `count` turns. */
  render(count?: number): string {
    const ts = count == null ? this.turns : this.turns.slice(0, count);
    if (!ts.length) return "(the discussion has not started yet)";
    return ts.map((t) => `**${t.persona}** (round ${t.round}):\n${t.text.trim() || "(no comment)"}`).join("\n\n");
  }
}

/** Used only when the Former's output can't be parsed at all. */
export const DEFAULT_PERSONAS: Persona[] = [
  { name: "Mara", title: "Software Architect", bio: "Designs the overall structure and how the pieces fit together." },
  { name: "Devin", title: "Security Auditor", bio: "Hunts for vulnerabilities, unsafe operations, and data-safety gaps." },
  { name: "Sol", title: "Skeptic", bio: "Surfaces hidden assumptions, failure modes, and what's being overlooked." },
];

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "persona";

/** Parse the Former's JSON persona array. Tolerant: finds the first array, validates entries,
 *  clamps names/count. Returns [] when nothing usable is found (caller falls back to a default). */
export function parsePersonas(text: string, max = 6): Persona[] {
  const m = /\[\s*\{[\s\S]*\}\s*\]/.exec(text);
  if (!m) return [];
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: Persona[] = [];
  for (const x of arr) {
    const name = x && typeof (x as any).name === "string" ? (x as any).name.trim().slice(0, 40) : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      title: typeof (x as any).title === "string" ? (x as any).title.trim().slice(0, 60) : "",
      bio: typeof (x as any).bio === "string" ? (x as any).bio.trim() : "",
    });
    if (out.length >= max) break;
  }
  return out;
}

/** "Mara, Software Architect" — used in dialogue headers and progress labels. */
const tag = (p: Persona): string => (p.title ? `${p.name}, ${p.title}` : p.name);

export async function runPersonas(opts: {
  task: string;           // the user's goal
  cfg: Config;
  tools: Map<string, Tool>;
  rounds?: number;        // dialogue passes over the panel (default 2)
  max?: number;           // cap on panel size (default 6)
  /** Live per-worker progress (former / panelists / facilitator) for the UI. */
  onEvent?: (ev: WorkerEvent) => void;
  /** External cancellation (ESC) — propagated to every worker. */
  signal?: AbortSignal;
  /** Injectable for deterministic tests; defaults to the real isolated-worker runner. */
  _run?: typeof runWorker;
}): Promise<PersonasResult> {
  const baseRun = opts._run ?? runWorker;
  const run: typeof runWorker = (o) => baseRun({ ...o, onEvent: opts.onEvent, signal: opts.signal });
  const roTools = readOnlyTools(opts.tools);
  const max = Math.max(1, opts.max ?? 6);
  const rounds = Math.max(1, opts.rounds ?? 2);
  const dialogue = new Dialogue();
  let inTok = 0, outTok = 0;
  const tally = (r: WorkerResult) => { inTok += r.inputTokens; outTok += r.outputTokens; };

  // 1. Persona Former — cast the panel this goal needs (possibly just one), each with name/title/bio.
  const former = await run({
    label: "former",
    task: `Goal:\n${opts.task}\n\nCast the expert panel that should discuss how to achieve this goal (at most ${max} people). Output the JSON array only.`,
    system:
      "You are OB-1 Personas' Former. Read the user's goal and cast a small panel of distinct experts who will " +
      "discuss how to achieve it — give each a human first name, a fitting job title (e.g. Software Architect, " +
      "Security Auditor, Performance Engineer, API Designer, Test Engineer, Domain Expert, or a standing Skeptic), " +
      "and a one-sentence bio describing the perspective they bring. List the most integrative facilitator FIRST. " +
      "IMPORTANT: cast only as many people as the goal truly warrants — for a simple goal cast exactly ONE expert " +
      "(the panel then collapses to a single solver). " +
      'Output ONLY a JSON array of {"name": string, "title": string, "bio": one-sentence string}, no prose.',
    cfg: opts.cfg,
    tools: roTools,
  });
  tally(former);
  let personas = parsePersonas(former.text, max);
  if (!personas.length) personas = DEFAULT_PERSONAS;

  // Collapse-to-Solo: a one-expert panel just solves it directly (honest caveat) — no dialogue/facilitator.
  if (personas.length === 1) {
    const p = personas[0];
    const only = await run({
      label: `persona:${slug(p.name)}`,
      task:
        `Goal:\n${opts.task}\n\nYou are the only expert this goal needs. Produce the complete solution directly — ` +
        "full file content in a single fenced code block if a file is targeted — plus a one-line rationale. No preamble.",
      system: `You are ${tag(p)}. ${p.bio} Investigate with the read-only tools as needed.`,
      cfg: opts.cfg,
      tools: roTools,
      // not streamed — personasTurn prints this answer once (streaming would duplicate it)
    });
    tally(only);
    dialogue.add(p.name, 1, only.text);
    return { personas, collapsed: true, rounds: 1, dialogue, final: only.text, totalInputTokens: inTok, totalOutputTokens: outTok };
  }

  // 2. The dialogue: personas speak in turn (round-robin), each reading the conversation so far.
  //    Sequential — this is a real back-and-forth, not parallel monologues.
  const panel = personas.map((p) => tag(p)).join(", ");
  for (let r = 1; r <= rounds; r++) {
    for (const p of personas) {
      const opening = dialogue.turns.length === 0;
      const convo = dialogue.render();
      const turn = await run({
        label: rounds > 1 ? `persona:${slug(p.name)}:r${r}` : `persona:${slug(p.name)}`,
        task: opening
          ? `Goal:\n${opts.task}\n\nYou are opening the panel's discussion. Propose how the panel should approach ` +
            "achieving this goal: the core approach, the key decisions to resolve, and the first concrete steps. " +
            "Be terse and concrete; cite files where relevant."
          : `Goal:\n${opts.task}\n\nThe discussion so far:\n\n${convo}\n\nIt's your turn to speak. Add your expert ` +
            "view: build on the strongest points, push back on anything weak, and resolve the open questions you " +
            "can. Don't repeat what's already settled. Be terse and concrete; cite files where relevant.",
        system:
          `You are ${tag(p)}, one member of OB-1's expert panel: ${panel}. ${p.bio} Speak in the first person and ` +
          "briefly, as in a real working discussion — move the group toward the best concrete solution and trust " +
          "the others for their specialties. Ground claims by investigating with the read-only tools rather than guessing.",
        cfg: opts.cfg,
        tools: roTools,
        stream: true, // the dialogue is the visible work → stream each turn live
      });
      tally(turn);
      dialogue.add(p.name, r, turn.text);
    }
  }

  // 3. Facilitator synthesis: the first-cast persona turns the whole discussion into one final answer.
  const facilitator = personas[0];
  const synth = await run({
    label: "facilitator",
    task:
      `Goal:\n${opts.task}\n\nThe panel's full discussion:\n\n${dialogue.render()}\n\n` +
      `Acting as facilitator (${tag(facilitator)}), synthesize the discussion into ONE comprehensive, complete ` +
      "final solution that achieves the goal: combine the strongest ideas, reconcile disagreements, and resolve the " +
      "open questions the discussion supports. " +
      "If the goal asks for a file or code, your answer MUST BEGIN with the COMPLETE file content in a single fenced " +
      "code block (e.g. ```html … ```) — the whole file ready to save, not a sketch, outline, or description — and you " +
      "MUST close the ``` fence. Put any short rationale or remaining caveats AFTER the closing fence (never before the " +
      "code, never inside it). Do not delegate the writing ('someone should output the file') — you ARE the output. " +
      "Invent nothing the discussion doesn't support.",
    system:
      `You are the facilitator of OB-1's expert panel (${tag(facilitator)}). Turn the durable discussion into the ` +
      "single best, complete answer; prefer ideas the panel converged on, and never claim something the discussion doesn't support.",
    cfg: opts.cfg,
    tools: new Map(),
    // not streamed — personasTurn prints the final synthesis once (streaming would duplicate it)
  });
  tally(synth);

  return { personas, collapsed: false, rounds, dialogue, final: synth.text, totalInputTokens: inTok, totalOutputTokens: outTok };
}
