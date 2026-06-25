// Deterministic test (no API key) for /rewind checkpointing (src/agent/checkpoint.ts). Proves the shadow
// git store snapshots and reverts the WHOLE worktree — creations, modifications, deletions, and bash-style
// changes — across both non-git and git projects, while NEVER touching the user's real repo, respecting
// .gitignore, and excluding the OB-1 data dir. Also checks the conversation-truncation contract.
// Usage: bun run scripts/rewind-smoke.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../src/agent/checkpoint.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

const mkproj = () => {
  const cwd = mkdtempSync(join(tmpdir(), "ob1-rewind-"));
  return { cwd, dataDir: join(cwd, ".ob1") };
};
const W = (cwd: string, p: string, s: string) => { mkdirSync(join(cwd, p, ".."), { recursive: true }); writeFileSync(join(cwd, p), s); };
const R = (cwd: string, p: string) => { try { return readFileSync(join(cwd, p), "utf8"); } catch { return null; } };
const git = (cwd: string, args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const gitOut = (cwd: string, args: string[]) => new TextDecoder().decode(git(cwd, args).stdout).trim();

// ─── 1. snapshot/restore round-trip in a NON-git project (create / modify / delete) ───────────────────
{
  const env = mkproj();
  const store = new CheckpointStore(env, "sess-A");
  check("git is available", store.available());

  W(env.cwd, "a.txt", "v1");
  const p1 = store.snapshot("first prompt", 0)!;
  check("snapshot returns a checkpoint (id+sha+label)", !!p1 && !!p1.sha && p1.label === "first prompt" && p1.historyLen === 0);

  W(env.cwd, "a.txt", "v2");
  W(env.cwd, "b.txt", "new file");
  const p2 = store.snapshot("second prompt", 2)!;

  // diverge: modify a, delete b, add c — the "current" dirty state
  W(env.cwd, "a.txt", "v3-dirty");
  rmSync(join(env.cwd, "b.txt"));
  W(env.cwd, "c.txt", "added after p2");
  check("changeCount sees pending changes vs p1", store.changeCount(p1.sha) > 0);

  // restore to p1: a back to v1, b absent (didn't exist at p1), c removed (created after p1)
  check("restoreCode(p1) succeeds", store.restoreCode(p1.sha));
  check("p1 restore: a.txt reverted to v1", R(env.cwd, "a.txt") === "v1");
  check("p1 restore: b.txt absent (never existed at p1)", !existsSync(join(env.cwd, "b.txt")));
  check("p1 restore: c.txt removed (created after p1)", !existsSync(join(env.cwd, "c.txt")));

  // restore forward to p2: a=v2, b restored, c still gone
  check("restoreCode(p2) succeeds (forward rewind to a now-unreachable commit)", store.restoreCode(p2.sha));
  check("p2 restore: a.txt = v2", R(env.cwd, "a.txt") === "v2");
  check("p2 restore: b.txt restored", R(env.cwd, "b.txt") === "new file");
  check("p2 restore: c.txt still absent", !existsSync(join(env.cwd, "c.txt")));

  // list: oldest→newest, labels + historyLen preserved
  const list = store.list();
  check("list returns both checkpoints oldest→newest", list.length === 2 && list[0].label === "first prompt" && list[1].label === "second prompt");
  check("list preserves historyLen", list[0].historyLen === 0 && list[1].historyLen === 2);
  check("has() true for a real sha, false for a bogus one", store.has(p1.sha) && !store.has("deadbeef".repeat(5)));

  rmSync(env.cwd, { recursive: true, force: true });
}

// ─── 2. allow-empty: a prompt that changes nothing still yields a distinct checkpoint ─────────────────
{
  const env = mkproj();
  const store = new CheckpointStore(env, "sess-E");
  W(env.cwd, "x.txt", "same");
  const e1 = store.snapshot("p-a", 0)!;
  const e2 = store.snapshot("p-b", 1)!; // no file change between them
  check("empty-diff prompts still create separate checkpoints", !!e1 && !!e2 && e1.sha !== e2.sha && store.list().length === 2);
  rmSync(env.cwd, { recursive: true, force: true });
}

// ─── 3. .gitignore respected + OB-1 data dir excluded (restore must not nuke node_modules / .ob1) ─────
{
  const env = mkproj();
  const store = new CheckpointStore(env, "sess-G");
  W(env.cwd, ".gitignore", "node_modules/\n");
  W(env.cwd, "src.txt", "code v1");
  W(env.cwd, "node_modules/dep.txt", "dependency");
  store.snapshot("p1", 0); // ensureInit writes the data-dir exclude; node_modules ignored by .gitignore
  // mutate an ignored file, a data-dir file, and a tracked file
  W(env.cwd, "node_modules/dep.txt", "dependency CHANGED");
  W(env.cwd, ".ob1/scratch.txt", "ob1 internal");
  W(env.cwd, "src.txt", "code v2-dirty");
  const p2 = store.snapshot("p2", 1)!;
  // change src again then restore to p2
  W(env.cwd, "src.txt", "code v3");
  store.restoreCode(p2.sha);
  check("ignored node_modules file is NOT reverted by restore", R(env.cwd, "node_modules/dep.txt") === "dependency CHANGED");
  check("OB-1 data dir is excluded from snapshots (not reverted)", R(env.cwd, ".ob1/scratch.txt") === "ob1 internal");
  check("tracked file IS reverted to the snapshot", R(env.cwd, "src.txt") === "code v2-dirty");
  rmSync(env.cwd, { recursive: true, force: true });
}

// ─── 4. the user's REAL git repo is never touched (no commits/branch/HEAD changes) ────────────────────
{
  const env = mkproj();
  git(env.cwd, ["init", "-q", "-b", "main"]);
  W(env.cwd, "tracked.txt", "real v1");
  git(env.cwd, ["add", "-A"]);
  git(env.cwd, ["commit", "-q", "-m", "real initial"]);
  const headBefore = gitOut(env.cwd, ["rev-parse", "HEAD"]);
  const branchBefore = gitOut(env.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const countBefore = gitOut(env.cwd, ["rev-list", "--count", "HEAD"]);

  const store = new CheckpointStore(env, "sess-R");
  store.snapshot("p1", 0);
  W(env.cwd, "tracked.txt", "real v2");
  W(env.cwd, "untracked.txt", "scratch");
  store.snapshot("p2", 1);
  W(env.cwd, "tracked.txt", "real v3");
  store.restoreCode(store.list()[0].sha); // revert worktree to p1

  check("real repo HEAD unchanged (no commits made to it)", gitOut(env.cwd, ["rev-parse", "HEAD"]) === headBefore);
  check("real repo branch unchanged", gitOut(env.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) === branchBefore);
  check("real repo commit count unchanged", gitOut(env.cwd, ["rev-list", "--count", "HEAD"]) === countBefore);
  check("restore still reverted the worktree (tracked.txt back to v1)", R(env.cwd, "tracked.txt") === "real v1");
  rmSync(env.cwd, { recursive: true, force: true });
}

// ─── 5. conversation-truncation contract (what index.ts does on a conversation rewind) ────────────────
{
  // The store records historyLen (messages BEFORE that prompt); the caller truncates history to it.
  const env = mkproj();
  const store = new CheckpointStore(env, "sess-C");
  const ck = store.snapshot("third prompt", 4)!;
  const history = [1, 2, 3, 4, 5, 6]; // 6 messages accumulated since
  if (ck.historyLen <= history.length) history.length = ck.historyLen;
  check("conversation restore truncates history to the checkpoint's length", history.length === 4 && history.join(",") === "1,2,3,4");
  rmSync(env.cwd, { recursive: true, force: true });
}

if (fail) { console.error("\n✗ rewind smoke FAILED"); process.exit(1); }
console.log("\n✓ rewind smoke passed (worktree snapshot/restore: create/modify/delete + forward · allow-empty · .gitignore/data-dir excluded · real repo untouched · conversation truncation)");
