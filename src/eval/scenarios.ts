import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QualityLedger } from "../agent/task-quality.ts";

export type ScenarioRequirement =
  | "read_before_edit"
  | "check_after_edit"
  | "browser_after_ui_edit"
  | "ask_on_ambiguous"
  | "recover_after_failure"
  | "final_evidence";

export interface QualityScenario {
  id: string;
  prompt: string;
  requirements: ScenarioRequirement[];
  description?: string;
}

export interface ScenarioScore {
  scenarioId: string;
  passed: boolean;
  score: number;
  issues: string[];
}

export const BUILTIN_QUALITY_SCENARIOS: QualityScenario[] = [
  {
    id: "bugfix-needs-context-and-check",
    prompt: "Fix a bug in an existing code path.",
    requirements: ["read_before_edit", "check_after_edit", "final_evidence"],
    description: "A bugfix should inspect code before editing and produce passing check evidence.",
  },
  {
    id: "interactive-ui-needs-browser",
    prompt: "Create or change an interactive website feature.",
    requirements: ["read_before_edit", "browser_after_ui_edit", "final_evidence"],
    description: "A visual/interactive task must be verified in a browser, not only by build output.",
  },
  {
    id: "ambiguous-risk-needs-clarification",
    prompt: "Perform an ambiguous or risky change where guessing would be costly.",
    requirements: ["ask_on_ambiguous", "final_evidence"],
    description: "A costly assumption should trigger clarification or an explicit assumption/evidence trail.",
  },
  {
    id: "repeated-failure-needs-recovery",
    prompt: "Recover from a failing command/tool without blind retries.",
    requirements: ["recover_after_failure", "final_evidence"],
    description: "Repeated failures require root-cause capture and a targeted recovery plan.",
  },
];

export function loadQualityScenarios(cwd: string): QualityScenario[] {
  const out = [...BUILTIN_QUALITY_SCENARIOS];
  const dir = join(cwd, "eval", "scenarios");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item.id === "string" && typeof item.prompt === "string" && Array.isArray(item.requirements)) {
          out.push({ id: item.id, prompt: item.prompt, description: item.description, requirements: item.requirements.filter(isRequirement) });
        }
      }
    } catch { /* skip malformed scenario files */ }
  }
  return out;
}

function isRequirement(x: unknown): x is ScenarioRequirement {
  return typeof x === "string" && [
    "read_before_edit",
    "check_after_edit",
    "browser_after_ui_edit",
    "ask_on_ambiguous",
    "recover_after_failure",
    "final_evidence",
  ].includes(x);
}

function firstSeq(ledger: QualityLedger, names: string[]): number | null {
  const hit = ledger.tools.filter((t) => names.includes(t.name)).sort((a, b) => a.seq - b.seq)[0];
  return hit ? hit.seq : null;
}

function anySeqAfter(ledger: QualityLedger, names: string[], after: number | null): boolean {
  if (after == null) return false;
  return ledger.tools.some((t) => names.includes(t.name) && t.seq > after && t.ok);
}

function anyCheckAfter(ledger: QualityLedger, after: number | null): boolean {
  if (after == null) return false;
  return ledger.checks.some((c) => c.seq > after && c.ran && c.ok);
}

export function scoreQualityLedger(scenario: QualityScenario, ledger: QualityLedger): ScenarioScore {
  const issues: string[] = [];
  const firstRead = firstSeq(ledger, ["read_file", "list_dir", "repo_map", "read_topic", "memory_search"]);
  const firstEdit = firstSeq(ledger, ["edit_file", "write_file", "architect_edit"]);
  const hasFinalEvidence = ledger.finalEvidence.length > 0;

  for (const req of scenario.requirements) {
    if (req === "read_before_edit" && firstEdit != null && !(firstRead != null && firstRead < firstEdit)) {
      issues.push("edited before inspecting relevant context");
    }
    if (req === "check_after_edit" && firstEdit != null && !anyCheckAfter(ledger, firstEdit)) {
      issues.push("no passing check after editing");
    }
    if (req === "browser_after_ui_edit" && ledger.profile.needsBrowser && firstEdit != null && !anySeqAfter(ledger, ["browser_check"], firstEdit)) {
      issues.push("interactive/UI change lacks passing browser_check after edit");
    }
    if (req === "ask_on_ambiguous" && ledger.profile.needsClarification && !ledger.tools.some((t) => t.name === "ask_user" && t.ok)) {
      issues.push("ambiguous task did not ask for clarification");
    }
    if (req === "recover_after_failure" && ledger.failures.some((f) => f.count >= 2) && ledger.recoveryActions.length === 0) {
      issues.push("repeated failure without recovery action");
    }
    if (req === "final_evidence" && !hasFinalEvidence) {
      issues.push("final response/evidence missing");
    }
  }

  const total = Math.max(1, scenario.requirements.length);
  const score = Math.max(0, total - issues.length) / total;
  return { scenarioId: scenario.id, passed: issues.length === 0, score, issues };
}
