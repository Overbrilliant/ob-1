// Deterministic test for the bash-command validation pipeline (no network / no spawn).
// Usage: bun run scripts/bash-validation-smoke.ts
import { classifyIntent, validateBashCommand } from "../src/safety/bash-validation.ts";
import { buildTools, isDestructiveCall } from "../src/agent/tools.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── intent classification ─────────────────────────────────────────────────────
const intent: [string, string][] = [
  ["ls -la", "read-only"],
  ["cat f | grep x | wc -l", "read-only"],
  ["git status", "read-only"],
  ["git log --oneline", "read-only"],
  ["cp a b", "write"],
  ["mkdir -p x/y", "write"],
  ["echo hi > out.txt", "write"],
  ["printf x | tee f", "write"],
  ["git commit -m 'x'", "write"],
  ["git push origin main", "write"],
  ["git push --force-with-lease", "write"],   // safe force → not destructive
  ["curl https://example.com", "network"],
  ["wget http://x/y", "network"],
  ["ssh host 'ls'", "network"],
  ["kill -9 1234", "process"],
  ["pkill node", "process"],
  ["sudo systemctl restart x", "process"],
  ["rm -rf node_modules", "destructive"],
  ["shred -u secret", "destructive"],
  ["git push origin main --force", "destructive"],
  ["git reset --hard HEAD~1", "destructive"],
  ["git clean -fd", "destructive"],
  ["/usr/bin/rm x", "destructive"],            // path-prefixed executable
  ["FOO=bar sudo rm x", "destructive"],        // env + sudo stripped
  ["mkfs.ext4 /dev/sdb", "destructive"],
  ["dd if=/dev/zero of=disk.img", "destructive"],
  ["npm run build && rm -rf dist", "destructive"], // strongest across &&
  [":(){ :|:& };:", "destructive"],            // fork bomb
  ["make", "unknown"],
  ["./configure", "unknown"],
];
for (const [cmd, want] of intent) check(`intent: ${cmd}  → ${want}`, classifyIntent(cmd) === want);

// ── validation pipeline ───────────────────────────────────────────────────────
const isBlock = (c: string, o = {}) => validateBashCommand(c, o).kind === "block";
const isWarn = (c: string, o = {}) => validateBashCommand(c, o).kind === "warn";
const isAllow = (c: string, o = {}) => validateBashCommand(c, o).kind === "allow";

check("block: empty command", isBlock(""));
// plan (read-only) mode
check("plan mode blocks a write command", isBlock("cp a b", { planMode: true }));
check("plan mode blocks rm", isBlock("rm x", { planMode: true }));
check("plan mode ALLOWS a read-only command", isAllow("ls -la", { planMode: true }));
check("act mode allows a write command", isAllow("cp a b", { planMode: false }));

// catastrophic / system-path deletes — blocked even outside plan mode
check("block: rm -rf /", isBlock("rm -rf /"));
check("block: rm -rf ~", isBlock("rm -rf ~"));
check("block: rm -rf $HOME", isBlock("rm -rf $HOME"));
check("block: rm -rf /etc/nginx", isBlock("rm -rf /etc/nginx"));
check("block: dd of=/dev/sda", isBlock("dd if=/dev/zero of=/dev/sda"));
check("block: mkfs", isBlock("mkfs.ext4 /dev/sdb"));
// legitimate-but-dangerous → WARN (runs, but the gate flags it)
check("warn (not block): rm -rf node_modules", isWarn("rm -rf node_modules"));
check("warn (not block): rm -rf dist/build", isWarn("rm -rf dist/build"));
check("warn: git reset --hard", isWarn("git reset --hard HEAD~1"));
check("rm of /tmp scratch is NOT blocked (warn only)", isWarn("rm -rf /tmp/ob1-scratch"));

// sed -i foot-gun (BSD/macOS)
check("warn: sed -i without backup suffix", isWarn("sed -i 's/a/b/' file.txt"));
check("allow: sed -i '' (explicit empty suffix)", isAllow("sed -i '' 's/a/b/' file.txt"));
check("allow: sed -i.bak", isAllow("sed -i.bak 's/a/b/' file.txt"));

// ordinary commands pass clean
check("allow: ls", isAllow("ls -la"));
check("allow: curl", isAllow("curl https://example.com"));
check("allow: git status", isAllow("git status"));
check("allow: npm run build", isAllow("npm run build"));

// ── integration: run_bash blocks catastrophic commands; isDestructiveCall tags semantically ──────
{
  const cfg = { cwd: process.cwd(), planMode: false, permissionMode: "autopilot", sandbox: "off" } as any;
  const tools = buildTools(cfg, {} as any);
  const runBash = tools.get("run_bash")!;
  let threw = "";
  try { await runBash.run({ command: "rm -rf /" }); } catch (e) { threw = (e as Error).message; }
  check("run_bash THROWS (blocks) on a catastrophic command before spawning", /blocked by safety policy/.test(threw));

  // isDestructiveCall now uses the semantic classifier (richer than the old regex).
  check("isDestructiveCall: git reset --hard tagged destructive", isDestructiveCall("run_bash", { command: "git reset --hard" }));
  check("isDestructiveCall: rm -rf node_modules tagged destructive", isDestructiveCall("run_bash", { command: "rm -rf node_modules" }));
  check("isDestructiveCall: plain ls is NOT destructive", !isDestructiveCall("run_bash", { command: "ls -la" }));
  check("isDestructiveCall: non-bash tool is never destructive", !isDestructiveCall("read_file", { path: "x" }));
}

if (fail) { console.error("\n✗ bash-validation smoke FAILED"); process.exit(1); }
console.log("\n✓ bash-validation smoke passed");
