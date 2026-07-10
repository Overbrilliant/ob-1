// Deterministic test for the task-quality layer: task profiling, prompt contract, ledger persistence,
// repeated-failure recovery, strict evidence gating, and scenario scoring.
// Usage: bun run scripts/task-quality-smoke.ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTask, formatQualityLedger, latestQualityLedger, QualityRun, renderTaskQualityContract } from "../src/agent/task-quality.ts";
import { scoreQualityLedger, BUILTIN_QUALITY_SCENARIOS } from "../src/eval/scenarios.ts";

let fail = false;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail = true;
};

const ui = classifyTask("Create a website with a dark mode toggle and verify it works");
check("classifier detects frontend tasks", ui.kind === "frontend" && ui.needsBrowser && ui.verificationScope === "browser");
check("frontend contract requires browser evidence", renderTaskQualityContract(ui, "strict").includes("browser") && renderTaskQualityContract(ui, "strict").includes("Strict mode"));

const risky = classifyTask("Migrate production billing records and delete old rows");
check("classifier flags high-risk data/production work", risky.risk === "high" && risky.qualityLenses.includes("security") && risky.verificationScope === "workspace");

const review = classifyTask("Review this CLI for bugs and quality issues");
check("classifier detects review/audit tasks", review.kind === "review" && review.needsPlan && review.verificationScope === "manual");

const dir = mkdtempSync(join(tmpdir(), "ob1-quality-"));
try {
  const run = new QualityRun(dir, "Create a website with a dark mode toggle", "strict", ui, "2026-06-25T10:00:00.000Z");
  run.recordTool("read_file", { path: "site/index.html" }, true, "read file");
  run.recordTool("edit_file", { path: "site/index.html", old_string: "x", new_string: "y" }, true, "edited", true);
  const n1 = run.recordFailure("run_bash", "run_bash:bun run dev", "exit 1\nport in use");
  const n2 = run.recordFailure("run_bash", "run_bash:bun run dev", "exit 1\nport in use");
  check("repeated failures are counted", n1 === 1 && n2 === 2);
  check("repeated failures create a recovery action", run.ledger.recoveryActions.some((x) => x.includes("Repeated failure")));
  run.finish("completed", "Done");

  check("strict mode blocks missing browser evidence", run.ledger.status === "blocked" && run.ledger.reviewFindings.some((x) => x.includes("UI/browser")));
  check("quality ledger persisted to .ob1/runs", existsSync(run.path));
  check("latestQualityLedger reads newest persisted run", latestQualityLedger(dir)?.ledger.id === run.ledger.id);
  check("formatQualityLedger renders useful summary", formatQualityLedger(run.ledger, run.path).includes("Open risks"));

  const saved = JSON.parse(readFileSync(run.path, "utf8"));
  check("persisted ledger keeps schema and objective", saved.schema === "ob1.quality.v1" && saved.objective.includes("website"));

  const scenario = BUILTIN_QUALITY_SCENARIOS.find((s) => s.id === "interactive-ui-needs-browser")!;
  const scoreMissing = scoreQualityLedger(scenario, run.ledger);
  check("scenario scoring catches missing browser_check", !scoreMissing.passed && scoreMissing.issues.some((x) => x.includes("browser_check")));

  const passing = new QualityRun(dir, "Create a website with a dark mode toggle", "normal", ui, "2026-06-25T10:01:00.000Z");
  passing.recordTool("read_file", { path: "site/index.html" }, true, "read file");
  passing.recordTool("edit_file", { path: "site/index.html" }, true, "edited", true);
  passing.recordTool("browser_check", { url: "site/index.html" }, true, "✓ browser_check PASSED", false);
  passing.finish("completed", "Verified with browser_check");
  const scorePassing = scoreQualityLedger(scenario, passing.ledger);
  check("scenario scoring passes browser-verified UI work", scorePassing.passed);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fail) { console.error("\n✗ task-quality smoke FAILED"); process.exit(1); }
console.log("\n✓ task-quality smoke passed");
