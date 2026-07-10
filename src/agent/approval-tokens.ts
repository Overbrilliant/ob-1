// Capability approval tokens (parity with claw-code's approval_tokens).
//
// The per-call approval gate prompts for EVERY mutating tool — fine for a one-off, tedious for a long
// session of, say, git commands. A capability token is a user-granted, scoped, optionally-counted
// standing approval: "allow all git this session", "allow 5 writes under src/", "allow run_bash". The
// gate consults active tokens before prompting; a match auto-approves (and decrements a finite token).
// Session-scoped (held in memory, never persisted) so a grant can't silently outlive the session.
import { matchesCondition, type PolicyCondition, type PolicyContext } from "../safety/policy.ts";

export interface ApprovalToken {
  id: string;
  label: string;            // human description for /allow list
  scope: PolicyCondition;   // what the token covers (tool / commandMatch / intent / pathMatch)
  remaining?: number;       // uses left; undefined = unlimited for the session
}

/** A session store of capability tokens. Grants auto-approve matching tool calls until revoked/exhausted. */
export class ApprovalStore {
  private tokens: ApprovalToken[] = [];
  private seq = 0;

  /** Grant a standing approval. `uses` undefined ⇒ unlimited for the session; a finite count decrements. */
  grant(scope: PolicyCondition, opts: { label?: string; uses?: number } = {}): ApprovalToken {
    const id = `tok-${++this.seq}`;
    const tok: ApprovalToken = { id, label: opts.label ?? describeScope(scope), scope, remaining: opts.uses };
    this.tokens.push(tok);
    return tok;
  }

  /** The first active token that covers this call (without consuming a use). */
  covers(ctx: PolicyContext): ApprovalToken | undefined {
    return this.tokens.find((t) => (t.remaining === undefined || t.remaining > 0) && matchesCondition(t.scope, ctx));
  }

  /** Consume a covering token: returns true if the call is pre-approved. Decrements a finite token and
   *  drops it once exhausted. An unlimited token stays. */
  consume(ctx: PolicyContext): boolean {
    const tok = this.covers(ctx);
    if (!tok) return false;
    if (tok.remaining !== undefined) {
      tok.remaining -= 1;
      if (tok.remaining <= 0) this.tokens = this.tokens.filter((t) => t.id !== tok.id);
    }
    return true;
  }

  list(): ApprovalToken[] { return this.tokens.map((t) => ({ ...t })); }
  revoke(id: string): boolean { const n = this.tokens.length; this.tokens = this.tokens.filter((t) => t.id !== id); return this.tokens.length < n; }
  clear(): void { this.tokens = []; }
  get size(): number { return this.tokens.length; }
}

function describeScope(s: PolicyCondition): string {
  const bits: string[] = [];
  if (s.tool) bits.push(s.tool);
  if (s.commandMatch) bits.push(`command~/${s.commandMatch}/`);
  if (s.intent) bits.push(`${s.intent} commands`);
  if (s.pathMatch) bits.push(`path~/${s.pathMatch}/`);
  return bits.join(" · ") || "(anything)";
}

/** Parse a `/allow` argument into a capability scope. Examples:
 *    /allow git          → run_bash commands starting with "git"
 *    /allow run_bash     → any run_bash
 *    /allow write        → write_file + edit_file (path-agnostic)
 *    /allow write src/   → writes whose path contains "src/"
 *    /allow <tool>       → that exact tool
 *  Returns null for an empty/unknown spec. */
export function parseAllowSpec(arg: string): { scope: PolicyCondition; label: string } | null {
  const parts = String(arg ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const [head, ...rest] = parts;
  const h = head.toLowerCase();
  if (h === "git") return { scope: { tool: "run_bash", commandMatch: "^\\s*git\\b" }, label: "git commands" };
  if (h === "bash" || h === "run_bash") return { scope: { tool: "run_bash" }, label: "all run_bash" };
  if (h === "write" || h === "writes") {
    const path = rest.join(" ");
    // write/edit are two tools; we represent the lane by tool=write_file with an optional pathMatch and
    // also cover edit_file via a second grant at the call site. Here we return the write_file scope.
    return path
      ? { scope: { tool: "write_file", pathMatch: escapeForPath(path) }, label: `writes under ${path}` }
      : { scope: { tool: "write_file" }, label: "all writes" };
  }
  // a bare tool name (read_file/edit_file/run_bash/web_fetch/…)
  return { scope: { tool: head }, label: head };
}

function escapeForPath(p: string): string { return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
