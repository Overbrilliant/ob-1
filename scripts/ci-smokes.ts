// Aggregate runner for the DETERMINISTIC smoke suite — every test that needs no API key, no
// network, and no special host. Runs each in its own process, prints a one-line verdict, dumps
// output only for failures, and exits non-zero if any fail. Single source of truth for "the suite"
// (used by CI and locally: `bun run scripts/ci-smokes.ts`).
//
// Intentionally EXCLUDED (they run as separate opt-in steps — network / Linux / secrets):
//   • mcp-interop.ts      — LIVE: needs npx + network (official reference server)
//   • bwrap-enforce.ts    — LIVE: Linux + bubblewrap only
//   • mcp-github-live.ts   — LIVE: needs a real GitHub token (authenticated cloud server)
//   • web-live.ts         — LIVE: needs OB1_SEARXNG_URL/KEY (real SearXNG endpoint)
//   • eval.ts, _mode_pages.ts — spend real tokens (need a provider key)
//   • mock-mcp-server.ts  — a helper used BY mcp-smoke, not a test itself
import { dirname, join } from "node:path";

const SMOKES = [
  "smoke.ts",                 // memory engine + semantic search
  "memory-vec-smoke.ts",      // sqlite-vec KNN index (+ cosine parity / fallback)
  "memory-session-smoke.ts",  // cross-SESSION persistence (separate processes) + robustness + corrupt-db recovery
  "memory-export-smoke.ts",   // /memory export: DOT + self-contained HTML (dashed invalidated edges)
  "memory-rank-smoke.ts",     // weighted retrieval: recency/importance/relevance min-max re-rank + back-compat
  "memory-evolve-smoke.ts",   // LLM-managed evolution: ADD/UPDATE/DELETE/NOOP + id-validation + ADD-on-failure
  "memory-reflect-smoke.ts",  // reflection trees: threshold trigger + grounded distillation + derived_from + depth cap
  "mcp-smoke.ts",             // stdio MCP client + deferred tool loading
  "mcp-http-smoke.ts",        // http/sse transport factory + session id (local mocks)
  "mcp-auth-smoke.ts",        // authed http/sse: bearer + custom headers + 401 + session replay
  "sandbox-smoke.ts",         // sandbox argv construction (bwrap + Seatbelt)
  "bash-validation-smoke.ts", // bash command intent classifier + block/warn/allow pipeline + run_bash guard
  "config-validate-smoke.ts", // settings schema validation: drop invalid fields, warn on unknown keys
  "cli-flags-smoke.ts",       // package-manager flags: --version / --help exit before interactive startup
  "update-smoke.ts",          // non-blocking update-check comparison + registry parsing (mocked fetch)
  "claims-smoke.ts",          // structured claim/report schema: typing + hash dedupe + projection + render
  "green-contract-smoke.ts",  // graduated green contract: level→kinds + pass/fail + known-flake tolerance
  "task-quality-smoke.ts",    // task quality profile + evidence ledger + scenario scoring
  "recovery-smoke.ts",        // recovery recipes: failure classification + recipes + attempt-budget ledger
  "policy-smoke.ts",          // policy engine + folder trust + stale-branch detection
  "approval-tokens-smoke.ts", // capability approval tokens: /allow scopes + cover/consume + finite/revoke
  "hooks-smoke.ts",           // programmable hooks: Pre/Post/PostFailure matching + block/allow/feedback
  "lsp-smoke.ts",             // LSP diagnostics: message framing + client flow vs a mock server + fallback
  "parity-harness-smoke.ts",  // mock-provider parity: scripted scenarios drive runTurn + assert wire behavior
  "escalation-smoke.ts",      // verified escalation: self-fix budget spent → { escalate } + report; off/plan/apply-turn never escalate
  "reviewer-smoke.ts",        // refute-reviewer: findings/NONE/garbled parse + read-only worker wiring + model choice + diff bounding
  "fusion-smoke.ts",          // fusion best-of-N + synthesizer + verify-revert
  "fusion-worktree-smoke.ts", // fusion real git-worktree test scoring
  "deep-smoke.ts",            // deep AB-MCTS-lite: Thompson widen-vs-deepen + verified early-stop + ESC partial
  "worker-write-smoke.ts",    // write-capable fusion workers (gated mutating tools) + workspace-copy isolation
  "rewind-smoke.ts",          // /rewind shadow-git checkpoints: worktree snapshot/restore + real-repo isolation
  "retry-smoke.ts",           // gateway upstream-error retry/backoff + isRetryable classification
  "eval-smoke.ts",            // eval objective checks + Solo@k math
  "ctx-smoke.ts",             // context eviction + LLM-summary compaction
  "token-optim-smoke.ts",     // token optimization: clampOutput head+tail + read-dedup ReadCache + read_file pointer
  "edit-smoke.ts",            // edit-apply (exact / flexible / ambiguity)
  "codeact-smoke.ts",         // code-as-action: parse (last-block) + observation + loop + gate + loop-guard
  "architect-smoke.ts",       // architect/editor two-model edits: prompts + search-replace parse + pipeline + apply
  "provider-smoke.ts",        // provider translation + token caps + cache_control + vision/image translation
  "vision-smoke.ts",          // vision path: tool {text,images} → tool_result blocks → provider wire, vision-gated
  "multimind-smoke.ts",       // multi-mind runtime (read-only filter + parallel order)
  "skills-smoke.ts",          // skills registry discovery + lazy-load
  "skill-learn-smoke.ts",     // self-learned skills: manage_skill write/patch/delete + provenance + protection + archived
  "skill-distill-smoke.ts",   // auto skill learning: substance gate + decision parse + create/refine via stub brain + guardrails
  "skill-curator-smoke.ts",   // skill usage telemetry (.usage.json) + curator aging active→stale→archived + reactivate-on-use
  "web-smoke.ts",             // web_search (SearXNG) + web_fetch: url/format, html→text, auth/HTTP errors, conditional registration
  "tui-smoke.tsx",            // Ink TUI components (in-memory, ink-testing-library)
  "slash-menu-smoke.ts",      // every /help command is reachable from the TUI slash menu (guards /rewind etc.)
  "error-format-smoke.ts",    // human-readable errors: API <status>:{json} → friendly title + action link + retry-only-when-useful
  "ask-smoke.ts",             // ask_user clarification tool (registration + request normalization)
  "delivery-smoke.ts",        // delivery surface: execute_sql (real SQLite) + secrets + create_pr/pr_checks + expose_port
  "delivery-e2e-smoke.ts",    // delivery surface DRIVEN THROUGH runTurn: sql/secret/pr tool roundtrips + no secret leak + prompt guidance
  "workspace-boundary-smoke.ts", // security: symlink/cwd containment + secret env propagation & redaction + read_file truncation marker + dup-bg guard
  "procs-smoke.ts",           // run_bash process registry (footer + ⌃P kill manager)
  "procs-reap-smoke.ts",      // background procs reaped on harness exit/signal: reapAll + detached group-kill (subtree) + e2e SIGTERM
  "subagents-smoke.ts",       // spawn_subagents: registry + runSubagents parallel/cap + runTurn integration
  "subagents-write-smoke.ts", // write-subagents (real git): partition refusal + worktree merge + conflict abort + gated apply
  "todo-smoke.ts",            // update_tasks tool + TodoRegistry (task list above the input)
  "topics-smoke.ts",          // on-demand topic files
  "agent-memory-smoke.ts",    // AGENTS.md managed blocks + episode capture + review/promote pipeline
  "tool-ux-smoke.ts",         // friendly tool failures that steer recovery instead of loops/rewrites
  "treesitter-smoke.ts",      // tree-sitter repo-map symbol extraction (+ regex fallback)
  "compiled-startup-smoke.ts",// standalone binary startup: no runtime node_modules assets required
  "git-exclude-smoke.ts",     // startup excludes .ob1/ from repo-local git status without touching .gitignore
  "settings-persist-smoke.ts",// settings persistence (.ob1/settings.json round-trip + precedence + freellmapi→free migration)
  "auth-route-smoke.ts",      // managed-server routing: token precedence + /v1 + web_search bearer/402/401
  "free-router-smoke.ts",     // embedded free-models router: keys/registry/routing/failover + freellmapi→free settings migration
  "onboarding-smoke.ts",      // first-run onboarding gate + provider-choice routing + 'seen' marker
  "verify-smoke.ts",          // self-verification: detect checks + runVerification + auto self-fix loop
  "browser-check-smoke.ts",   // headless-browser behavioral verification: working vs inert toggle + page-error/unreachable
  "usage-smoke.ts",           // persistent usage analytics (/usage): append/aggregate + cache-aware cost
];

const dir = dirname(Bun.fileURLToPath(import.meta.url));
const failed: string[] = [];

for (const s of SMOKES) {
  const t0 = performance.now();
  const p = Bun.spawnSync(["bun", "run", join(dir, s)], { stdout: "pipe", stderr: "pipe" });
  const ok = (p.exitCode ?? 1) === 0;
  console.log(`${ok ? "✓" : "✗"} ${s.padEnd(26)} ${Math.round(performance.now() - t0)}ms`);
  if (!ok) {
    failed.push(s);
    process.stdout.write(new TextDecoder().decode(p.stdout));
    process.stderr.write(new TextDecoder().decode(p.stderr));
  }
}

console.log("");
if (failed.length) {
  console.error(`✗ ${failed.length}/${SMOKES.length} smoke(s) FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`✓ all ${SMOKES.length} deterministic smokes passed`);
process.exit(0);
