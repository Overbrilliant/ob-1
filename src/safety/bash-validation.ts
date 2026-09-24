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
const DESTRUCTIVE = new Set(["rm", "shred", "srm", "mkfs", "dd", "fdisk", "parted", "wipefs", "format", "truncate", "unlink"]);

/** Strip leading `sudo`/`env …`/`timeout …`/`nice …` wrappers and return the real leading token of a
 *  segment. `env` and `timeout` are the dangerous ones: `env` used to fall through UNstripped and sits in
 *  READ_ONLY, so `env rm -rf /` classified as read-only — the catastrophic-delete block never ran and the
 *  command executed. `timeout` fell through as `unknown`, skipping every intent-gated check.
 *  Conservative by construction: a wrapper we can't fully parse (e.g. `env -S '…'`) stops stripping and
 *  yields a bogus token → `unknown`, never a false `read-only`. */
function leadingToken(segment: string): { tok: string; rest: string } {
  let s = segment.trim();
  // drop env assignments (FOO=bar baz) and common wrappers
  for (;;) {
    const m = s.match(/^([A-Za-z_][\w]*=\S*|command|nohup|time|exec|busybox)\s+/);
    if (m) { s = s.slice(m[0].length); continue; }
    // Privilege wrappers: sudo and its look-alikes doas (BSD), pkexec (polkit), run0 (systemd). Skip their
    // own flags, including the ones that take a value (`doas -u root rm …`), so `doas rm -rf /` is seen as
    // rm and hits the same catastrophic-path block as `sudo rm -rf /`. Only flags left → the wrapper token.
    const pw = s.match(/^(sudo|doas|pkexec|run0)(?=\s|$)/);
    if (pw) {
      let t = s.slice(pw[0].length).trimStart();
      for (let f: RegExpMatchArray | null; (f = t.match(PRIV_FLAG) ?? t.match(/^-\S*(?:\s+|$)/)); ) t = t.slice(f[0].length);
      if (!t) return { tok: pw[1]!, rest: "" };
      s = t;
      continue;
    }
    // `env [-flags] [VAR=val …] cmd …` — `env` with nothing after it just prints the environment, and
    // with only flags/assignments still to come it stays `env` (read-only) because the loop stops below.
    if (/^env(\s|$)/.test(s)) {
      s = s.replace(/^env\s*/, "");
      let m2: RegExpExecArray | null;
      while ((m2 = /^(?:-\S+|[A-Za-z_]\w*=\S*)\s+/.exec(s))) s = s.slice(m2[0].length); // skip -i and FOO=bar
      if (!s) return { tok: "env", rest: "" };                                          // `env -i` alone → read-only
      if (/^-\S+$/.test(s)) return { tok: "env", rest: "" };                             // trailing flag w/ arg (`env -u PATH`) → conservative
      continue;
    }
    // `timeout [-flags] DURATION cmd …` (GNU coreutils). Stop on anything unrecognized → `timeout` token → unknown.
    if (/^timeout(\s|$)/.test(s)) {
      const m2 = s.match(/^timeout\s+(?:-\S+\s+)*(?:\d+(?:\.\d+)?[smhdw]?|\d+(?:\.\d+)?:\d+(?::\d+)?)\s+/);
      if (!m2) return { tok: "timeout", rest: s.slice("timeout".length) };
      s = s.slice(m2[0].length);
      continue;
    }
    // `nice [-n ADJ] cmd` / `nice ADJ cmd` — strip the adjustment so `nice -n 5 cp a b` classifies as write.
    if (/^nice(\s|$)/.test(s)) {
      const m2 = s.match(/^nice\s+(?:-n\s+-?\d+|-?\d+\s)\s*/);
      if (m2) { s = s.slice(m2[0].length); continue; }
      if (/^nice\s+-n\s*$/.test(s)) return { tok: "nice", rest: "" };
      // bare `nice` (prints scheduling priority) → read-only
      if (s === "nice") return { tok: "nice", rest: "" };
      // plain `nice cmd …` (no adjustment): strip the wrapper like before, so `nice rm -rf /` stays destructive.
      s = s.replace(/^nice\s+/, "");
      continue;
    }
    break;
  }
  const tok = s.split(/\s+/, 1)[0] ?? "";
  // strip a path prefix (/usr/bin/rm → rm)
  const base = tok.includes("/") ? tok.slice(tok.lastIndexOf("/") + 1) : tok;
  return { tok: base, rest: s.slice(tok.length) };
}

/** sudo/doas/pkexec/run0 flags that take a value (`-u root`, `-uroot`, `--user=root`, `--chdir /x`). */
const PRIV_FLAG = /^(?:-[ugCDhprtUTa](?:\s+|(?=\S))[^\s-]\S*|--(?:user|group|chdir|close-from|host|prompt|role|type|other-user|command-timeout|setenv|nice|unit|property|description|slice|machine|background)(?:=|\s+)\S+)(?:\s+|$)/;

/** Skip `xargs`'s own options and return the command it will run (`xargs -n 1 -I {} rm {}` → `rm {}`). */
function xargsCommand(rest: string): string {
  let s = rest.trimStart();
  for (;;) {
    // options whose argument is a SEPARATE word (`-n 1`, `-I {}`, `--max-args 1`), then any other flag/attached form
    const m = s.match(/^(?:-[aEdILnPs]|--(?:arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars|process-slot-var))\s+\S+\s*/)
      ?? s.match(/^-\S*\s*/);
    if (!m || !m[0]) return s;
    s = s.slice(m[0].length);
  }
}

/** Split a command line on UNQUOTED separators (`|`, `||`, `&&`, `;`, `&`, newline, `(`, `)`, backtick).
 *  Unlike the plain split in classify(), quoted text stays in its segment: `python3 -c "a; b"` is one
 *  segment and `grep 'x | awk' f` never yields an `awk` segment. `2>&1` / `&>` / `>&2` are not separators. */
function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      if (c === q) q = "";
      else if (c === "\\" && q === '"' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    const fdDup = c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">");
    if (!fdDup && (c === "|" || c === ";" || c === "&" || c === "\n" || c === "(" || c === ")" || c === "`")) {
      if (cur.trim()) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Bodies of command substitutions `$(…)` and `` `…` `` outside single quotes — the shell runs them first,
 *  even inside double quotes, so `echo "$(rm -rf x)"` must be classified as at least `rm -rf x`. */
function substitutions(cmd: string): string[] {
  const out: string[] = [];
  let q = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q === "'") { if (c === "'") q = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "'" && !q) { q = "'"; continue; }
    if (c === '"') { q = q ? "" : '"'; continue; }
    if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end < 0) break;
      out.push(cmd.slice(i + 1, end));
      i = end;
    } else if (c === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) { if (cmd[j] === "(") depth++; else if (cmd[j] === ")" && --depth === 0) break; }
      out.push(cmd.slice(i + 2, j));
      i = j;
    }
  }
  return out;
}

/** Split one segment into shell words with the quoting removed (`-c "a b" 'c'` → [`-c`, `a b`, `c`]). */
function shellWords(seg: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let q = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (q) {
      if (c === q) q = "";
      else if (c === "\\" && q === '"' && /["\\$`]/.test(seg[i + 1] ?? "")) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; continue; }
    if (c === "'" || c === '"') { q = c; cur ??= ""; continue; }
    if (c === "\\" && i + 1 < seg.length) { cur = (cur ?? "") + seg[++i]; continue; }
    cur = (cur ?? "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Re-join words for a runner that execs argv directly (docker run): quote any word with spaces. */
const joinArgv = (w: string[]) => w.map((x) => (/[\s;&|]/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : x)).join(" ");

const INTERPRETER = /^(?:python[\d.]*|pypy[\d.]*|perl[\d.]*|ruby[\d.]*|node|nodejs|bun|deno|php[\d.]*|lua[\d.]*|luajit|Rscript|osascript)$/;
const AWK = /^(?:awk|gawk|mawk|nawk)$/;

/** Inline program text an interpreter was given (`python3 -I -c CODE`, `perl -lne CODE`, `node --eval=CODE`,
 *  `php -r CODE`, `deno eval CODE`), plus whether it edits files in place (`perl -i`, `ruby -i`). Only the
 *  interpreter's own options are scanned: the first non-option word is a script path, which is not inline code. */
function inlineCode(tok: string, words: string[]): { code: string[]; inPlace: boolean } {
  const lang = tok.replace(/[\d.]+$/, "");
  const code: string[] = [];
  let inPlace = false;
  if (lang === "deno") {
    if (words[0] === "eval") { const c = words.slice(1).find((w) => !w.startsWith("-")); if (c) code.push(c); }
    return { code, inPlace };
  }
  // flags whose value is a separate word, per interpreter (so `node -r mod -e X` / `python -W x -c X` parse).
  const argFlag: Record<string, RegExp> = {
    python: /^-[WXQ]$/, pypy: /^-[WXQ]$/, node: /^(?:-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--env-file)$/,
    nodejs: /^(?:-r|--require|--import|--loader)$/, bun: /^(?:-r|--preload|--cwd|--env-file|--config|-c)$/,
    ruby: /^-[rICEFx]$/, perl: /^-[IMmx]$/, php: /^-[cdzf]$/, lua: /^-[l]$/, luajit: /^-[lbj]$/, Rscript: /^$/, osascript: /^-[lis]$/,
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--" || !w.startsWith("-") || w === "-") break;
    const next = () => { const c = words[++i]; if (c != null) code.push(c); };
    if (lang === "python" || lang === "pypy") {
      if (/^-[bBdEhiIOPqRsSuvVx]*c$/.test(w)) { next(); break; }        // `-c`, `-Ic`, `-uc`
      if (/^-[bBdEhiIOPqRsSuvVx]*c./.test(w)) { code.push(w.replace(/^-[a-zA-Z]*?c/, "")); break; }
    } else if (lang === "node" || lang === "nodejs" || lang === "bun") {
      if (/^(?:-e|--eval|-p|--print|-pe)$/.test(w)) { next(); continue; }
      const eq = w.match(/^--(?:eval|print)=([\s\S]*)$/);
      if (eq) { code.push(eq[1]!); continue; }
    } else if (lang === "perl" || lang === "ruby") {
      // switch clusters: `-e`, `-ne`, `-lane`, `-pi`, `-i.bak`, `-pie`. `-M`/`-I`/`-m`/`-r` swallow the rest.
      if (/^-[IMmrx]./.test(w)) continue;
      const sw = w.slice(1).match(/^[a-zA-Z0-9]*/)![0];
      const e = sw.search(/[eE]/);
      const pre = e < 0 ? sw : sw.slice(0, e);
      if (pre.includes("i")) inPlace = true;
      if (e >= 0 && /^[aclnpsStTuUwWX0-9i]*$/.test(pre)) {
        const attached = w.slice(2 + e);
        if (attached) code.push(attached); else next();
        continue;
      }
    } else if (lang === "php") {
      if (/^-[rRBE]$/.test(w)) { next(); continue; }
    } else if (/^-e$/.test(w)) { next(); continue; }                     // lua, luajit, Rscript, osascript
    if (argFlag[lang]?.test(w)) i++;
  }
  return { code, inPlace };
}

// Destructive filesystem APIs in inline code (python/node/ruby/perl/php/lua/R/deno). Specific names only —
// a bare `remove(` would flag `xs.remove(1)` (list.remove) as destructive.
const CODE_DESTRUCTIVE = /\b(?:rmtree|rmSync|rmdirSync|unlinkSync|rm_rf|rm_r|rm_f|remove_entry\w*|remove_tree|rimraf|removedirs|shred)\b|\bos\.(?:remove|unlink|rmdir)\b|__import__\(\s*['"]os['"]\s*\)\s*\.\s*(?:remove|unlink|rmdir)\b|\b(?:fs|fsp|promises)\s*\.\s*(?:rm|rmdir|unlink|truncate)\s*\(|\bDeno\.remove(?:Sync)?\b|\bFileUtils\s*\.\s*(?:rm|remove)|\b(?:File|Dir|Files)\s*\.\s*(?:delete|unlink|rmdir)\b|\bfile\.remove\s*\(|\bunlink\b|\brmdir\s*\(|\.(?:unlink|rmdir|truncate)\s*\(|\btruncate\s*\(/;
// Calls that hand a string to a shell / exec a program. A literal first argument (`os.system('rm -rf x')`,
// `subprocess.run(["rm", "x"])`, `system("…")`) is classified as a command; anything else is opaque.
const CODE_SHELL_OUT = /(?:\b(?:os\s*\.\s*(?:system|popen|exec\w*|spawn\w*)|subprocess\s*\.\s*\w+|commands\s*\.\s*getoutput|pty\s*\.\s*spawn|(?:IO|Open3|Process)\s*\.\s*\w+|Bun\s*\.\s*spawn(?:Sync)?|Deno\s*\.\s*(?:run|Command)|shell_exec|passthru|proc_open|popen|system|exec(?:Sync|File|FileSync)?|spawn(?:Sync)?)(?:\s*\(\s*|\s+(?=['"[]))|\bdo shell script\s+)/g;
// Non-destructive file writes in inline code.
const CODE_WRITE = /\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]|\bopen\s*\(?[^;)]*['"]\s*\+?[>|]|(?<!std(?:out|err))\.(?:write|write_text|write_bytes|writelines|touch|mkdir|rename|symlink_to|chmod)\s*\(|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|mkdirSync|renameSync|symlinkSync|chmodSync|cpSync|file_put_contents|fwrite|makedirs|copytree|copyfile|writeLines|saveRDS|sink|dir\.create|file\.copy|file\.rename|file\.create)\s*\(|\bshutil\s*\.\s*(?:copy\w*|move)|\bos\s*\.\s*(?:rename|replace|mkdir|symlink|link|chmod|chown|utime)\b|\b(?:File|IO)\s*\.\s*(?:write|open\s*\([^)]*['"][wa])|\bFileUtils\b|\b(?:Bun|Deno)\s*\.\s*write\w*|\bfopen\s*\([^)]*,\s*['"][wax]|\bio\.open\s*\([^)]*,\s*['"][wa]/;

/** Intent of inline program text. Shell-outs are classified by the command they run; destructive file APIs
 *  are destructive; file writes are writes; anything else stays `unknown` (arbitrary code, but no signal) so a
 *  harmless `python -c "print(1)"` is not called a write — it still never reads as read-only. */
function codeIntent(code: string, lang: string, bump: (i: CommandIntent) => void, sub: (inner: string) => void): void {
  bump("unknown");
  if (CODE_DESTRUCTIVE.test(code)) bump("destructive");
  for (const m of code.matchAll(CODE_SHELL_OUT)) {
    const after = code.slice(m.index! + m[0].length);
    const lits = after.match(/^\[\s*((?:(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,?\s*)+)\]/)?.[1] ?? after.match(/^((?:(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,?\s*)+)/)?.[1];
    if (lits == null) { bump("destructive"); continue; }       // opaque command (variable, f-string, concat): assume the worst
    const parts = [...lits.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((p) => (p[1] ?? p[2] ?? "").replace(/\\(.)/g, "$1"));
    const inner = parts.join(" ");
    if (lang === "python" && /^exec\b/.test(m[0])) { codeIntent(inner, lang, bump, sub); continue; } // exec("…") is more Python
    if (inner.trim()) sub(inner); else bump("destructive");
  }
  // perl/ruby/php backticks and qx{}/%x() run a shell; Bun's $`…` template runs Bun Shell.
  const shellLits = lang === "perl" || lang === "ruby" || lang === "php"
    ? [...code.matchAll(/`([^`]*)`|\bqx\s*([({[</|!])([\s\S]*?)[)}\]>/|!]|%x\s*[({[]([\s\S]*?)[)}\]]/g)].map((m) => m[1] ?? m[3] ?? m[4] ?? "")
    : lang === "node" || lang === "nodejs" || lang === "bun" ? [...code.matchAll(/\$`([^`]*)`/g)].map((m) => m[1]!) : [];
  for (const s of shellLits) sub(s);
  if (CODE_WRITE.test(code)) bump("write");
}

/** Inspect ONE quote-aware segment for a command smuggled into its arguments, keyed off its real command word. */
function embeddedIntent(seg: string, bump: (i: CommandIntent) => void, sub: (inner: string) => void): void {
  const { tok, rest } = leadingToken(seg);
  if (!tok) return;
  const words = shellWords(rest);
  if (INTERPRETER.test(tok)) {
    // `python3 -c CODE`, `perl -e CODE`, `node -e/--eval/-p CODE`, `php -r CODE`, … run program text that no
    // segment token shows: `python3 -c "import shutil; shutil.rmtree('/')"` used to read as a bare `unknown`.
    const lang = tok.replace(/[\d.]+$/, "");
    const { code, inPlace } = inlineCode(tok, words);
    for (const c of code) codeIntent(c, lang, bump, sub);
    if (inPlace) bump("write");
    return;
  }
  if (AWK.test(tok)) {
    // awk is READ_ONLY, but its program can shell out: `system("…")`, `print … | "cmd"`, `"cmd" | getline`.
    // Only this awk's own arguments are scanned, so `grep 'system("x")' f | awk '{print}'` stays read-only.
    const prog = words.filter((w) => !w.startsWith("-")).join("\n");
    for (const m of prog.matchAll(/\bsystem\s*\(\s*(?:"((?:[^"\\]|\\.)*)")?/g)) {
      if (m[1] == null) bump("destructive"); else sub(m[1].replace(/\\(.)/g, "$1"));
    }
    for (const m of prog.matchAll(/\|&?\s*"((?:[^"\\]|\\.)*)"|"((?:[^"\\]|\\.)*)"\s*\|&?\s*getline/g)) {
      const inner = (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1");
      if (/^\s*(?:\S*\/)?(?:ba|z|da|k|fi)?sh(?:\s|$)/.test(inner)) bump("destructive"); // `print … | "sh"`: awk output IS the script
      else sub(inner);
    }
    return;
  }
  if (tok === "watch" || tok === "parallel" || tok === "sem") {
    // `watch [opts] CMD…` re-runs CMD via `sh -c` (all words joined); GNU `parallel`/`sem [opts] CMD ::: args`
    // runs CMD per job — with no CMD, each `:::` argument is itself a command.
    const withArg = tok === "watch" ? /^(?:-n|--interval|-q|--equexit)$/ : /^(?:-[jSaIdEnNL]|--(?:jobs|sshlogin|arg-file|colsep|delimiter|results|tmpdir|timeout|delay|max-args|retries|memfree|load|joblog|workdir|id|semaphorename|env|basefile|transfer-file|return))$/;
    let i = 0;
    for (; i < words.length && words[i]!.startsWith("-"); i++) { if (words[i] === "--") { i++; break; } if (withArg.test(words[i]!)) i++; }
    const cmdEnd = words.findIndex((w, j) => j >= i && /^:::+\+?$/.test(w));
    const inner = words.slice(i, cmdEnd < 0 ? undefined : cmdEnd);
    if (inner.length) sub(inner.join(" "));
    else if (cmdEnd >= 0) for (const a of words.slice(cmdEnd + 1)) if (!/^:::+\+?$/.test(a)) sub(a);
    return;
  }
  if (tok === "sed") {
    // sed's `e CMD` command runs CMD; `s///e` runs the pattern space; `w file` / `s///w file` write files.
    const scripts: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === "-e" || w === "--expression") scripts.push(words[++i] ?? "");
      else if (w.startsWith("--expression=")) scripts.push(w.slice(13));
      else if (w === "-f" || w === "--file" || w === "-l" || w === "--line-length") i++;
      else if (!w.startsWith("-") && !scripts.length) { scripts.push(w); break; }
    }
    for (const sc of scripts) {
      let rest2 = sc;
      for (const m of sc.matchAll(/(?:^|[;\n{}]|\d|\$|\/)\s*s(.)(?:(?!\1)[^\\\n]|\\.)*\1(?:(?!\1)[^\\\n]|\\.)*\1([gpiImMe0-9]*)(w\s*\S+)?/g)) {
        if (m[2]!.includes("e")) bump("destructive");
        if (m[3]) bump("write");
        rest2 = rest2.replace(m[0], m[0].charAt(0) === "s" ? " " : m[0].charAt(0) + " ");
      }
      const addr = String.raw`(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/)?(?:\s*,\s*(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/))?\s*!?\s*`;
      for (const m of rest2.matchAll(new RegExp(String.raw`(?:^|[;\n{}])\s*${addr}e(?:\s+([^;\n}]*))?\s*(?=$|[;\n}])`, "g"))) {
        if (m[1]?.trim()) sub(m[1]); else bump("destructive");
      }
      if (new RegExp(String.raw`(?:^|[;\n{}])\s*${addr}[wW]\s+\S`).test(rest2)) bump("write");
    }
    return;
  }
  if (tok === "tar") {
    // tar's exec hooks run whatever they're given: --checkpoint-action=exec=CMD, --to-command, compress/info scripts.
    for (let i = 0; i < words.length; i++) {
      const m = words[i]!.match(/^--(checkpoint-action|to-command|use-compress-program|info-script|new-volume-script|rsh-command)(?:=([\s\S]*))?$/)
        ?? (/^-[IF]$/.test(words[i]!) ? [words[i]!, "short", undefined] : null);
      if (!m) continue;
      let v = m[2] ?? words[++i] ?? "";
      if (m[1] === "checkpoint-action") { if (!v.startsWith("exec=")) continue; v = v.slice(5); }
      sub(v);
    }
    return;
  }
  if (tok === "rsync") {
    // --delete* makes the destination match the source by DELETING files; --remove-source-files deletes the source.
    if (words.some((w) => /^--(?:delete(?:-\w+)?|del|remove-source-files)$/.test(w))) bump("destructive");
    return;
  }
  if (tok === "git") {
    // `git -c key=value` where the key's value is run as a command (pager, editor, ssh, alias `!cmd`, …).
    // Plain config (`-c user.name='Jo Doe'`) is not a command and is ignored.
    for (let i = 0; i < words.length && words[i]!.startsWith("-"); i++) {
      if (/^(?:-C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/.test(words[i]!)) { i++; continue; }
      if (words[i] !== "-c") continue;
      const kv = words[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      const key = kv.slice(0, eq).toLowerCase();
      if (/^(?:core\.(?:pager|editor|sshcommand|fsmonitor|askpass)|alias\..+|pager\..+|sequence\.editor|diff\.external|.+\.textconv|diff\..+\.command|gpg(?:\.\w+)?\.program|credential(?:\..+)?\.helper|filter\..+\.(?:clean|smudge|process)|merge\..+\.driver|uploadpack\.packobjectshook|remote\..+\.(?:uploadpack|receivepack))$/.test(key)) {
        sub(kv.slice(eq + 1).replace(/^!/, ""));
      }
    }
    return;
  }
  if (tok === "docker" || tok === "podman") {
    // `docker run [opts] IMAGE CMD…` / `docker exec [opts] CTR CMD…` / `docker compose run|exec [opts] SVC CMD…`:
    // classify CMD like any command, so `docker run -v /:/h alpine rm -rf /h` is destructive but
    // `docker run --rm node:20 sh -c "npm test"` is only as strong as `npm test`.
    let w = words;
    if (w[0] === "container") w = w.slice(1);
    if (w[0] === "compose") { let j = 1; while (j < w.length && w[j]!.startsWith("-")) j += /^(?:-f|--file|-p|--project-name|--profile|--env-file)$/.test(w[j]!) ? 2 : 1; w = w.slice(j); }
    if (w[0] !== "run" && w[0] !== "exec") return;
    const withArg = /^(?:-[a-zA-Z]*[veplwuhmaLc]|--(?:volume|env|env-file|publish|workdir|user|label|hostname|memory|attach|name|network|net|entrypoint|mount|platform|cpus|cpu-shares|add-host|cap-add|cap-drop|device|restart|pull|log-driver|log-opt|tmpfs|ulimit|security-opt|gpus|shm-size|dns|ipc|pid|runtime|stop-signal|health-cmd|expose|link|volumes-from|cidfile|cgroupns|group-add|label-file|detach-keys|uts|userns|isolation|storage-opt|sysctl|volume-driver|annotation))$/;
    let i = 1;
    for (; i < w.length && w[i]!.startsWith("-"); i++) { if (w[i] === "--") { i++; break; } if (withArg.test(w[i]!)) i++; }
    const inner = w.slice(i + 1);                               // skip IMAGE / container / service
    if (inner.length) sub(joinArgv(inner));
  }
}

/** Classify the STRONGEST intent across a whole command line (split on pipes/&&/||/;). */
export function classifyIntent(command: string): CommandIntent {
  return classify(String(command ?? ""), 0);
}

function classify(cmd: string, depth: number): CommandIntent {
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
  // Commands hidden in ARGUMENTS. Per-segment classification only sees the leading token, so a command
  // that runs another command (`find -exec X`, `fd -x X`, `xargs X`, `sh -c 'X'`, `eval X`) must be
  // classified as at least X — otherwise `find / -exec rm -rf {} ;`, `xargs -n1 rm`, and even
  // `sh -c 'rm -rf /'` ran with read-only/unknown intent and skipped every gate (plan mode, the
  // destructive warning, the catastrophic-path block). `find … -delete` is rm by another name.
  const sub = (inner: string) => { if (depth < 4 && inner.trim()) bump(classify(inner, depth + 1)); };
  // find's `\;` / `';'` terminator is not a shell separator — neutralise it so `find … -exec … \; -delete` is seen.
  const fcmd = cmd.replace(/\\;|';'|";"/g, " \u0000 ");
  if (/(?:^|[\s/])find\s/.test(cmd)) {
    if (/(?:^|[\s/])find\s(?:[^|;&]*\s)?-delete\b/.test(fcmd)) bump("destructive");
    for (const m of fcmd.matchAll(/\s-(?:exec|execdir|ok|okdir)\s+([^\u0000]+?)(?=\s\u0000|\s\+(?:\s|$)|$)/g)) sub(m[1]!);
  }
  for (const m of cmd.matchAll(/(?:^|[\s/])fd\s(?:[^|;&]*?\s)?(?:-x|-X|--exec|--exec-batch)(?:\s+|=)(.+)/g)) sub(m[1]!);
  for (const m of cmd.matchAll(/(?:^|[\s/|;&(])xargs(?:\s+(.*)|$)/g)) sub(xargsCommand(m[1] ?? ""));
  for (const m of cmd.matchAll(/(?:^|[\s/|;&(])(?:ba|z|da|k)?sh\s+(?:-[-a-zA-Z]+\s+)*-[a-zA-Z]*c[a-zA-Z]*\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s;&|]+))/g)) sub(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of cmd.matchAll(/(?:^|[\s|;&(])eval\s+(.+)/g)) sub(m[1]!.replace(/['"]/g, ""));
  // Commands embedded in a runner's ARGUMENTS (interpreter one-liners, awk system(), watch, parallel,
  // sed `e`, tar/git exec hooks, docker run/exec). Keyed off the real command word of each quote-aware
  // segment, so the same words inside a quoted argument (`grep 'system("x")' f`) are never mistaken for it.
  for (const seg of shellSegments(cmd)) embeddedIntent(seg, bump, sub);
  for (const inner of substitutions(cmd)) sub(inner);
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
    // Call punctuation is spaced out too, so a delete embedded in code (`system("rm -rf /")`,
    // `subprocess.run(["rm","-rf","/"])`, `shutil.rmtree('/')`) meets the same patterns.
    const np = cmd.replace(/['"]/g, "").replace(/\$\{(\w+)\}/g, "$$$1").replace(/\/{2,}/g, "/").replace(/[()[\],{}]/g, " ");
    if (CATASTROPHIC_RM.test(np) || /\brm\b[^|;&]*\s(\/|~|\$HOME)(\s|$)/.test(np)
      || /\b(?:rmtree|rmSync|rm_rf|rm_r|remove_tree|rimraf)\s+(\/|~\/?|\$HOME)(\s|$)/.test(np)) {
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
