// Policy engine + folder-trust resolver (parity with claw-code's policy_engine + trust_resolver).
//
// POLICY: declarative rules decide whether a tool call is allowed / denied / asked / warned, BEFORE the
// interactive approval gate. The highest-priority matching rule wins; no match → "ask" (the default
// gate behavior). Lets a user encode "allow all git", "deny any network command", etc.
//
// TRUST: a folder is trusted once the user says so (recorded in ~/.ob1/trust.json). In an UNTRUSTED
// folder, autopilot is downgraded to ask — running unfamiliar code unattended is the classic foot-gun.
//
// Pure + dependency-free (load/save are thin fs wrappers elsewhere); exhaustively unit-testable.
import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { CommandIntent } from "./bash-validation.ts";

export type PolicyAction = "allow" | "deny" | "ask" | "warn";

export interface PolicyCondition {
  tool?: string;          // exact tool name (e.g. "run_bash", "write_file")
  commandMatch?: string;  // regex (string) matched against a run_bash command
  intent?: CommandIntent; // bash intent class
  pathMatch?: string;     // regex (string) matched against a tool's path argument
}

export interface PolicyRule {
  name: string;
  action: PolicyAction;
  priority: number;       // higher wins on conflict
  condition: PolicyCondition;
}

export interface PolicyContext {
  tool: string;
  command?: string;
  intent?: CommandIntent;
  path?: string;
}

function safeRe(src: string): RegExp | null { try { return new RegExp(src); } catch { return null; } }

/** Does a condition match the call context? An empty condition matches NOTHING (avoids accidentally
 *  granting/allowing everything); each SPECIFIED field must match. Shared by the policy engine and the
 *  runtime approval-token store. */
export function matchesCondition(c: PolicyCondition, ctx: PolicyContext): boolean {
  const specified = c.tool != null || c.commandMatch != null || c.intent != null || c.pathMatch != null;
  if (!specified) return false;
  if (c.tool != null && c.tool !== ctx.tool) return false;
  if (c.intent != null && c.intent !== ctx.intent) return false;
  if (c.commandMatch != null) { const re = safeRe(c.commandMatch); if (!re || !re.test(ctx.command ?? "")) return false; }
  if (c.pathMatch != null) { const re = safeRe(c.pathMatch); if (!re || !re.test(ctx.path ?? "")) return false; }
  return true;
}

/** Does a rule match the call context? (Its condition matches.) */
export function matchesRule(rule: PolicyRule, ctx: PolicyContext): boolean {
  return matchesCondition(rule.condition, ctx);
}

export interface PolicyDecision { action: PolicyAction; rule?: PolicyRule }

/** Evaluate the rule set: the highest-priority matching rule wins (ties broken by earlier-in-list).
 *  No match → "ask" (defer to the normal approval gate). */
export function evaluatePolicy(rules: PolicyRule[], ctx: PolicyContext): PolicyDecision {
  let best: PolicyRule | undefined;
  for (const r of rules) {
    if (!matchesRule(r, ctx)) continue;
    if (!best || r.priority > best.priority) best = r;
  }
  return best ? { action: best.action, rule: best } : { action: "ask" };
}

/** Validate a raw rules array (from .ob1/policy.json), dropping malformed entries. Returns {rules, errors}. */
export function parsePolicy(raw: unknown): { rules: PolicyRule[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { rules: [], errors: raw == null ? [] : ["policy must be a JSON array of rules"] };
  const actions = new Set(["allow", "deny", "ask", "warn"]);
  const rules: PolicyRule[] = [];
  raw.forEach((r: any, i) => {
    if (!r || typeof r !== "object") { errors.push(`rule ${i}: not an object`); return; }
    if (!actions.has(r.action)) { errors.push(`rule ${i} (${r.name ?? "?"}): invalid action ${JSON.stringify(r.action)}`); return; }
    if (!r.condition || typeof r.condition !== "object") { errors.push(`rule ${i} (${r.name ?? "?"}): missing condition`); return; }
    rules.push({
      name: String(r.name ?? `rule-${i}`),
      action: r.action,
      priority: Number.isFinite(r.priority) ? Number(r.priority) : 0,
      condition: {
        tool: typeof r.condition.tool === "string" ? r.condition.tool : undefined,
        commandMatch: typeof r.condition.commandMatch === "string" ? r.condition.commandMatch : undefined,
        intent: typeof r.condition.intent === "string" ? r.condition.intent : undefined,
        pathMatch: typeof r.condition.pathMatch === "string" ? r.condition.pathMatch : undefined,
      },
    });
  });
  return { rules, errors };
}

// ── folder trust ──────────────────────────────────────────────────────────────
export interface TrustStore { trusted: string[] }

/** Phrases a host's trust prompt uses — lets OB-1 recognize a "do you trust this folder?" gate (parity). */
export const TRUST_CUES = [
  "do you trust the files in this folder",
  "trust the files in this folder",
  "trust this folder",
  "yes, proceed",
];

/** A folder is trusted if it OR any ancestor was explicitly trusted (trusting a repo root covers subdirs). */
export function isTrusted(cwd: string, store: TrustStore): boolean {
  const target = resolve(cwd);
  return (store.trusted ?? []).some((t) => { const tt = resolve(t); return target === tt || target.startsWith(tt + "/"); });
}

/** Add `cwd` to the trusted set (idempotent; drops paths now covered by it). */
export function recordTrust(cwd: string, store: TrustStore): TrustStore {
  const target = resolve(cwd);
  const kept = (store.trusted ?? []).map((t) => resolve(t)).filter((t) => t !== target && !t.startsWith(target + "/"));
  if (!kept.some((t) => target.startsWith(t + "/"))) kept.push(target); // skip if an ancestor already covers it
  return { trusted: [...new Set(kept)] };
}

/** Effective permission mode given trust: an untrusted folder downgrades autopilot → ask. */
export function effectivePermissionMode(requested: string, trusted: boolean): { mode: string; downgraded: boolean } {
  if (requested === "autopilot" && !trusted) return { mode: "ask", downgraded: true };
  return { mode: requested, downgraded: false };
}

// ── thin fs loaders (the core logic above is pure; these just read/write JSON) ──────────────────────
/** Load workspace policy rules from `<cwd>/.ob1/policy.json`. Missing/unreadable ⇒ no rules. */
export function loadPolicy(cwd: string): { rules: PolicyRule[]; errors: string[] } {
  try { return parsePolicy(JSON.parse(readFileSync(join(cwd, ".ob1", "policy.json"), "utf8"))); }
  catch { return { rules: [], errors: [] }; }
}

/** Load the global trusted-folder store from `<settingsDir>/trust.json`. */
export function loadTrust(settingsDir: string): TrustStore {
  try { const j = JSON.parse(readFileSync(join(settingsDir, "trust.json"), "utf8")); return { trusted: Array.isArray(j?.trusted) ? j.trusted.filter((s: unknown) => typeof s === "string") : [] }; }
  catch { return { trusted: [] }; }
}

/** Persist the trusted-folder store (best-effort; never throws into a turn). */
export function saveTrust(settingsDir: string, store: TrustStore): void {
  try { mkdirSync(settingsDir, { recursive: true }); writeFileSync(join(settingsDir, "trust.json"), JSON.stringify(store, null, 2)); }
  catch { /* best-effort */ }
}
