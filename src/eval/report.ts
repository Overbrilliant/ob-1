// Eval report rendering (Phase 7). Plain text (no ANSI) so it reads the same in the REPL, in a
// script, or piped to a file. The verdict column is the whole point: ✓ only when a mode beats the
// compute-matched Solo baseline.
import type { EvalReport, ModeStats, CapabilityReport, CapabilityStats } from "./harness.ts";

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const pad = (s: string, w: number) => s.padEnd(w);
const padL = (s: string, w: number) => s.padStart(w);

function verdict(m: ModeStats): string {
  if (m.isBaseline) return "baseline (1×)";
  if (m.justified) return `✓ beats solo@k  (+${(m.delta * 100).toFixed(0)} pts)`;
  return `✗ not justified (${(m.delta * 100).toFixed(0)} pts)`;
}

export function renderReport(r: EvalReport): string {
  const cols = [
    { h: "mode", w: 10, get: (m: ModeStats) => pad(m.mode, 10) },
    { h: "pass", w: 6, get: (m: ModeStats) => padL(pct(m.passRate), 6) },
    { h: "avg tok", w: 9, get: (m: ModeStats) => padL(Math.round(m.avgTokens).toString(), 9) },
    { h: "k×", w: 6, get: (m: ModeStats) => padL(m.isBaseline ? "1.0" : m.k.toFixed(1), 6) },
    { h: "solo@k", w: 8, get: (m: ModeStats) => padL(m.isBaseline ? "—" : pct(m.soloAtK), 8) },
    { h: "verdict", w: 0, get: (m: ModeStats) => verdict(m) },
  ];
  const header = cols.map((c) => (c.w ? (c.h === "mode" ? pad(c.h, c.w) : padL(c.h, c.w)) : c.h)).join("  ");
  const rows = r.modes.map((m) => cols.map((c) => c.get(m)).join("  "));
  const justified = r.modes.filter((m) => m.justified).map((m) => m.mode);
  const summary = justified.length
    ? `At equal tokens, ${justified.join(", ")} beat Solo on this suite. Others default to Solo.`
    : "No mode beat Solo at equal tokens on this suite — default to Solo (R5).";

  return [
    `Compute-matched eval — baseline: ${r.baseline} · ${r.tasks} task(s) · ${r.trials} trial(s)`,
    "─".repeat(Math.max(header.length, 64)),
    header,
    ...rows,
    "─".repeat(Math.max(header.length, 64)),
    `solo@k = expected Solo pass rate given the mode's token budget spent on repeated Solo tries (pass@k).`,
    summary,
  ].join("\n");
}

/** Capability/recovery report — the "solve where Solo fails" frame. Token cost is shown but is NOT a gate. */
export function renderCapability(r: CapabilityReport): string {
  const cols = [
    { h: "mode", w: 10, get: (m: CapabilityStats) => pad(m.mode, 10) },
    { h: "raw", w: 6, get: (m: CapabilityStats) => padL(pct(m.rawPass), 6) },
    { h: "hard", w: 6, get: (m: CapabilityStats) => padL(pct(m.hardPass), 6) },
    { h: "lift", w: 7, get: (m: CapabilityStats) => padL(m.isBaseline ? "—" : `${m.lift >= 0 ? "+" : ""}${(m.lift * 100).toFixed(0)}`, 7) },
    { h: "recovered", w: 11, get: (m: CapabilityStats) => padL(m.isBaseline ? "—" : `${m.solvedHard}/${m.totalHard}`, 11) },
    { h: "avg tok", w: 9, get: (m: CapabilityStats) => padL(Math.round(m.avgTokens).toString(), 9) },
  ];
  const header = cols.map((c) => (c.h === "mode" ? pad(c.h, c.w) : padL(c.h, c.w))).join("  ");
  const rows = r.modes.map((m) => cols.map((c) => c.get(m)).join("  "));
  const best = r.modes.filter((m) => !m.isBaseline && m.solvedHard > 0).sort((a, b) => b.hardPass - a.hardPass || b.solvedHard - a.solvedHard)[0];
  const summary = r.hardTasks === 0
    ? `No hard tasks on this suite (${r.baseline} solved everything) — nothing to recover; add harder tasks.`
    : best
      ? `Best recoverer: ${best.mode} — solves ${best.hardPass ? pct(best.hardPass) : "0%"} of the ${r.hardTasks} hard task(s) vs ${r.baseline}'s ${pct(r.modes.find((m) => m.isBaseline)!.hardPass)} (${best.solvedHard} recovered, ${best.fullyRecovered} that ${r.baseline} never solved).`
      : `No mode out-solved ${r.baseline} on the ${r.hardTasks} hard task(s).`;

  return [
    `Capability eval — does each mode SOLVE what ${r.baseline} fails? (token cost is NOT a gate)`,
    `baseline: ${r.baseline} · ${r.tasks} task(s) · ${r.hardTasks} hard · ${r.trials} trial(s)`,
    "─".repeat(Math.max(header.length, 64)),
    header,
    ...rows,
    "─".repeat(Math.max(header.length, 64)),
    `raw = pass% over all tasks · hard = pass% over tasks ${r.baseline} doesn't ace · lift = hard − ${r.baseline} · recovered = hard tasks beaten.`,
    summary,
  ].join("\n");
}
