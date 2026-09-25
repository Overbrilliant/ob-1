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
  ["find . -name node_modules -delete", "destructive"],   // -delete is rm by another name
  ["find / -type f -exec rm -rf {} ;", "destructive"],     // rm hidden inside find -exec
  ["find . -name '*.log' -exec shred {} +", "destructive"],
  ["xargs rm < filelist", "destructive"],
  ["truncate -s 0 big.log", "destructive"],                // truncate blanks files
  // same class, forms the first cut missed: arg-taking xargs flags, path-prefixed/wrapped inner commands,
  // -ok/-execdir, find's `\;` terminator, fd -x, `sh -c '…'`/eval, busybox, unlink.
  ["xargs -n 1 rm", "destructive"],
  ["xargs -I {} rm -rf {}", "destructive"],
  ["xargs -0 -P 4 sudo rm", "destructive"],
  ["xargs sh -c 'rm \"$@\"' _", "destructive"],
  ["find . -exec /bin/rm -f {} +", "destructive"],
  ["find . -okdir rm {} ;", "destructive"],
  [String.raw`find . -exec grep -q secret {} \; -delete`, "destructive"], // -delete AFTER an escaped terminator
  [String.raw`find . -exec sh -c 'rm "$1"' _ {} \;`, "destructive"],
  ["find -delete", "destructive"],
  ["fd -e log -x rm", "destructive"],
  ["fd --exec-batch=rm", "destructive"],
  ["sh -c 'rm -rf /'", "destructive"],                      // was unknown → catastrophic delete executed unflagged
  ["bash -lc \"rm -rf build\"", "destructive"],
  ["eval 'rm -rf dist'", "destructive"],
  ["busybox rm -rf x", "destructive"],
  ["unlink foo", "destructive"],
  // embedded-command runners (#4 + #5 combined): commands smuggled into a runner's ARGUMENTS — interpreter
  // one-liners, awk system(), watch/parallel, sed `e`, tar/git exec hooks, docker run/exec, rsync --delete,
  // and the sudo look-alikes doas/pkexec/run0.
  [`python3 -c "import shutil; shutil.rmtree('/tmp/x')"`, "destructive"],
  [`python -c "import shutil; shutil.rmtree('/')"`, "destructive"],
  [`python3.12 -c "import os; os.system('rm -rf /tmp/x')"`, "destructive"],
  [`python3 -I -c "import os; os.unlink('x')"`, "destructive"],
  [`python3 -c "import os; os.remove('x')"`, "destructive"],
  [`python3 -c "__import__('os').system('rm -rf x')"`, "destructive"],
  [`python3 -c "import subprocess; subprocess.run(['rm', '-rf', 'x'])"`, "destructive"],
  [`python3 -c "import subprocess; subprocess.run(cmd, shell=True)"`, "destructive"],  // opaque command → worst case
  [`python -c "exec(open('evil.py').read())"`, "destructive"],                          // exec of non-literal code
  [`perl -e 'unlink @ARGV' file`, "destructive"],
  [`perl -E 'system("rm -rf /tmp/x")'`, "destructive"],
  [`ruby -e 'FileUtils.rm_rf("x")'`, "destructive"],
  [`node -e "require('fs').rmSync('/tmp/x',{recursive:true})"`, "destructive"],
  [`node -e "require('fs').unlinkSync('x')"`, "destructive"],
  [`node --eval "require('child_process').execSync('rm -rf x')"`, "destructive"],
  [`node -p "require('child_process').execSync('rm -rf x')"`, "destructive"],
  [`php -r 'unlink("x");'`, "destructive"],
  [`osascript -e 'do shell script "rm -rf ~/x"'`, "destructive"],
  [`env python3 -c "import os; os.system('rm -rf x')"`, "destructive"],
  [`awk 'BEGIN{system("rm -rf /tmp/x")}'`, "destructive"],
  [`gawk 'BEGIN{system("rm -rf x")}'`, "destructive"],
  [`mawk 'BEGIN{system("rm x")}'`, "destructive"],
  [`awk 'BEGIN{print "rm -rf x" | "sh"}'`, "destructive"],
  [`awk '{ "rm -rf x" | getline }'`, "destructive"],
  ["watch -n1 rm -rf /tmp/x", "destructive"],
  ["watch -n 1 rm -rf build", "destructive"],                  // space before the interval
  ["watch rm -rf build", "destructive"],
  [`watch "rm -rf build"`, "destructive"],                     // quoted inner command
  ["watch -d -n 1 rm -rf build", "destructive"],
  ["parallel rm {} ::: /tmp/x", "destructive"],
  ["parallel -j4 rm {} ::: a b", "destructive"],
  ["ls | parallel rm", "destructive"],
  ["sem rm -rf x", "destructive"],
  [`parallel ::: "rm -rf a" "ls"`, "destructive"],             // no command: each ::: arg is a command
  ["doas rm -rf /tmp/x", "destructive"],
  ["doas -u root rm -rf x", "destructive"],
  ["pkexec rm -rf x", "destructive"],
  ["run0 rm -rf x", "destructive"],
  ["sudo -u root rm -rf x", "destructive"],                    // sudo flags with a value were never skipped either
  ["doas -n cp a b", "write"],
  ["rsync --delete-before /tmp/empty/ target/", "destructive"],
  ["rsync -a --delete src/ dst/", "destructive"],
  ["rsync -a --remove-source-files src/ dst/", "destructive"],
  [`sed '1e rm -rf /tmp/x' file`, "destructive"],
  [`sed -n '1e rm -rf x' file`, "destructive"],
  [`sed 's/x/date/e' file`, "destructive"],
  [`sed -n '/x/w out.txt' file`, "write"],
  [`tar xf a.tar --checkpoint-action=exec='rm -rf /tmp/x'`, "destructive"],
  [`tar xf a.tar --to-command='rm -rf x'`, "destructive"],
  [`git -c core.pager='rm -rf /tmp/x' log`, "destructive"],
  [`git -c alias.x='!rm -rf build' x`, "destructive"],
  ["docker run -v /:/host alpine rm -rf /host", "destructive"],
  [`docker run --rm -v /:/h alpine sh -c 'rm -rf /h'`, "destructive"],
  ["docker compose run --rm web rm -rf /app/tmp", "destructive"],
  [`echo $(python3 -c "import shutil; shutil.rmtree('x')")`, "destructive"],
  [`echo "$(rm -rf x)"`, "destructive"],                       // command substitution runs first, even in "…"
  ["echo `rm -rf x`", "destructive"],
  ["echo $(rm -rf x)", "destructive"],
  [`node -e "console.log(\`rm -rf x\`)"`, "destructive"],      // backticks in "…" are the SHELL's, not JS's
  ["python3 -c \"open('out','w').write('x')\"", "write"],      // file-writing one-liner is a write
  ["perl -i -pe 's/a/b/' f", "write"],                         // in-place edit
  [`php -r 'file_put_contents("x","y");'`, "write"],
  // …and the harmless forms of the same runners do NOT move (were read-only/unknown/network/write before).
  [`python -c "print(1)"`, "unknown"],                         // no write/destructive signal → unknown, not write
  [`node -e "console.log(1)"`, "unknown"],
  [`node --eval "console.log(1)"`, "unknown"],
  [`perl -e 'print "hi\n"'`, "unknown"],
  [`python3 -c "x=[1,2]; x.remove(1); print(x)"`, "unknown"],  // list.remove is not a file delete
  [`python3 -c "import sys; sys.stdout.write('x')"`, "unknown"],
  [`python3 -c "print('system')"`, "unknown"],
  ["python script.py", "unknown"],
  ["python3 script.py -c 'rm x'", "unknown"],                  // -c after the script is the script's argument
  ["perl -pe 's/a/b/' f", "unknown"],
  ["perl -ne 'print if /x/' f", "unknown"],
  [`echo "use python -c to run"`, "read-only"],
  [`grep 'system("x")' f | awk '{print}'`, "read-only"],       // awk/perl detection keys off the command word only
  [`grep -r "perl -e" docs`, "read-only"],
  [`grep "rsync --delete" README.md`, "read-only"],
  ["awk '{print $1}' f.txt", "read-only"],
  [`awk '{print $1 | "sort -u"}' f`, "unknown"],                  // unchanged: the plain split already sees `"sort -u"`
  ["tar -xf a.tar", "unknown"],
  ["tar -czf out.tgz src", "unknown"],
  ["rsync -av src/ dst/", "network"],
  ["rsync -av --exclude=delete src/ dst/", "network"],
  ["watch ls", "unknown"],
  ["watch -n 2 git status", "unknown"],
  ["watch -n 1 date", "unknown"],
  ["parallel --jobs 4 echo done", "unknown"],
  ["sed -n 1p f", "unknown"],
  ["sed 's/e /x/' f", "unknown"],
  [`docker run --rm node:20 sh -c "npm test"`, "unknown"],     // inner command decides, not the sh wrapper
  ["docker run -it ubuntu bash", "unknown"],
  ["git -c user.name='Jo Doe' commit -m x", "write"],          // plain config value is not a command
  ["git -c user.name='Jo Doe' log", "read-only"],
  ["git -c color.ui=always log", "read-only"],
  ["doas -s", "unknown"],
  [`ls "$(pwd)"`, "read-only"],
  [`echo '$(rm -rf x)'`, "read-only"],                         // single quotes: no substitution
  ["echo $((1+2))", "read-only"],                              // arithmetic, not a command
  // …without false positives on the harmless forms
  ["find . -name x", "read-only"],
  ["find . -exec grep -l foo {} +", "read-only"],
  ["grep -r truncate src", "read-only"],
  ["grep -r -- -delete .", "read-only"],
  ["fd -e ts", "read-only"],
  ["git log --find-renames", "read-only"],
  ["busybox ls", "read-only"],
  ["find . -exec cp {} out ;", "write"],
  ["make", "unknown"],
  ["./configure", "unknown"],
  // wrapper escape (fix/bash-wrapper-escape): env/timeout must reveal the wrapped command.
  ["env rm -rf /", "destructive"],                  // was read-only (env ∈ READ_ONLY) → catastrophic delete executed
  ["env FOO=bar rm -rf build", "destructive"],      // env + assignment + wrapper
  ["env -i rm -rf /etc/nginx", "destructive"],      // env with flags
  ["env FOO=1 timeout 3 rm x", "destructive"],      // stacked wrappers
  ["timeout 5 rm -rf /", "destructive"],            // timeout was unclassified (unknown)
  ["timeout 30 kill -9 123", "process"],
  ["timeout 1.5s curl https://example.com", "network"],
  ["nice -n 5 cp a b", "write"],
  ["nice rm -rf /", "destructive"],                 // plain nice (no -n) must still be stripped
  ["nice cp a b", "write"],
  ["timeout 5s", "unknown"],                        // timeout with no command
  ["env -S \"rm -rf /\"", "unknown"],               // unparseable env flag form → unknown, NEVER read-only
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
check("block: sh -c 'rm -rf /'", isBlock("sh -c 'rm -rf /'"));
check("block: bash -c \"rm -rf ~\"", isBlock('bash -c "rm -rf ~"'));
check("block: busybox rm -rf /", isBlock("busybox rm -rf /"));
check("block: find / -delete", isBlock("find / -delete"));
check("block: truncate -s0 ~/.bashrc", isBlock("truncate -s0 ~/.bashrc"));
check("plan mode blocks find -delete", isBlock("find . -name '*.tmp' -delete", { planMode: true }));
check("plan mode blocks xargs -n1 rm", isBlock("ls | xargs -n 1 rm", { planMode: true }));
check("block: doas rm -rf /", isBlock("doas rm -rf /"));
check("block: pkexec rm -rf /", isBlock("pkexec rm -rf /"));
check("block: doas -u root rm -rf /", isBlock("doas -u root rm -rf /"));
check("block: run0 rm -rf ~", isBlock("run0 rm -rf ~"));
check("block: watch -n 1 'rm -rf /'", isBlock("watch -n 1 'rm -rf /'"));
check("block: python3 -c shutil.rmtree('/')", isBlock(`python3 -c "import shutil; shutil.rmtree('/')"`));
check("block: python3 -c os.system('rm -rf /')", isBlock(`python3 -c "import os; os.system('rm -rf /')"`));
check("block: awk system(\"rm -rf /\")", isBlock(`awk 'BEGIN{system("rm -rf /")}'`));
check("block: perl -E system(\"rm -rf /\")", isBlock(`perl -E 'system("rm -rf /")'`));
check("block: subprocess.run(['rm','-rf','/'])", isBlock(`python3 -c "import subprocess; subprocess.run(['rm','-rf','/'])"`));
check("block: node rmSync('/')", isBlock(`node -e "require('fs').rmSync('/',{recursive:true})"`));
check("block: git -c core.pager='rm -rf /'", isBlock("git -c core.pager='rm -rf /' log"));
check("plan mode blocks awk system()", isBlock(`awk 'BEGIN{system("rm -rf x")}'`, { planMode: true }));
check("plan mode blocks python -c file write", isBlock(`python3 -c "open('o','w').write('x')"`, { planMode: true }));
check("warn (not block): watch -n 1 rm -rf build", isWarn("watch -n 1 rm -rf build"));
check("warn (not block): rsync --delete", isWarn("rsync -a --delete src/ dst/"));
check("plan mode blocks echo \"$(rm -rf x)\"", isBlock(`echo "$(rm -rf x)"`, { planMode: true }));
check("allow: awk '{print $1}' in plan mode", isAllow("awk '{print $1}' f", { planMode: true }));
check("allow: grep 'system(…)' | awk in plan mode", isAllow(`grep 'system("x")' f | awk '{print}'`, { planMode: true }));
check("plan mode ALLOWS plain find", isAllow("find . -name '*.ts'", { planMode: true }));
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

// scheduling/buffering wrappers must not smuggle a command past the gates (same class as env/timeout)
check("destructive: ionice -c2 rm -rf /", isBlock("ionice -c2 rm -rf /"));
check("destructive: stdbuf -oL rm -rf ~", isBlock("stdbuf -oL rm -rf ~"));
check("destructive: taskset 0x3 rm -rf /", isBlock("taskset 0x3 rm -rf /"));
check("destructive: chrt -r 10 rm -rf /", isBlock("chrt -r 10 rm -rf /"));
check("destructive: setsid -f -w rm -rf /", isBlock("setsid -f -w rm -rf /"));
check("destructive: unbuffer rm -rf /", isBlock("unbuffer rm -rf /"));
check("destructive: taskset --cpu-list 0,1 rm -rf /", isBlock("taskset --cpu-list 0,1 rm -rf /"));
check("destructive: ionice --class=0 rm -rf /", isBlock("ionice --class=0 rm -rf /"));
check("intent: stdbuf -oL -eL curl is network", classifyIntent("stdbuf -oL -eL curl https://x") === "network");
check("intent: taskset -c 1 cat is read-only", classifyIntent("taskset -c 1 cat f") === "read-only");
check("intent: ionice -p PID (pid mode, no COMMAND) is the wrapper itself → unknown", classifyIntent("ionice -p 1234") === "unknown");
check("plan mode blocks ionice rm", isBlock("ionice -c2 rm -rf build", { planMode: true }));
check("plan mode blocks stdbuf rm", isBlock("stdbuf -oL rm x", { planMode: true }));
// option values as a SEPARATE word, `--`, clustered/less common flags, absolute paths, nesting, unparseable flags
for (const c of [
  "ionice -c 3 -n 7 rm -rf /", "ionice -c3 -n7 rm -rf /", "ionice -t -c3 rm -rf /", "ionice --class idle rm -rf /", "ionice -c3 -- rm -rf /",
  "stdbuf -o L rm -rf /", "stdbuf -i0 -o0 -e0 rm -rf /", "stdbuf --output L rm -rf /",
  "taskset -c 0 rm -rf /", "taskset -ac 0 rm -rf /", "taskset -a 0x3 rm -rf /", "taskset -- 0x3 rm -rf /", "taskset -c 0 -- rm -rf /",
  "chrt -f 99 rm -rf /", "chrt 10 rm -rf /", "chrt -v -f 99 rm -rf /", "chrt -R -o 0 rm -rf /", "chrt -vf 99 rm -rf /", "chrt --other rm -rf /",
  "chrt -d -T 100000 -P 200000 -D 200000 0 rm -rf /", "chrt --sched-runtime=1 --deadline 0 rm -rf /", "chrt -i 0 rm -rf /",
  "setsid -f rm -rf /", "setsid -fw rm -rf /", "setsid --ctty rm -rf /", "unbuffer -p rm -rf /",
  "/usr/bin/ionice -c3 rm -rf /", "/usr/bin/stdbuf -oL rm -rf /", "/usr/bin/taskset -c 0 rm -rf /", "/usr/bin/chrt -f 99 rm -rf /",
  "/usr/bin/setsid rm -rf /", "/usr/bin/unbuffer rm -rf /", "/usr/bin/env rm -rf /", "/usr/bin/nice rm -rf /", "/usr/bin/timeout 5 rm -rf /",
  "/usr/bin/sudo rm -rf /", "/usr/bin/nohup rm -rf /", "/bin/busybox rm -rf /",
  "nice -n5 rm -rf /", "nice --adjustment=5 rm -rf /", "nice --adjustment 5 rm -rf /", "timeout -s KILL 5 rm -rf /", "timeout -k 1 5 rm -rf /",
  "timeout --kill-after 1 --preserve-status 5 rm -rf /",
  "nice -n 10 ionice -c3 rm -rf /", "ionice -c3 nice -n 19 rm -rf /", "timeout 60 stdbuf -oL rm -rf /", "env FOO=1 taskset -c 0 rm -rf /",
  "nohup setsid -f rm -rf /", "sudo chrt -f 99 rm -rf /", "sudo /usr/bin/ionice -c3 rm -rf /",
  "stdbuf -oL ionice -c3 taskset -c 0 chrt -f 1 setsid unbuffer rm -rf /",
  "chrt --some-future-flag 5 rm -rf /", "ionice -Z rm -rf /", "timeout --bogus 5 rm -rf /", // unparseable flag → keyword fallback
  "ionice -c3 python3 -c \"import shutil; shutil.rmtree('/')\"",
]) check(`block: ${c}`, isBlock(c));
check("warn: ionice -c 3 rm -rf build", isWarn("ionice -c 3 rm -rf build"));
check("plan mode blocks /usr/bin/env rm (was a false read-only)", isBlock("/usr/bin/env rm x", { planMode: true }));
check("plan mode blocks taskset -p MASK PID (sets affinity)", classifyIntent("taskset -p 0x3 1234") !== "read-only");
check("plan mode blocks chrt -p PRIO PID (sets priority)", classifyIntent("chrt -f -p 99 1234") !== "read-only");
check("plan mode blocks ionice -c3 -p PID (sets io class)", classifyIntent("ionice -c3 -p 1234") !== "read-only");
check("unparseable wrapper flag is never read-only", classifyIntent("chrt --some-future-flag 5 cat f") !== "read-only");
// benign uses keep the wrapped command's own intent (no false positives)
for (const [c, want] of [
  ["ionice -c 3 cat f", "read-only"], ["ionice -c3 -n7 grep -r x .", "read-only"], ["stdbuf -o L tail -f log", "read-only"],
  ["taskset -c 0-3 ls", "read-only"], ["chrt -f 99 make", "unknown"], ["setsid -f code .", "unknown"], ["unbuffer -p cat f", "read-only"],
  ["/usr/bin/ionice -c3 cat f", "read-only"], ["/usr/bin/env ls", "read-only"], ["/usr/bin/nice -n 5 cp a b", "write"],
  ["timeout -s INT 30 curl https://x", "network"], ["nice -n5 ls", "read-only"], ["stdbuf -oL git log", "read-only"],
  ["nohup ionice -c3 make -j8", "unknown"], ["chrt --some-future-flag 5 make", "unknown"],
] as const) check(`intent: ${c} → ${want}`, classifyIntent(c) === want);
check("allow: ionice -c 3 rm -rf build is only a warn, not a block", !isBlock("ionice -c 3 rm -rf build"));
check("allow: stdbuf -oL grep rm f (rm is an argument)", isAllow("stdbuf -oL grep rm f"));

if (fail) { console.error("\n✗ bash-validation smoke FAILED"); process.exit(1); }
console.log("\n✓ bash-validation smoke passed");
