// Deterministic test for the token-optimization primitives (no API key / no network):
//   • clampOutput   — head+tail truncation that preserves the TAIL (where test/build errors land),
//                     unlike the old head-only slice. Token-neutral, strictly better signal.
//   • ReadCache     — per-turn read-dedup fingerprinting (hit/note/clear).
//   • read_file     — returns a pointer (not the bytes) on a re-read of identical content, full
//                     content after a change or a cache clear, and never dedups tiny files.
// Usage: bun run scripts/token-optim-smoke.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { relative } from "node:path";
import { join } from "node:path";
import { buildTools, clampOutput, ReadCache } from "../src/agent/tools.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── clampOutput ────────────────────────────────────────────────────────────────
check("clampOutput: under budget is returned verbatim", clampOutput("short output", 20_000) === "short output");
check("clampOutput: at exactly the budget is untouched", clampOutput("x".repeat(100), 100) === "x".repeat(100));

const head = "HEAD-START " + "h".repeat(5_000);
const tail = "t".repeat(5_000) + " TAIL-ERROR: assertion failed";
const big = head + "m".repeat(40_000) + tail; // ~50k, well over a 20k budget
const clamped = clampOutput(big, 20_000);
check("clampOutput: result fits the budget", clamped.length <= 20_000);
check("clampOutput: keeps the HEAD (command/setup context)", clamped.startsWith("HEAD-START "));
check("clampOutput: keeps the TAIL (where the error/verdict lands)", clamped.endsWith("TAIL-ERROR: assertion failed"));
check("clampOutput: inserts an elision marker for the dropped middle", /…\[\d+ chars elided to fit the output budget\]…/.test(clamped));
check("clampOutput: drops the middle (no longer present)", !clamped.includes("m".repeat(40_000)));
check("clampOutput: tail share is larger than head share (errors land at the end)",
  (() => { const i = clamped.indexOf("…["); const j = clamped.indexOf("]…") + 2; return clamped.slice(j).length > clamped.slice(0, i).length; })());
// Regression: the OLD behavior was `s.slice(0, max)` which would have dropped the TAIL entirely.
check("clampOutput: REGRESSION — old head-only slice would have lost the error; clampOutput keeps it",
  !big.slice(0, 20_000).includes("TAIL-ERROR") && clamped.includes("TAIL-ERROR"));

// ── ReadCache ────────────────────────────────────────────────────────────────
const rc = new ReadCache();
const body = "a".repeat(1_000);
check("ReadCache: miss before note", rc.hit("/x", body) === false);
rc.note("/x", body);
check("ReadCache: hit after note (identical content)", rc.hit("/x", body) === true);
check("ReadCache: miss when content changes (same path)", rc.hit("/x", body + "!") === false);
check("ReadCache: miss for a length-only difference", rc.hit("/x", "a".repeat(999)) === false);
check("ReadCache: different path is independent", rc.hit("/y", body) === false);
rc.clear();
check("ReadCache: clear() drops all entries", rc.hit("/x", body) === false);

// ── read_file dedup integration ──────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "ob1-tokenopt-"));
try {
  const cfg = { cwd: dir } as any;
  const store = {} as any;
  const cache = new ReadCache();
  const tools = buildTools(cfg, store, undefined, undefined, undefined, cache);
  const read = tools.get("read_file")!;

  const bigContent = "line of content\n".repeat(500); // ~8k chars, well over MIN_DEDUP_CHARS
  writeFileSync(join(dir, "f.txt"), bigContent);

  const first = await read.run({ path: "f.txt" });
  check("read_file: first read returns full content", first === bigContent);
  const second = await read.run({ path: "f.txt" });
  check("read_file: identical re-read returns a pointer, not the bytes", second !== bigContent && /unchanged since it was read earlier this turn/.test(String(second)));
  check("read_file: pointer is far smaller than the content (real token saving)", String(second).length < bigContent.length / 10);

  // After a real change, the model must get the new bytes (quality preserved).
  const changed = bigContent + "NEW TAIL LINE\n";
  writeFileSync(join(dir, "f.txt"), changed);
  const third = await read.run({ path: "f.txt" });
  check("read_file: re-read after a change returns full (new) content", third === changed);

  // A cache clear (turn boundary / eviction) forces full content again — the provable-safety path.
  cache.clear();
  const fourth = await read.run({ path: "f.txt" });
  check("read_file: read after cache clear returns full content (no dangling pointer)", fourth === changed);

  // Tiny files are never deduped (not worth a pointer).
  writeFileSync(join(dir, "small.txt"), "tiny");
  await read.run({ path: "small.txt" });
  const smallAgain = await read.run({ path: "small.txt" });
  check("read_file: tiny files (< MIN_DEDUP_CHARS) are never deduped", smallAgain === "tiny");

  // ── range reads (offset/limit) — read only the slice you need ──────────────
  // Lines are padded so a small window still exceeds MIN_DEDUP_CHARS (so dedup applies).
  cache.clear();
  const numbered = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ` + "x".repeat(40)).join("\n");
  writeFileSync(join(dir, "n.txt"), numbered);
  const slice = String(await read.run({ path: "n.txt", offset: 10, limit: 6 }));
  check("read_file: offset/limit returns ONLY the requested line window",
    slice.startsWith("line 10 ") && slice.includes("line 15 ") && !slice.includes("line 16 ") && !slice.includes("\nline 9 "));
  check("read_file: ranged read annotates the line window it returned", /lines 10-15 of 100/.test(slice));
  const whole = String(await read.run({ path: "n.txt" }));
  check("read_file: a full read after a ranged read is NOT mistaken for a dedup hit (distinct keys)",
    whole.startsWith("line 1 ") && whole.includes("line 100 "));
  const sliceAgain = String(await read.run({ path: "n.txt", offset: 10, limit: 6 }));
  check("read_file: an identical ranged re-read IS deduped to a pointer",
    /unchanged since it was read earlier this turn/.test(sliceAgain));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── read_file path resolution (safePath): the path forms a model actually produces ────────────────
// Regression for "subagents fail": when paths can't resolve, a worker burns its whole step budget
// guessing forms that ENOENT. safePath must accept bare-relative, absolute-inside, and ~home-relative
// paths, and reject escapes / not-found with an ACTIONABLE error that names the workspace root.
// The workspace lives under $HOME so a ~/…/<workspace>/file form genuinely lands inside it.
const hdir = mkdtempSync(join(homedir(), ".ob1-pathtest-"));
try {
  const tools = buildTools({ cwd: hdir } as any, {} as any, undefined, undefined, undefined, new ReadCache());
  const read = tools.get("read_file")!;
  writeFileSync(join(hdir, "a.txt"), "hello");
  const tildePath = "~/" + relative(homedir(), join(hdir, "a.txt")); // e.g. ~/.ob1-pathtest-xyz/a.txt
  check("read_file: bare-relative path resolves", (await read.run({ path: "a.txt" })) === "hello");
  check("read_file: absolute-inside-workspace path resolves", (await read.run({ path: join(hdir, "a.txt") })) === "hello");
  check("read_file: ~home-relative path is expanded (lands inside the workspace)", (await read.run({ path: tildePath })) === "hello");
  // run() throws SYNCHRONOUSLY on a bad path (safePath runs before any await), so catch around the call.
  const errOf = async (fn: () => unknown): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };
  const escaped = await errOf(() => read.run({ path: "/etc/hosts" }));
  check("read_file: an outside path is rejected with the workspace root in the message",
    /outside the workspace/.test(escaped) && escaped.includes(hdir));
  const missing = await errOf(() => read.run({ path: "nope/missing.ts" }));
  check("read_file: a not-found path errors actionably (names the root + relative form)",
    /no such file/.test(missing) && missing.includes(hdir));
} finally {
  rmSync(hdir, { recursive: true, force: true });
}

console.log("");
if (fail) { console.error("✗ token-optim smoke FAILED"); process.exit(1); }
console.log("✓ token-optim smoke passed");
