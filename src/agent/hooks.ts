// Programmable hooks (parity with claw-code's hooks / Claude Code's hook system).
//
// User-defined commands that run AROUND tool calls and can block/allow/inject feedback:
//   • PreToolUse        — before a tool runs; exit 2 (or {"decision":"block"}) BLOCKS the call
//   • PostToolUse       — after a successful tool; stdout is fed back to the model (lint, format, notes)
//   • PostToolUseFailure— after a tool errors; stdout is fed back as a fix hint (a self-correction trigger)
//
// Hooks are configured in `.ob1/hooks.json` and receive the event payload as JSON on stdin. The pure
// decision logic (runHooks) takes an injected executor so it's deterministically testable; the real
// executor (Bun.spawn) lives in the app layer.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
export const HOOK_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

export interface HookConfig {
  event: HookEvent;
  matcher?: string; // regex matched against the tool name; omitted ⇒ matches every tool
  command: string;  // shell command; receives the JSON payload on stdin
}

export interface HookPayload {
  event: HookEvent;
  tool: string;
  input?: unknown;
  output?: string; // tool result (PostToolUse)
  error?: string;  // tool error (PostToolUseFailure)
}

export type HookExec = (command: string, stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface HookOutcome {
  decision: "allow" | "block";
  reason?: string;   // why it blocked (PreToolUse)
  feedback: string;  // aggregated hook stdout to surface to the model
  ran: number;       // how many hooks executed
}

function safeRe(src: string): RegExp | null { try { return new RegExp(src); } catch { return null; } }

/** Hooks registered for an event whose matcher matches the tool name (or have no matcher). */
export function matchHooks(hooks: HookConfig[], event: HookEvent, tool: string): HookConfig[] {
  return hooks.filter((h) => h.event === event && (h.matcher == null || (safeRe(h.matcher)?.test(tool) ?? false)));
}

/** Run every matching hook for the payload's event. A PreToolUse hook that exits 2 — or prints
 *  {"decision":"block","reason":"…"} — blocks the call (first blocker wins). All stdout is collected as
 *  feedback. A non-zero exit (other than the PreToolUse block code 2) is surfaced as feedback, not fatal. */
export async function runHooks(hooks: HookConfig[], payload: HookPayload, exec: HookExec): Promise<HookOutcome> {
  const matching = matchHooks(hooks, payload.event, payload.tool);
  const stdin = JSON.stringify(payload);
  const feedback: string[] = [];
  let decision: "allow" | "block" = "allow";
  let reason: string | undefined;
  let ran = 0;

  for (const h of matching) {
    ran++;
    let r: { code: number; stdout: string; stderr: string };
    try { r = await exec(h.command, stdin); }
    catch (e) { feedback.push(`[hook error: ${(e as Error).message}]`); continue; }

    // A hook may emit a structured decision as JSON on stdout.
    let structured: any;
    const trimmed = r.stdout.trim();
    if (trimmed.startsWith("{")) { try { structured = JSON.parse(trimmed); } catch { /* plain text */ } }

    const blocked = (structured && structured.decision === "block") || r.code === 2;
    if (structured?.feedback) feedback.push(String(structured.feedback));
    else if (trimmed && !structured) feedback.push(trimmed);
    if (r.stderr.trim()) feedback.push(r.stderr.trim());

    if (blocked && payload.event === "PreToolUse") {
      decision = "block";
      reason = (structured?.reason && String(structured.reason)) || r.stderr.trim() || trimmed || "blocked by a PreToolUse hook";
      break; // first blocker short-circuits — the tool won't run
    }
    if (blocked) decision = "block"; // Post* "block" means "the model must address this feedback"
  }

  return { decision, reason, feedback: feedback.join("\n").trim(), ran };
}

/** Load workspace hooks from `<cwd>/.ob1/hooks.json`. Missing/unreadable ⇒ no hooks. */
export function loadHooks(cwd: string): { hooks: HookConfig[]; errors: string[] } {
  try { return parseHooks(JSON.parse(readFileSync(join(cwd, ".ob1", "hooks.json"), "utf8"))); }
  catch { return { hooks: [], errors: [] }; }
}

/** Validate a raw hooks array (from .ob1/hooks.json), dropping malformed entries. */
export function parseHooks(raw: unknown): { hooks: HookConfig[]; errors: string[] } {
  const errors: string[] = [];
  if (raw == null) return { hooks: [], errors: [] };
  if (!Array.isArray(raw)) return { hooks: [], errors: ["hooks must be a JSON array"] };
  const events = new Set(HOOK_EVENTS);
  const hooks: HookConfig[] = [];
  raw.forEach((h: any, i) => {
    if (!h || typeof h !== "object") { errors.push(`hook ${i}: not an object`); return; }
    if (!events.has(h.event)) { errors.push(`hook ${i}: invalid event ${JSON.stringify(h.event)} (expected ${HOOK_EVENTS.join(" | ")})`); return; }
    if (typeof h.command !== "string" || !h.command.trim()) { errors.push(`hook ${i} (${h.event}): missing command`); return; }
    hooks.push({ event: h.event, command: h.command, matcher: typeof h.matcher === "string" ? h.matcher : undefined });
  });
  return { hooks, errors };
}
