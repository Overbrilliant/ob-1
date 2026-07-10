// Bash command validation pipeline (parity with claw-code's BashTool validation).
//
// Before a shell command runs we classify its INTENT and run a small pipeline of checks:
//   • commandSemantics    — classify the strongest intent across the whole pipeline
//   • modeValidation      — block state-changing commands in read-only (plan) mode
//   • pathValidation      — refuse catastrophic writes to SYSTEM paths (/, /etc, ~, /dev/sd*, …)
//   • destructiveWarning  — flag dangerous-but-legitimate destructive commands for the approval gate
//   • sedValidation       — catch the BSD `sed -i` foot-gun (needs an explicit backup suffix on macOS)
//
// Pure + dependency-free so it is exhaustively unit-testable; the loop/tool layer decides what to do
// with a Block (don't run) / Warn (tag the approval prompt) / Allow.
import type { SandboxMode } from "../config.ts";

/** The strongest thing a command line does. Ordered by severity for `max`-style merging. */
export type CommandIntent = "read-only" | "network" | "write" | "process" | "destructive" | "unknown";

const INTENT_RANK: Record<CommandIntent, number> = {
  "read-only": 0, unknown: 1, network: 2, write: 3, process: 4, destructive: 5,
};

export type ValidationResult =
  | { kind: "allow" }
  | { kind: "warn"; message: string }
  | { kind: "block"; reason: string };

// Leading-executable → intent. Only the FIRST token of each pipeline segment is classified by name;
// redirections and a few inline operators are handled separately in classifyIntent.
const READ_ONLY = new Set(["ls", "cat", "bat", "grep", "rg", "ag", "find", "fd", "head", "tail", "less", "more", "wc", "sort", "uniq", "cut", "tr", "awk", "echo", "printf", "pwd", "cd", "which", "type", "file", "stat", "du", "df", "date", "whoami", "id", "env", "printenv", "basename", "dirname", "realpath", "true", "false", "test", "diff", "cmp", "md5", "sha256sum", "jq", "yq", "tree", "column", "tee?"]);
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "ping", "dig", "nslookup", "host"]);
const PROCESS = new Set(["kill", "pkill", "killall", "systemctl", "service", "launchctl", "reboot", "shutdown", "halt", "poweroff"]);
const WRITE = new Set(["cp", "mv", "mkdir", "rmdir", "touch", "tee", "ln", "chmod", "chown", "chgrp", "install", "patch", "git"]);
const DESTRUCTIVE = new Set(["rm", "shred", "srm", "mkfs", "dd", "fdisk", "parted", "wipefs", "format"]);

/** Strip leading `sudo`/`env VAR=…`/timeout wrappers and return the real leading token of a segment. */
function leadingToken(segment: string): { tok: string; rest: string } {
  let s = segment.trim();
  // drop env assignments (FOO=bar baz) and common wrappers
  for (;;) {
    const m = s.match(/^([A-Za-z_][\w]*=\S*|sudo|command|nohup|time|nice|exec)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  const tok = s.split(/\s+/, 1)[0] ?? "";
  // strip a path prefix (/usr/bin/rm → rm)
  const base = tok.includes("/") ? tok.slice(tok.lastIndexOf("/") + 1) : tok;
  return { tok: base, rest: s.slice(tok.length) };
}

/** Classify the STRONGEST intent across a whole command line (split on pipes/&&/||/;). */
export function classifyIntent(command: string): CommandIntent {
  const cmd = String(command ?? "");
  // Start at the LEAST severe so a benign command stays read-only; each segment can only raise severity.
  let worst: CommandIntent = "read-only";
  const bump = (i: CommandIntent) => { if (INTENT_RANK[i] > INTENT_RANK[worst]) worst = i; };
  // A FILE redirection anywhere is at least a write — but fd-duplication (`2>&1`, `>&2`) writes nothing,
  // so strip those first or every `… 2>&1` (extremely common, incl. read-only commands) is misflagged a
  // write and hard-blocked in plan mode. The `&>file` / `&>>file` both-stream forms ARE file writes and
  // are matched separately (the main regex skips a `>` preceded by `&`).
  const redir = cmd.replace(/\d*>&\d*/g, "");
  if (/(^|[^>&])>>?\s*\S/.test(redir) || /&>>?\s*[^&\s]/.test(cmd) || /\btee\b/.test(cmd)) bump("write");
  // Fork-bomb / truncation idioms.
  if (/:\s*\(\s*\)\s*\{|\b:\(\)\{/.test(cmd) || /\bDROP\s+TABLE\b/i.test(cmd)) bump("destructive");
  for (const seg of cmd.split(/\|\||&&|;|\||\n/)) {
    if (!seg.trim()) continue;
    const { tok, rest } = leadingToken(seg);
    if (!tok) continue;
    if (DESTRUCTIVE.has(tok) || tok.startsWith("mkfs")) bump("destructive");
    else if (PROCESS.has(tok)) bump("process");
    else if (tok === "git") {
      if (/\bpush\b[^|;&]*--force(?!-with-lease)|\bpush\b[^|;&]*\s-f\b|\breset\b[^|;&]*--hard|\bclean\b[^|;&]*-[a-z]*f|\bbranch\b[^|;&]*-D\b/.test(rest)) bump("destructive");
      // State-changing subcommands. `branch`/`config` need flag-aware matching so bare reads (`git branch`,
      // `git branch -a`, `git config --get/--list`) stay read-only while mutations (`branch -d`, create by
      // name, `config user.x v`) count as writes — otherwise they'd slip past plan-mode read-only enforcement.
      else if (
        /\b(commit|push|merge|rebase|checkout|switch|restore|stash|tag|add|rm|mv|init|apply|cherry-pick|revert|pull|fetch|worktree)\b/.test(rest)
        || /\bbranch\s+(-[dDmMcC]\b|[^-\s])/.test(rest)                                  // branch delete/move/copy or create-by-name
        || (/\bconfig\s+\S/.test(rest) && !/\bconfig\b[^|;&]*(--get|--list|\s-l\b)/.test(rest)) // config set (not --get/--list/-l)
      ) bump("write");
      else bump("read-only"); // status/log/diff/show/branch(list)/config --get/…
    }
    else if (WRITE.has(tok)) bump("write");
    else if (NETWORK.has(tok)) bump("network");
    else if (READ_ONLY.has(tok)) bump("read-only");
    else bump("unknown");
  }
  return worst;
}

// Absolute system roots a destructive/write command must never target. `/tmp` and `/var/tmp` are
// intentionally NOT here (commonly used scratch space). `~`/`$HOME` and a bare `/` are catastrophic.
const SYSTEM_PATH = /(^|\s)(\/(etc|usr|bin|sbin|lib|lib64|boot|dev|sys|proc|var(?!\/tmp)|opt|root|System|Library|Applications)\b|\/\s|\/\*|~(\/|\s|$)|\$HOME\b)/;
const CATASTROPHIC_RM = /\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+(-[a-z]*\s+)*(\/(\s|$|\*)|~(\/\*?)?(\s|$)|\$HOME)/;

/** Validate a command before execution. Block = don't run; Warn = run but flag the approval prompt. */
export interface ValidateOpts { planMode?: boolean; permissionMode?: string; sandbox?: SandboxMode }
export function validateBashCommand(command: string, opts: ValidateOpts = {}): ValidationResult {
  const cmd = String(command ?? "");
  if (!cmd.trim()) return { kind: "block", reason: "empty command" };
  const intent = classifyIntent(cmd);

  // modeValidation — plan (read-only) mode forbids anything that changes state.
  if (opts.planMode && (intent === "write" || intent === "destructive" || intent === "process")) {
    return { kind: "block", reason: `Plan mode is read-only — a ${intent} command (\`${firstWords(cmd)}\`) can't run. Switch to Act mode first.` };
  }

  // pathValidation — catastrophic deletes / writes to system paths are refused outright (even in autopilot).
  if (intent === "destructive") {
    // Normalize away trivial shell-equivalent rewrites that defeat the literal path patterns: quotes
    // (`'/etc'`), redundant slashes (`//etc` → `/etc`), and brace var form (`${HOME}` → `$HOME`). Without
    // this, `rm -rf //etc`, `rm -rf '/etc'`, and `rm -rf ${HOME}` all escape the hard block.
    const np = cmd.replace(/['"]/g, "").replace(/\$\{(\w+)\}/g, "$$$1").replace(/\/{2,}/g, "/");
    if (CATASTROPHIC_RM.test(np) || /\brm\b[^|;&]*\s(\/|~|\$HOME)(\s|$)/.test(np)) {
      return { kind: "block", reason: `refusing a recursive delete of a root/home path (\`${firstWords(cmd)}\`) — this is almost never intended` };
    }
    if (/\bdd\b[^|;&]*of=\/dev\/(disk|sd|hd|vd|xvd|nvme|mmcblk|loop|rdisk)/.test(np) || /\bmkfs\b/.test(cmd) || /\bwipefs\b/.test(cmd)) {
      return { kind: "block", reason: `refusing a raw-disk / filesystem-format command (\`${firstWords(cmd)}\`)` };
    }
    if (SYSTEM_PATH.test(np)) {
      return { kind: "block", reason: `refusing a destructive command targeting a system path (\`${firstWords(cmd)}\`)` };
    }
  }

  // sedValidation — BSD `sed -i` (macOS) treats the NEXT token as the backup suffix, so `sed -i 's/…/'`
  // silently consumes the script as a suffix (and errors). Safe forms attach the suffix (`-i.bak`) or
  // pass an explicit empty one (`-i ''`). Warn when `-i ` is followed by something that's the script.
  const sedI = cmd.match(/\bsed\b[^|;&]*?\s-i(\s+)(\S+)/);
  if (sedI) {
    const next = sedI[2];
    const safe = next === "''" || next === '""' || next.startsWith("."); // empty suffix or a .suffix arg
    if (!safe) return { kind: "warn", message: "`sed -i` without a backup suffix fails on macOS (BSD sed) — use `sed -i ''` (in-place, no backup) or `sed -i.bak`" };
  }

  // destructiveWarning — legitimate-but-dangerous (e.g. rm -rf node_modules, git reset --hard).
  if (intent === "destructive") {
    return { kind: "warn", message: `destructive command (\`${firstWords(cmd)}\`) — review before approving` };
  }
  return { kind: "allow" };
}

function firstWords(cmd: string, n = 6): string {
  const w = cmd.trim().split(/\s+/).slice(0, n).join(" ");
  return w.length < cmd.trim().length ? w + " …" : w;
}
