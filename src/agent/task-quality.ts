import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QualityMode } from "../config.ts";

export type TaskKind =
  | "bugfix"
  | "feature"
  | "refactor"
  | "frontend"
  | "docs"
  | "research"
  | "release"
  | "install"
  | "review"
  | "unknown";
export type RiskLevel = "low" | "medium" | "high";
export type QualityLens = "silent-failure" | "behavioral-coverage" | "ux-browser" | "security" | "diff-minimality" | "context-sufficiency";
export type VerificationScope = "none" | "manual" | "auto" | "targeted_tests" | "package" | "workspace" | "merge_ready" | "browser";

export interface TaskProfile {
  kind: TaskKind;
  risk: RiskLevel;
  needsBrowser: boolean;
  needsTests: boolean;
  needsPlan: boolean;
  needsClarification: boolean;
  successCriteria: string[];
  qualityLenses: QualityLens[];
  verificationScope: VerificationScope;
}

export interface QualityToolEvent {
  seq: number;
  name: string;
  input?: unknown;
  ok: boolean;
  workspaceChange?: boolean;
  summary: string;
  ts: string;
}

export interface QualityCheckEvent {
  seq: number;
  kind: "auto-verify" | "verify" | "browser" | "command";
  scope?: string;
  ok: boolean;
  ran: boolean;
  summary: string;
  ts: string;
}

export interface QualityFailureEvent {
  seq: number;
  key: string;
  tool: string;
  message: string;
  count: number;
  ts: string;
}

export interface QualityLedger {
  schema: "ob1.quality.v1";
  id: string;
  createdAt: string;
  updatedAt: string;
  objective: string;
  mode: QualityMode;
  profile: TaskProfile;
  assumptions: string[];
  context: string[];
  decisions: string[];
  tools: QualityToolEvent[];
  checks: QualityCheckEvent[];
  failures: QualityFailureEvent[];
  recoveryActions: string[];
  reviewFindings: string[];
  finalEvidence: string[];
  status: "running" | "completed" | "blocked" | "error";
}

const UI_RE = /\b(ui|ux|frontend|front-end|browser|website|web\s*app|page|css|html|react|next|vite|tailwind|button|form|modal|route|toggle|theme|responsive|visual|style|layout|animation)\b/i;
const CODE_RE = /\b(fix|bug|implement|add|create|build|refactor|edit|change|update|test|typecheck|compile|function|component|api|cli|command|script|server)\b/i;
const RISK_RE = /\b(auth|security|crypto|password|secret|token|payment|billing|money|migration|database|db|production|prod|deploy|release|delete\s+from|drop\s+table|truncate|wipe|purge)\b/i;

function has(s: string, re: RegExp): boolean { return re.test(s); }
function uniq<T>(xs: T[]): T[] { return [...new Set(xs)]; }
function oneLine(s: string, max = 240): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
function nowIso(): string { return new Date().toISOString(); }
function safeId(ts: string, objective: string): string {
  const slug = objective.toLowerCase().replace(/[`'"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task";
  return `${ts.replace(/[:.]/g, "-")}-${slug}`;
}

export function classifyTask(input: string): TaskProfile {
  const text = String(input ?? "");
  const lower = text.toLowerCase();
  let kind: TaskKind = "unknown";
  const reviewRequest = has(lower, /\b(review|audit)\b/i) && !has(lower, /\b(fix|implement|change|update|edit|create|build)\b/i);
  const bugHunt = has(lower, /\b(search for|look for|find|check)\b.*\b(bugs?|issues?|quality problems?)\b/i);
  if (reviewRequest || bugHunt) kind = "review";
  else if (has(lower, /\b(fix|broken|failing|regression|error|crash)\b/i)) kind = "bugfix";
  else if (has(lower, /\b(refactor|cleanup|rename|simplify|restructure)\b/i)) kind = "refactor";
  else if (has(lower, UI_RE)) kind = "frontend";
  else if (has(lower, /\b(doc|readme|copy|comment|explain|write[- ]?up)\b/i)) kind = "docs";
  else if (has(lower, /\b(review|audit|bugs|issues|quality)\b/i)) kind = "review";
  else if (has(lower, /\b(search|research|compare|investigate)\b/i)) kind = "research";
  else if (has(lower, /\b(release|deploy|publish|ship|prod|production|push|pr|merge)\b/i)) kind = "release";
  else if (has(lower, /\b(install|setup|fresh machine|onboard|bootstrap)\b/i)) kind = "install";
  else if (has(lower, CODE_RE)) kind = "feature";

  const needsBrowser = has(lower, UI_RE);
  const needsTests = has(lower, CODE_RE) && kind !== "docs" && kind !== "research" && kind !== "review";
  const highRisk = has(lower, RISK_RE);
  const risk: RiskLevel = highRisk ? "high" : (needsBrowser || kind === "bugfix" || kind === "release" || text.length > 400) ? "medium" : "low";
  const needsPlan = risk !== "low" || text.length > 300 || kind === "review" || kind === "research";
  const needsClarification = has(lower, /\b(or|either|maybe|not sure|which|choose|option|preference|ambiguous)\b/i) && !has(lower, /\bgo|do it|implement|fix\b/i);

  const successCriteria = [
    "Relevant files/context inspected before editing",
    needsClarification ? "Clarifying question asked before making a costly assumption" : "Assumptions kept explicit when requirements are missing",
    needsTests ? "Project checks selected and run for the change" : "No unnecessary code checks for non-code work",
    needsBrowser ? "Interactive/visual behaviour verified in a browser" : "",
    risk === "high" ? "High-risk paths reviewed for safety and rollback risk" : "",
    "Final response cites concrete evidence and unresolved risks",
  ].filter(Boolean);

  const qualityLenses: QualityLens[] = ["context-sufficiency", "diff-minimality"];
  if (needsTests || kind === "bugfix" || kind === "feature") qualityLenses.push("behavioral-coverage", "silent-failure");
  if (needsBrowser) qualityLenses.push("ux-browser");
  if (risk === "high") qualityLenses.push("security");

  const verificationScope: VerificationScope =
    needsBrowser ? "browser"
      : risk === "high" || kind === "release" ? "workspace"
        : needsTests ? "package"
          : kind === "docs" || kind === "research" || kind === "review" ? "manual"
            : "auto";

  return { kind, risk, needsBrowser, needsTests, needsPlan, needsClarification, successCriteria, qualityLenses: uniq(qualityLenses), verificationScope };
}

export function renderTaskQualityContract(profile: TaskProfile, mode: QualityMode): string {
  if (mode === "off") return "";
  const strict = mode === "strict";
  return [
    `Task Quality Contract (${mode})`,
    `- Profile: ${profile.kind}, ${profile.risk} risk; verification target: ${profile.verificationScope}.`,
    `- Success criteria: ${profile.successCriteria.join("; ")}.`,
    `- Review lenses: ${profile.qualityLenses.join(", ")}.`,
    strict
      ? "- Strict mode: do not finish until the required evidence is present, or explicitly mark the task blocked with the exact missing evidence."
      : "- Normal mode: gather enough evidence for the task type; if evidence is missing, say that directly instead of implying it is verified.",
    "- If the same tool/command fails twice, stop retrying variants and first capture root cause, smallest next check, and recovery plan.",
  ].join("\n");
}

export class QualityRun {
  readonly path: string;
  readonly ledger: QualityLedger;
  private seq = 0;
  private failureCounts = new Map<string, number>();

  constructor(cwd: string, objective: string, mode: QualityMode, profile = classifyTask(objective), ts = nowIso()) {
    const id = safeId(ts, objective);
    this.path = join(cwd, ".ob1", "runs", `${id}.quality.json`);
    this.ledger = {
      schema: "ob1.quality.v1",
      id,
      createdAt: ts,
      updatedAt: ts,
      objective,
      mode,
      profile,
      assumptions: [],
      context: [],
      decisions: [],
      tools: [],
      checks: [],
      failures: [],
      recoveryActions: [],
      reviewFindings: [],
      finalEvidence: [],
      status: "running",
    };
  }

  private nextSeq(): number { return ++this.seq; }
  private touch(): void { this.ledger.updatedAt = nowIso(); }

  save(): void {
    this.touch();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.ledger, null, 2) + "\n");
  }

  addContext(label: string): void {
    const t = oneLine(label, 300);
    if (t && !this.ledger.context.includes(t)) this.ledger.context.push(t);
  }

  addDecision(text: string): void {
    const t = oneLine(text, 300);
    if (t) this.ledger.decisions.push(t);
  }

  recordTool(name: string, input: unknown, ok: boolean, summary: string, workspaceChange = false): void {
    this.ledger.tools.push({ seq: this.nextSeq(), name, input: summarizeInput(input), ok, workspaceChange, summary: oneLine(summary), ts: nowIso() });
    if (name === "read_file" && typeof (input as any)?.path === "string") this.addContext(`read_file:${(input as any).path}`);
    if (["list_dir", "repo_map", "read_topic", "memory_search"].includes(name)) this.addContext(name);
    if (name === "verify") this.recordCheck("verify", String((input as any)?.checks ?? "auto"), ok, true, summary);
    if (name === "browser_check") this.recordCheck("browser", "browser_check", ok, true, summary);
  }

  recordCheck(kind: QualityCheckEvent["kind"], scope: string | undefined, ok: boolean, ran: boolean, summary: string): void {
    this.ledger.checks.push({ seq: this.nextSeq(), kind, scope, ok, ran, summary: oneLine(summary, 500), ts: nowIso() });
    if (ran && ok) this.addFinalEvidence(`${kind}${scope ? `:${scope}` : ""} passed`);
    if (ran && !ok) this.addReviewFinding(`${kind}${scope ? `:${scope}` : ""} failed`);
  }

  recordAutoVerification(result: { ran: boolean; ok: boolean; report: string } | null): void {
    if (!result) {
      this.recordCheck("auto-verify", "auto", false, false, "verification could not run");
      return;
    }
    this.recordCheck("auto-verify", "auto", result.ok, result.ran, result.report);
  }

  recordCommandOutcome(command: string, output: string): string | null {
    const first = output.split("\n", 1)[0] ?? "";
    const failed = output.startsWith("timed out") || /^exit\s+([1-9]\d*)\b/.test(first);
    const ok = output === "exit 0" || output.startsWith("exit 0\n");
    if (ok && /\b(test|typecheck|tsc|lint|eslint|build|cargo check|cargo test|go test|pytest|ruff|mypy)\b/i.test(command)) {
      this.recordCheck("command", command, true, true, output);
    }
    if (!failed) return null;
    const n = this.recordFailure("run_bash", `run_bash:${command}`, output);
    return n >= 2 ? recoveryNudge(command, n) : null;
  }

  recordFailure(tool: string, key: string, message: string): number {
    const n = (this.failureCounts.get(key) ?? 0) + 1;
    this.failureCounts.set(key, n);
    const ev = { seq: this.nextSeq(), key, tool, message: oneLine(message, 500), count: n, ts: nowIso() };
    this.ledger.failures.push(ev);
    if (n >= 2) this.addRecoveryAction(`Repeated failure (${tool}, ${n}×): ${oneLine(message, 160)}. Diagnose root cause before retrying.`);
    return n;
  }

  addRecoveryAction(text: string): void {
    const t = oneLine(text, 400);
    if (t) this.ledger.recoveryActions.push(t);
  }

  addReviewFinding(text: string): void {
    const t = oneLine(text, 400);
    if (t) this.ledger.reviewFindings.push(t);
  }

  addFinalEvidence(text: string): void {
    const t = oneLine(text, 300);
    if (t && !this.ledger.finalEvidence.includes(t)) this.ledger.finalEvidence.push(t);
  }

  finish(status: QualityLedger["status"], finalText?: string): void {
    if (finalText) this.addFinalEvidence(`final response: ${oneLine(finalText, 180)}`);
    if (this.ledger.profile.needsBrowser && !this.ledger.checks.some((c) => c.kind === "browser" && c.ok)) {
      this.addReviewFinding("UI/browser evidence missing");
      if (this.ledger.mode === "strict" && status === "completed") status = "blocked";
    }
    if (this.ledger.profile.needsTests && !this.ledger.checks.some((c) => c.ran && c.ok)) {
      this.addReviewFinding("passing check evidence missing");
      if (this.ledger.mode === "strict" && status === "completed") status = "blocked";
    }
    this.ledger.status = status;
    this.save();
  }
}

function summarizeInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = oneLine(v, k === "content" || k === "old_string" || k === "new_string" ? 120 : 300);
    else out[k] = v;
  }
  return out;
}

function recoveryNudge(command: string, count: number): string {
  return `Repeated failure (${count}×) for \`${command}\`. Stop retrying variants. First identify the root cause from the output, choose the smallest next check, then retry only that targeted fix.`;
}

export function latestQualityLedger(cwd: string): { path: string; ledger: QualityLedger } | null {
  const dir = join(cwd, ".ob1", "runs");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".quality.json")).sort().reverse();
  for (const f of files) {
    const path = join(dir, f);
    try { return { path, ledger: JSON.parse(readFileSync(path, "utf8")) as QualityLedger }; }
    catch { /* skip corrupt ledger */ }
  }
  return null;
}

export function formatQualityLedger(ledger: QualityLedger, path?: string): string {
  const checks = ledger.checks.length
    ? ledger.checks.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.kind}${c.scope ? ` (${c.scope})` : ""}: ${c.summary}`).join("\n")
    : "- (none)";
  const risks = ledger.reviewFindings.length ? ledger.reviewFindings.map((x) => `- ${x}`).join("\n") : "- (none)";
  const recoveries = ledger.recoveryActions.length ? ledger.recoveryActions.map((x) => `- ${x}`).join("\n") : "- (none)";
  return [
    `Quality run: ${ledger.id}${path ? ` (${path})` : ""}`,
    `Status: ${ledger.status} · ${ledger.profile.kind} · ${ledger.profile.risk} risk · ${ledger.mode}`,
    `Objective: ${ledger.objective}`,
    "",
    "Checks:",
    checks,
    "",
    "Recovery:",
    recoveries,
    "",
    "Open risks:",
    risks,
    "",
    `Evidence: ${ledger.finalEvidence.length ? ledger.finalEvidence.join("; ") : "(none)"}`,
  ].join("\n");
}
