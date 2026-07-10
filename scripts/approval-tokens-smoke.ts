// Deterministic test for capability approval tokens (no network).
// Usage: bun run scripts/approval-tokens-smoke.ts
import { ApprovalStore, parseAllowSpec } from "../src/agent/approval-tokens.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── parseAllowSpec ─────────────────────────────────────────────────────────────
check("'git' → run_bash + ^git command match", (() => { const s = parseAllowSpec("git"); return s?.scope.tool === "run_bash" && /git/.test(s.scope.commandMatch ?? ""); })());
check("'bash' → any run_bash", parseAllowSpec("bash")?.scope.tool === "run_bash" && !parseAllowSpec("bash")?.scope.commandMatch);
check("'write' → write_file, no path", parseAllowSpec("write")?.scope.tool === "write_file" && !parseAllowSpec("write")?.scope.pathMatch);
check("'write src/' → write_file scoped to a path", (() => { const s = parseAllowSpec("write src/"); return s?.scope.tool === "write_file" && /src/.test(s.scope.pathMatch ?? ""); })());
check("bare tool name → that tool", parseAllowSpec("web_fetch")?.scope.tool === "web_fetch");
check("empty spec → null", parseAllowSpec("   ") === null);

// ── store: grant + cover + consume ───────────────────────────────────────────
const s = new ApprovalStore();
check("nothing covered before any grant", !s.covers({ tool: "run_bash", command: "git status" }));
s.grant({ tool: "run_bash", commandMatch: "^\\s*git\\b" }, { label: "git" });
check("git grant covers a git command", !!s.covers({ tool: "run_bash", command: "git commit -m x" }));
check("git grant does NOT cover a non-git command", !s.covers({ tool: "run_bash", command: "rm -rf x" }));
check("git grant does NOT cover a different tool", !s.covers({ tool: "write_file", path: "a" }));
check("consume returns true for a covered call (unlimited stays)", s.consume({ tool: "run_bash", command: "git push" }) && s.consume({ tool: "run_bash", command: "git pull" }));

// ── finite token decrements + expires ─────────────────────────────────────────
const f = new ApprovalStore();
f.grant({ tool: "write_file" }, { label: "writes", uses: 2 });
check("finite token: use 1 ok", f.consume({ tool: "write_file", path: "a" }));
check("finite token: use 2 ok", f.consume({ tool: "write_file", path: "b" }));
check("finite token: use 3 denied (exhausted + dropped)", !f.consume({ tool: "write_file", path: "c" }) && f.size === 0);

// ── list / revoke / clear ─────────────────────────────────────────────────────
const m = new ApprovalStore();
const t1 = m.grant({ tool: "run_bash" }, { label: "bash" });
m.grant({ tool: "edit_file" }, { label: "edits" });
check("list returns granted tokens", m.list().length === 2 && m.list().some((t) => t.label === "bash"));
check("revoke removes a token by id", m.revoke(t1.id) && m.size === 1);
check("revoke unknown id → false", !m.revoke("nope"));
m.clear();
check("clear drops all", m.size === 0);

// ── empty scope never covers (safety) ─────────────────────────────────────────
const e = new ApprovalStore();
e.grant({}, { label: "empty" });
check("empty-scope token covers NOTHING (no accidental allow-all)", !e.covers({ tool: "run_bash", command: "x" }));

if (fail) { console.error("\n✗ approval-tokens smoke FAILED"); process.exit(1); }
console.log("\n✓ approval-tokens smoke passed");
