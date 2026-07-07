// Deterministic test for Fusion git-worktree real-test scoring (no API key). Spins up a throwaway
// git repo with a wrong stub + a real bun:test, then verifies candidates are applied to their own
// worktrees at HEAD, graded by REAL test execution (not isolated syntax checks), the judge is fed
// the real test output/diff, and every worktree is cleaned up.
// Usage: bun run scripts/fusion-worktree-smoke.ts
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCandidateFile, scoreCandidate, runFusion } from "../src/multimind/fusion.ts";
import { sandboxAvailable } from "../src/safety/sandbox.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { WorkerResult } from "../src/multimind/runtime.ts";

let fail = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail = true; };

// --- extractCandidateFile: target-path resolution ---
const a = extractCandidateFile("```ts sum.ts\nexport const add = (a,b)=>a+b;\n```");
check("path from fence info string", a.path === "sum.ts" && a.code.includes("add") && a.lang === "ts");
const b = extractCandidateFile("```ts\n// file: sum.ts\nexport const add = (a,b)=>a+b;\n```");
check("path from `// file:` comment (stripped from code)", b.path === "sum.ts" && !b.code.includes("file:"));
const none = extractCandidateFile("```ts\nexport const add = (a,b)=>a+b;\n```");
check("no path → undefined", none.path === undefined && none.code.includes("add"));

// --- throwaway git repo: wrong stub + a real test that asserts add(2,3)===5 ---
const repo = mkdtempSync(join(tmpdir(), "ob1-wt-"));
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=ob1@test", "-c", "user.name=ob1", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
git("init", "-q");
writeFileSync(join(repo, ".gitignore"), ".ob1/\n");
writeFileSync(join(repo, "sum.ts"), "export const add = (a: number, b: number) => 0;\n"); // wrong stub
writeFileSync(join(repo, "sum.test.ts"), `import { test, expect } from "bun:test";\nimport { add } from "./sum.ts";\ntest("adds", () => { expect(add(2, 3)).toBe(5); });\n`);
git("add", "-A");
git("commit", "-qm", "init");

const cfg: Config = { ...loadConfig(), cwd: repo, dataDir: join(repo, ".ob1"), sandbox: "off" };
const testCmd = "bun test";
const GOOD = "export const add = (a: number, b: number) => a + b;";
const BAD = "export const add = (a: number, b: number) => a * b;"; // 2*3=6 ≠ 5 → fails the real test

// --- direct scoreCandidate worktree scoring ---
const goodScore = await scoreCandidate(GOOD, { cwd: repo, worktree: { cfg, testCmd, targetPath: "sum.ts" } });
check("worktree: correct candidate PASSES the real test", goodScore.ok && goodScore.checked);
check("worktree: captures real test output", !!goodScore.testOutput && goodScore.testOutput.length > 0);
check("worktree: captures the diff vs HEAD", !!goodScore.diff && goodScore.diff.includes("a + b"));
const badScore = await scoreCandidate(BAD, { cwd: repo, worktree: { cfg, testCmd, targetPath: "sum.ts" } });
check("worktree: wrong candidate FAILS the real test", !badScore.ok && badScore.checked);

// --- security: candidate-controlled targetPath must not escape the worktree, and must not write ---
const evilAbs = join(tmpdir(), `ob1-evil-${process.pid}.ts`);
const absEscape = await scoreCandidate("export const x = 1;", { cwd: repo, worktree: { cfg, testCmd, targetPath: evilAbs } });
check("security: absolute targetPath rejected", !absEscape.ok && absEscape.checked === false && /unsafe/.test(absEscape.output));
check("security: absolute targetPath not written", !existsSync(evilAbs));
const relEscape = await scoreCandidate("export const x = 1;", { cwd: repo, worktree: { cfg, testCmd, targetPath: "../../../../escape.ts" } });
check("security: traversal targetPath rejected", !relEscape.ok && relEscape.checked === false && /unsafe/.test(relEscape.output));
// committed symlink in HEAD must not let the write escape via a symlinked directory (lexical check alone misses this)
const linkTarget = mkdtempSync(join(tmpdir(), "ob1-symtgt-"));
symlinkSync(linkTarget, join(repo, "linkdir"), "dir");
git("add", "-A"); git("commit", "-qm", "add symlink");
const symEscape = await scoreCandidate("export const x = 1;", { cwd: repo, worktree: { cfg, testCmd, targetPath: "linkdir/evil.ts" } });
check("security: symlinked-dir target rejected", !symEscape.ok && symEscape.checked === false && /unsafe/.test(symEscape.output));
check("security: symlink escape not written", !existsSync(join(linkTarget, "evil.ts")));
rmSync(linkTarget, { recursive: true, force: true });

// --- diff captures NEW files (nested dir created), not just modifications ---
const newFile = await scoreCandidate("export const z = 42;", { cwd: repo, worktree: { cfg, testCmd: "true", targetPath: "lib/newmod.ts" } });
check("worktree: NEW-file diff captured", !!newFile.diff && newFile.diff.includes("newmod.ts") && newFile.diff.includes("42"));

// --- sandboxed worktree test can write the shared .git metadata (git-touching tests don't spuriously fail) ---
if (sandboxAvailable()) {
  const cfgSb: Config = { ...cfg, sandbox: "workspace-write" };
  const gitWrite = await scoreCandidate(GOOD, { cwd: repo, worktree: { cfg: cfgSb, testCmd: "git add -A", targetPath: "sum.ts" } });
  check("sandbox: git-writing test succeeds in worktree (shared .git writable)", gitWrite.ok && gitWrite.checked);
} else {
  console.log("• (skipped sandboxed git-write check — no usable sandbox backend on this host)");
}

const wtCount = () => new TextDecoder().decode(Bun.spawnSync(["git", "worktree", "list"], { cwd: repo, stdout: "pipe" }).stdout).trim().split("\n").filter(Boolean).length;
check("worktree: candidate worktrees cleaned up", wtCount() === 1);

// --- runFusion end-to-end with explicit worktree-at-HEAD scoring (injected runner) → SELECTION-FIRST ---
const block = (code: string) => "```ts sum.ts\n" + code + "\n```";
const W = (label: string, text: string): WorkerResult => ({ label, text, inputTokens: 1, outputTokens: 1, ok: true });
const labels: string[] = [];
const f = await runFusion({
  task: "fix add", cfg, tools: new Map(), worktree: true, testCmd, targetPath: "sum.ts",
  _run: (async (o: { label: string }) => {
    labels.push(o.label);
    return W(o.label, block(o.label === "cand-1" ? GOOD : BAD));
  }) as any,
});
check("F-wt: candidates graded by real tests (≥1 pass, ≥1 fail)", f.candidates.some((x) => x.score?.ok) && f.candidates.some((x) => x.score && !x.score.ok));
check("F-wt: the passing candidate is SELECTED verbatim (no merge)", f.selected?.label === "cand-1" && f.synthesis.includes("a + b") && !f.failing);
check("F-wt: no synthesizer call on the passing path", !labels.includes("synthesizer"));
check("F-wt: signal tier reported (worktree-tests)", f.signalTier === "worktree-tests");
check("F-wt: all worktrees cleaned up after full run", wtCount() === 1);

// --- worktree mode + a path-less candidate and no OB1_FUSION_TARGET → UNSCORED, not syntax-graded ---
const fNoPath = await runFusion({
  task: "x", cfg, tools: new Map(), worktree: true, // no targetPath, candidates emit no fence path
  _run: (async (o: { label: string }) => W(o.label, "```ts\nexport const q = 1;\n```")) as any,
});
check("F-wt: path-less candidates → UNSCORED (no silent syntax downgrade)", fNoPath.candidates.every((x) => x.score && x.score.checked === false));
check("F-wt: path-less worktrees cleaned up", wtCount() === 1);

// --- COPY-CHECKS tier: mkTools wired → each candidate gets a private copy graded by the REAL suite in it.
// Injected workers don't edit the copy, so the wrong HEAD stub fails the suite → all FAIL → synth fallback.
const fCopy = await runFusion({
  task: "fix add", cfg, tools: new Map(), mkTools: () => new Map(),
  _run: (async (o: { label: string }) => W(o.label, block(o.label === "synthesizer" ? GOOD : BAD))) as any,
});
check("F-wt: copy-checks tier used when mkTools wired", fCopy.signalTier === "copy-checks");
check("F-wt: candidates graded in their copies (all FAIL on the HEAD stub)", fCopy.candidates.length === 3 && fCopy.candidates.every((x) => x.score?.checked && !x.score.ok));
check("F-wt: 0 passing → synthesizer merge fallback", fCopy.selected === undefined);
check("F-wt: copy-check worktrees cleaned up", wtCount() === 1);

rmSync(repo, { recursive: true, force: true });

if (fail) { console.error("\n✗ fusion-worktree smoke FAILED"); process.exit(1); }
console.log("\n✓ fusion-worktree smoke passed (real test scoring + new-file diff + path-traversal guard + sandboxed .git + UNSCORED fallback + cleanup)");
process.exit(0);
