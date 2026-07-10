// Deterministic test for the policy engine, folder trust, and stale-branch detection (no spawn).
// Usage: bun run scripts/policy-smoke.ts
import { evaluatePolicy, matchesRule, parsePolicy, isTrusted, recordTrust, effectivePermissionMode, type PolicyRule } from "../src/safety/policy.ts";
import { analyzeBranch, parseStatusV2, readGitState } from "../src/context/git-state.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── policy engine ──────────────────────────────────────────────────────────────
const rules: PolicyRule[] = [
  { name: "allow-git", action: "allow", priority: 10, condition: { tool: "run_bash", commandMatch: "^git " } },
  { name: "deny-network", action: "deny", priority: 50, condition: { intent: "network" } },
  { name: "warn-writes", action: "warn", priority: 1, condition: { tool: "write_file" } },
];
check("no match → ask (defer to the gate)", evaluatePolicy(rules, { tool: "read_file" }).action === "ask");
check("allow rule matches git command", evaluatePolicy(rules, { tool: "run_bash", command: "git status", intent: "read-only" }).action === "allow");
check("deny beats allow by priority (network git? no — a curl)", evaluatePolicy(rules, { tool: "run_bash", command: "curl x", intent: "network" }).action === "deny");
check("warn rule tags write_file", evaluatePolicy(rules, { tool: "write_file", path: "a.ts" }).action === "warn");
check("empty condition matches NOTHING (no accidental allow-all)", !matchesRule({ name: "x", action: "allow", priority: 0, condition: {} }, { tool: "run_bash" }));
check("pathMatch condition works", matchesRule({ name: "p", action: "deny", priority: 0, condition: { pathMatch: "\\.env$" } }, { tool: "write_file", path: ".env" }));

// ── policy parsing (validation) ─────────────────────────────────────────────────
const parsed = parsePolicy([
  { name: "ok", action: "allow", priority: 5, condition: { tool: "run_bash" } },
  { name: "bad-action", action: "nope", condition: { tool: "x" } },
  { name: "no-condition", action: "deny" },
  "not an object",
]);
check("parsePolicy keeps valid rules, drops invalid", parsed.rules.length === 1 && parsed.rules[0].name === "ok");
check("parsePolicy reports errors for invalid rules", parsed.errors.length === 3);
check("parsePolicy on non-array → error", parsePolicy({}).errors.length === 1);
check("parsePolicy defaults missing priority to 0", parsed.rules[0].priority === 5 && parsePolicy([{ name: "n", action: "warn", condition: { tool: "t" } }]).rules[0].priority === 0);

// ── folder trust ────────────────────────────────────────────────────────────────
let store = { trusted: ["/home/me/project"] };
check("isTrusted: exact folder", isTrusted("/home/me/project", store));
check("isTrusted: subfolder of a trusted root", isTrusted("/home/me/project/src/deep", store));
check("isTrusted: unrelated folder → false", !isTrusted("/home/me/other", store));
store = recordTrust("/tmp/newrepo", store);
check("recordTrust adds the folder", isTrusted("/tmp/newrepo", store));
check("recordTrust is idempotent (no dupes)", recordTrust("/tmp/newrepo", store).trusted.filter((t) => t.endsWith("newrepo")).length === 1);
check("recordTrust of an ancestor collapses descendants", (() => { const s = recordTrust("/a/b", recordTrust("/a/b/c", { trusted: [] })); return s.trusted.length === 1 && s.trusted[0].endsWith("/a/b"); })());
check("autopilot downgraded to ask in an untrusted folder", effectivePermissionMode("autopilot", false).mode === "ask" && effectivePermissionMode("autopilot", false).downgraded);
check("autopilot kept in a trusted folder", effectivePermissionMode("autopilot", true).mode === "autopilot" && !effectivePermissionMode("autopilot", true).downgraded);
check("ask mode is never downgraded", !effectivePermissionMode("ask", false).downgraded);

// ── stale-branch analysis ────────────────────────────────────────────────────────
const repo = (o: Partial<Parameters<typeof analyzeBranch>[0]>) => ({ ahead: 0, behind: 0, hasUpstream: true, detached: false, isRepo: true, branch: "main", ...o });
check("current branch → not stale", analyzeBranch(repo({})).status === "current" && !analyzeBranch(repo({})).stale);
check("behind → stale + rebase recommendation", (() => { const a = analyzeBranch(repo({ behind: 3 })); return a.status === "behind" && a.stale && /pull --rebase/.test(a.recommendation); })());
check("diverged → stale", analyzeBranch(repo({ ahead: 2, behind: 3 })).status === "diverged" && analyzeBranch(repo({ ahead: 2, behind: 3 })).stale);
check("ahead only → NOT stale", analyzeBranch(repo({ ahead: 4 })).status === "ahead" && !analyzeBranch(repo({ ahead: 4 })).stale);
check("no upstream → not stale", analyzeBranch(repo({ hasUpstream: false })).status === "no-upstream");
check("not a repo → benign", analyzeBranch({ ahead: 0, behind: 0, hasUpstream: false, detached: false, isRepo: false }).status === "not-a-repo");

// porcelain v2 parsing
const v2 = ["# branch.head feature-x", "# branch.upstream origin/feature-x", "# branch.ab +2 -5", "1 .M N...", ""].join("\n");
check("parseStatusV2 reads branch + ahead/behind", (() => { const s = parseStatusV2(v2); return s.branch === "feature-x" && s.ahead === 2 && s.behind === 5 && s.hasUpstream; })());
check("parseStatusV2 detached HEAD", parseStatusV2("# branch.head (detached)").detached);

// readGitState with an injected exec (no real git)
{
  const exec = async (cmd: string) => cmd.includes("rev-parse") ? { code: 0, output: "true\n" } : { code: 0, output: v2 };
  const gs = await readGitState("/x", exec);
  check("readGitState (injected) → behind 5, stale", gs.isRepo && gs.behind === 5 && analyzeBranch(gs).stale);
  const notRepo = await readGitState("/x", async () => ({ code: 128, output: "not a git repository" }));
  check("readGitState outside a repo → isRepo:false", !notRepo.isRepo);
}

if (fail) { console.error("\n✗ policy smoke FAILED"); process.exit(1); }
console.log("\n✓ policy smoke passed");
