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
  // read-only viewers that exec an option-value helper via `sh -c`: sort --compress-program,
  // diff --filter, rg --pre / --hostname-bin (the same smuggling class as find -exec / xargs).
  [`sort --compress-program='rm -rf /tmp/x' file`, "destructive"],
  ["sort --compress-program rm -rf file", "destructive"],
  [`diff --filter='rm -rf /tmp/x' a b`, "destructive"],
  [`rg --pre='rm -rf /tmp/x' foo .`, "destructive"],
  [`rg --pre 'rm -rf /' needle`, "destructive"],
  ["rg --pre wc foo", "read-only"],                              // benign helper stays benign
  ["sort --compress-program zstd file", "write"],                 // the helper is itself a file-rewriting compressor
  // the same family grew two more members later: bat --pager/--preprocessor and GNU diff --paginate=CMD.
  [`bat --pager='rm -rf /tmp/x' notes.md`, "destructive"],
  ["bat --pager rm -rf notes.md", "destructive"],
  [`bat --preprocessor='rm -rf /tmp/x' f`, "destructive"],
  ["bat --paging never notes.md", "read-only"],                    // mode option, not a command
  ["bat notes.md", "read-only"],
  [`diff --paginate='rm -rf /tmp/x' a b`, "destructive"],
  ["diff --paginate a b", "read-only"],                            // bare --paginate pages through pr
  [`git grep -O'rm -rf /tmp/x' pat`, "destructive"],             // -O[CMD] pipes hits through CMD
  ["git bisect run rm -rf /tmp/x", "destructive"],               // bisect run executes CMD per step
  ["git bisect run npm test", "unknown"],
  ["git bisect good", "read-only"],
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
  ["tar -xf a.tar", "write"],
  ["tar -czf out.tgz src", "write"],
  ["rsync -av src/ dst/", "network"],
  ["rsync -av --exclude=delete src/ dst/", "network"],
  ["watch ls", "unknown"],
  ["watch -n 2 git status", "unknown"],
  ["watch -n 1 date", "unknown"],
  ["parallel --jobs 4 echo done", "unknown"],
  ["sed -n 1p f", "read-only"],                                  // sed is a reader unless -i / w / e / -f
  ["sed 's/e /x/' f", "read-only"],
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
  ["env -S \"rm -rf /\"", "destructive"],           // --split-string: the value IS the command (was unknown; now classified)
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

// namespace / user-switching / tracing runners + socat EXEC + env -S: commands smuggled past the classifier
// because the wrapper token was never stripped (same failure class as env/timeout/scheduling wrappers).
for (const c of [
  "su root -c 'rm -rf /'", "su - root -c \"rm -rf /\"", "runuser -u root -- rm -rf /", "runuser root -c 'rm -rf /'",
  "chroot /mnt rm -rf /", "chroot /mnt /bin/rm -rf /etc", "nsenter -t 1 -m rm -rf /", "nsenter --target 1 --mount -- rm -rf /",
  "systemd-run rm -rf /", "script -qc 'rm -rf /' /dev/null", "valgrind rm -rf /",
  "/usr/sbin/chroot /mnt rm -rf /", "sudo su root -c 'rm -rf /'",
  "socat tcp-listen:1234 EXEC:\"rm -rf /\"",
  "env -S 'rm -rf /'", "env --split-string='rm -rf /'", "env -i -S 'rm -rf /'",
]) check(`block: ${c}`, isBlock(c));
for (const c of [
  "systemd-run rm -rf /tmp/x", "systemd-run --unit=x --description=y rm -rf /tmp/x",
  "strace rm -rf /tmp/x", "ltrace -e x rm -rf /tmp/x", "socat - SYSTEM:'rm -rf /tmp/x'",
]) check(`warn (destructive, /tmp path): ${c}`, isWarn(c));
check("warn: su root -c 'rm -rf build' (destructive, project path)", isWarn("su root -c 'rm -rf build'"));
check("warn: strace rm -rf build", isWarn("strace rm -rf build"));
check("plan mode blocks chroot rm", isBlock("chroot /mnt rm x", { planMode: true }));
check("plan mode blocks su -c rm", isBlock("su root -c 'rm x'", { planMode: true }));
check("plan mode blocks systemd-run rm", isBlock("systemd-run rm x", { planMode: true }));
// benign forms keep sane intent (never false read-only, but no catastrophic block)
check("intent: su root (bare login shell) is the wrapper, not destructive", classifyIntent("su root") === "unknown");
check("intent: nsenter -t 1 -m (shell only) is the wrapper", classifyIntent("nsenter -t 1 -m") === "unknown");
check("intent: strace ls is the wrapper (keyword scan sees only ls)", classifyIntent("strace ls") === "unknown");
check("allow: gdb -batch -ex run ./x (no known command word)", isAllow("gdb -batch -ex run ./x"));
check("allow: env FOO=rm cmd (rm is an assignment value, not a command)", classifyIntent("env FOO=rm cmd") !== "destructive");
check("intent: env -i /bin/ls is not destructive", classifyIntent("env -i /bin/ls") !== "destructive");
check("allow: socat TCP-LISTEN:80,fork TCP:localhost:8080", isAllow("socat TCP-LISTEN:80,fork TCP:localhost:8080"));
// git under a tracing/namespace runner is classified by its subcommand, not bumped to write by the bare word.
// (The runner itself is not on the read-only allow-list, so plan mode's default-deny still blocks it.)
for (const c of ["strace -f git status", "valgrind git log", "chroot /mnt git log", "ltrace git diff"]) {
  check(`read-only git under a runner is not a write: ${c}`, !["write", "destructive", "process"].includes(classifyIntent(c)));
}
check("intent: strace git push --force is destructive", classifyIntent("strace git push --force") === "destructive");
check("intent: chroot /mnt git commit -m x is a write", classifyIntent("chroot /mnt git commit -m x") === "write");
check("intent: su git -c 'rm -rf build' (user named git) is still destructive", classifyIntent("su git -c 'rm -rf build'") === "destructive");
check("intent: su root -c 'rm -rf /' still destructive", classifyIntent("su root -c 'rm -rf /'") === "destructive");
check("block: su root -c 'rm -rf /' still blocked", isBlock("su root -c 'rm -rf /'"));
// script's positional FILE is the log file, not a command.
check("intent: script -q rm (log file named rm) is not destructive", classifyIntent("script -q rm") !== "destructive");
check("intent: script -c 'rm -rf build' out.log is destructive", classifyIntent("script -c 'rm -rf build' out.log") === "destructive");
check("intent: script --command='rm x' is destructive", classifyIntent("script --command='rm x'") === "destructive");
check("intent: script -q log rm -rf build (BSD: command after file) is destructive", classifyIntent("script -q log rm -rf build") === "destructive");

// ── time wrapper, sed -i, SQL clients, docker prune (same smuggling class) ──
// `time` was stripped only as a bare word; any flag (`-v`, `-p`, `-o FILE`) made the leading token the
// flag → unknown, so `time -v rm -rf /` skipped plan mode, the destructive warning and the path block.
for (const [c, want] of [
  ["time -v rm -rf /tmp/x", "destructive"], ["time -p ls", "read-only"], ["time -o run.log rm x", "destructive"],
  ["/usr/bin/time -v rm -rf /tmp/x", "destructive"], ["time make", "unknown"], ["time ls", "read-only"],
  ["nohup time -v rm -rf build", "destructive"], ["time -v -- ls", "read-only"],
] as const) check(`intent: ${c} → ${want}`, classifyIntent(c) === want);
check("plan mode blocks time -v rm (flag hid the command)", isBlock("time -v rm -rf /tmp/x", { planMode: true }));
check("unparseable time flag is never read-only", classifyIntent("time --future-flag 5 cat f") !== "read-only");

// sed -i rewrites the FILE: a write (plan-mode block + approval), not the old `unknown` pass-through.
for (const [c, want] of [
  ["sed -i 's/a/b/' f", "write"], ["sed -i.bak 's/a/b/' f", "write"], ["sed --in-place 's/a/b/' f", "write"],
  ["sed --in-place=.bak 's/a/b/' f", "write"], ["sed -n 5p f", "read-only"],
] as const) check(`intent: ${c} → ${want}`, classifyIntent(c) === want);
check("plan mode blocks sed -i (in-place edit is a write)", isBlock("sed -i 's/a/b/' file.txt", { planMode: true }));
check("allow: plain sed stays a read (no -i)", isAllow("sed 's/a/b/' file.txt"));

// SQL clients run whatever statement they are handed.
for (const [c, want] of [
  ["sqlite3 app.db 'delete from users'", "destructive"], ["mysql -e \"drop table t\"", "destructive"],
  ["psql db -c 'update t set x=1'", "write"], ["psql db -c 'select 1'", "unknown"],
  ["sqlite3 app.db 'select * from t'", "unknown"], ["mysql -e \"insert into t values (1)\"", "write"],
] as const) check(`intent: ${c.replace(/\s+/g, " ").slice(0, 42)} → ${want}`, classifyIntent(c) === want);
check("plan mode blocks sqlite3 DELETE", isBlock("sqlite3 app.db 'delete from t'", { planMode: true }));
check("warn: mysql DROP TABLE is destructive", isWarn("mysql -e \"drop table t\""));
// Only the statement text is classified (never a db/file name or redirect target), string literals are
// stripped, and only each statement's LEADING keyword counts — these used to be false writes/deletes.
for (const c of [
  "sqlite3 update.db 'select 1'", "psql -c \"select replace(name,'a','b') from t\"",
  "sqlite3 app.db \"select * from t where name like '%update%'\"", "psql -c \"select * from audit where action='delete'\"",
  "sqlite3 app.db < drop.sql", "sqlite3 app.db <drop.sql", "mysql delete_me -e 'select 1'", "psql -f create.sql db",
]) {
  const i = classifyIntent(c);
  check(`sql false positive stays a read: ${c} (${i})`, i !== "write" && i !== "destructive");
  // Plan mode is default-deny: a SQL client is never on the read-only list (a SELECT can call side-effecting
  // functions; `< file.sql` / `-f` hide the statements), so it is blocked there — just not as a write.
  check(`plan mode blocks (default-deny, not a write): ${c}`, isBlock(c, { planMode: true }));
}
for (const [c, want] of [
  ["psql -c \"delete from t\"", "destructive"], ["sqlite3 a.db \"drop table t\"", "destructive"],
  ["mysql -e \"update t set x=1\"", "write"], ["mysql --execute='insert into t values (1)'", "write"],
  ["psql --command='select 1; truncate t'", "destructive"], ["mariadb -e\"alter table t add c int\"", "write"],
  ["sqlite3 -cmd 'delete from t' a.db", "destructive"], ["psql -c \"  DELETE FROM t\"", "destructive"],
] as const) check(`intent: ${c} → ${want}`, classifyIntent(c) === want);

// sed in-place inside a combined flag cluster.
for (const c of ["sed -Ei 's/a/b/' f", "sed -ni 'p' f", "sed -i.bak 's/a/b/' f", "sed -nEi.bak 's/a/b/' f"]) {
  check(`intent: ${c} → write`, classifyIntent(c) === "write");
}
check("intent: sed -e 's/i/j/' f is not in-place", classifyIntent("sed -e 's/i/j/' f") !== "write");

// docker removal verbs.
for (const c of ["docker rm -f web", "docker rmi app:old", "docker volume rm data", "docker compose down -v",
  "docker compose -f x.yml down --volumes", "docker-compose down -v", "docker image rm app", "docker container rm -f web"]) {
  check(`intent: ${c} → destructive`, classifyIntent(c) === "destructive");
}
for (const c of ["docker ps", "docker compose ps", "docker system df", "docker compose down"]) {
  check(`intent: ${c} is not destructive`, classifyIntent(c) !== "destructive");
}

// docker …prune deletes containers/images/volumes — destructive, was `unknown`.
for (const [c, want] of [
  ["docker system p" + "rune -af", "destructive"], ["docker volume p" + "rune", "destructive"],
  ["docker ps", "unknown"], ["docker system df", "unknown"],
] as const) check(`intent: ${c} → ${want}`, classifyIntent(c) === want);
check("warn: docker system prune is destructive (not silent unknown)", isWarn("docker system p" + "rune -af"));

// Archive extractors, compressors and find's file-writing predicates were `unknown`/`read-only` for every
// invocation, so read-only PLAN MODE executed them and changed the tree with no approval. Writes now;
// the stdout/test-only forms stay non-writes so reads keep working.
for (const [c, want] of [
  ["tar xf backup.tar", "write"], ["tar -xzf app.tar.gz -C /srv/app", "write"], ["tar czf out.tgz src", "write"],
  ["tar --extract --file a.tar", "write"], ["tar --create -f out.tar src", "write"], ["tar --delete -f a.tar", "write"],
  ["jar xf app.jar", "write"],
  ["unzip secrets.zip", "write"], ["7z x archive.7z", "write"], ["7za a out.7z src", "write"],
  ["gzip notes.txt", "write"], ["gunzip data.csv.gz", "write"], ["xz -9 payloads.bin", "write"],
  ["zstd -19 core.dump", "write"], ["bzip2 core", "write"], ["zip out.zip report.pdf", "write"],
  ["find . -fprint hits.txt", "write"], ["find . -name x -fprintf rep.txt %p", "write"], ["find . -fls l.txt", "write"],
] as const) check(`intent: ${c} → ${want}`, classifyIntent(c) === want);
for (const c of [
  "tar tvf app.tar.gz", "tar --list -f app.tar", "tar --to-stdout -xf a.tar",
  "unzip -l secrets.zip", "unzip -t secrets.zip", "unzip -p secrets.zip note.txt", "7z l archive.7z", "7z t archive.7z",
  "gzip -c notes.txt", "gzip -t notes.gz", "zcat notes.gz", "xzcat f.xz", "bzip2 -t archive.bz2",
  "zip -sf out.zip", "find . -type f -print", "find . -printf %p", "find . -ls",
] as const) {
  const i = classifyIntent(c);
  check(`archive read stays non-write: ${c} (${i})`, i !== "write" && i !== "destructive");
  check(`plan mode allows: ${c}`, !isBlock(c, { planMode: true }));
}
check("plan mode blocks tar xf", isBlock("tar xf backup.tar", { planMode: true }));
check("plan mode blocks unzip", isBlock("unzip secrets.zip", { planMode: true }));
check("plan mode blocks gzip file", isBlock("gzip notes.txt", { planMode: true }));
check("tar --to-command hook still classified", classifyIntent("tar xf a.tar --to-command='rm -rf x'") === "destructive");

// Review follow-ups: verb letters anywhere in a cluster, directory values before the verb, bsdtar/ar,
// zip's -l/-p (line endings / paths — still writes), lz4's -l (legacy format) and the lz4c compressor.
for (const c of [
  "tar -zxvf app.tgz", "tar -jxf a.tbz", "tar -Jcf o.txz src", "tar -zcvf o.tgz src", "tar -pxf a.tar",
  "tar -C tmp -xf a.tar", "tar -C src -xzf a.tgz", "tar x -f backup.tar", "bsdtar -xf a.tar", "gtar -xf a.tar",
  "jar cf out.jar x", "ar x lib.a", "ar rcs lib.a o.o", "zip -l out.zip x", "zip -rp out.zip dir", "zip -T out.zip newfile",
  "lz4 -l f", "lz4c f", "lz4 f out.lz4", "zstd -o out.zst f", "zstd -c f -o out.zst", "7z e a.7z", "7z -y x a.7z",
  "unzip -o a.zip", "unzip -d /tmp/x a.zip", "cpio -id < a.cpio", "cpio -p dst < list", "cpio --extract < a.cpio",
] as const) check(`archive write: ${c} → write`, classifyIntent(c) === "write");
for (const c of [
  "tar -tzvf a.tgz", "tar tf a.tar", "tar -xOf a.tar f", "tar -xf a.tar -O", "jar tf app.jar", "bsdtar -tf a.tar",
  "zipinfo a.zip", "unzip -v a.zip", "unzip -Z a.zip", "unzip -qq -l a.zip", "zip -T out.zip",
  "cpio -it < a.cpio", "cpio -ivt < a.cpio", "cpio -t < a.cpio", "ar t lib.a", "ar p lib.a x.o",
  "lz4 -c f", "zstd -dc f.zst", "gzip -dc f.gz", "7z i", "7z -bb3 l a.7z",
] as const) check(`archive read: ${c} → read-only`, classifyIntent(c) === "read-only");

// PLAN MODE IS DEFAULT-DENY: only commands classified read-only run. Everything else — unknown tools,
// network commands (which also write local files), and read-only tools used with a writing option — is
// blocked. These were the escapes the archive review listed.
for (const c of [
  "curl -o out.html https://x", "curl -O https://x/f", "curl --output f https://x", "curl https://example.com",
  "wget https://x/f", "rsync -av src/ dst/", "scp a host:b",
  "sort -o out in", "sort -uo out in", "sort in --output=out", "uniq in out", "uniq -c in out",
  "yq -i '.a=1' f.yaml", "yq --inplace '.a=1' f.yaml", "awk -i inplace '{print}' f", "gawk --include=inplace '{print}' f",
  "git archive -o out.zip HEAD", "git archive --output=out.tar HEAD", "git format-patch -3", "git diff --output=d.txt",
  "git bundle create repo.bundle --all", "tree -o t.txt", "less -o log.txt f", "xxd -r dump out", "date -s 12:00",
  "sed -f script.sed f", "split -b 1M f part", "csplit f 3", "shuf -o out in", "mkfifo p", "mktemp", "mktemp -d",
  "npm install", "pip install x", "make", "cargo build", "go build", "sqlite3 db \".output f\"",
  "base64 -d f -o out", "openssl enc -out f", "ssh-keygen -f k -N ''", "ffmpeg -i a.mp4 b.mp4", "convert a.png b.jpg",
  "ed -s f", "vim -c wq f", "setfacl -m u:x:r f", "xattr -w k v f", "exiftool -all= f.jpg", "strace -f git status",
] as const) check(`plan mode blocks (default-deny): ${c}`, isBlock(c, { planMode: true }));
for (const c of [
  "ls -la", "ls", "cat README.md", "cat f | grep x | wc -l", "rg foo src", "rg -n 'x' --type ts", "grep -rn TODO src",
  "head -50 f", "tail -n 20 f", "wc -l f", "find . -type f -name '*.ts'", "fd ts src", "tree -L 2", "pwd", "echo hi",
  "git status", "git status --short", "git log --oneline -5", "git diff", "git diff HEAD~1 -- src", "git show HEAD",
  "git branch -a", "git blame f", "git archive HEAD | tar -t", "git format-patch --stdout -1",
  "sed -n 1,20p f", "awk '{print $1}' f", "sort f | uniq -c", "uniq -c in", "jq . package.json", "yq '.a' f.yaml",
  "diff a b", "stat f", "du -sh .", "which bun", "date", "date -Iseconds", "xxd f", "ps aux", "sha256sum f",
  "tar tf a.tar | head", "unzip -l a.zip", "zcat f.gz | head", "cat f 2>&1 | head",
] as const) check(`plan mode allows (read-only): ${c}`, isAllow(c, { planMode: true }));

if (fail) { console.error("\n✗ bash-validation smoke FAILED"); process.exit(1); }
console.log("\n✓ bash-validation smoke passed");
