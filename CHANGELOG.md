# Changelog

All notable OB-1 CLI changes are documented here.

## [Unreleased]

## [0.3.13] - 2026-09-25

- Bash safety: commands run through scheduling and buffering wrappers are now classified by the command
  they run. `ionice`, `stdbuf`, `taskset`, `chrt`, `setsid` and `unbuffer` are parsed like `sudo`/`env`/
  `timeout`, including their own options (`ionice -c 3 -n 7`, `stdbuf -o L`, `taskset -c 0` or a mask,
  `chrt -f 99`, `setsid -fw`, `--`). So `ionice -c3 rm -rf /` or `taskset -c 0 rm -rf /` is refused, not
  run as `unknown`. Path-prefixed wrappers (`/usr/bin/env`, `/usr/bin/sudo`, `/usr/bin/nice`, …) are
  stripped too: `/usr/bin/env rm -rf /` used to read as read-only and could run in Plan mode. Also:
  `nice -n5`, `nice --adjustment=N`, `timeout -s SIG` / `-k DUR`. `taskset -p`, `chrt -p` and
  `ionice -p` (which change a running process) are no longer read-only.

## [0.3.12] - 2026-09-24

- Bash safety: commands smuggled into another command's arguments are now classified by what they
  actually run. Interpreter one-liners (`python3 -c`, `perl -e/-E`, `node -e/--eval/-p`, `ruby -e`,
  `php -r`, `deno eval`, …) are scanned for destructive file APIs (`shutil.rmtree`, `os.remove`,
  `fs.rmSync`, `unlinkSync`, `rm_rf`, …), shell-outs (`os.system`, `subprocess`, `execSync`, `system()`)
  and file writes, and harmless ones stay `unknown` rather than `write`. Also covered: `awk`/`gawk`/`mawk`
  `system()` and pipes to `sh`, `watch`, `parallel`/`sem`, `sed` `e`/`s///e`, tar `--checkpoint-action=exec`
  / `--to-command`, command-valued `git -c` keys, `rsync --delete*`/`--remove-source-files`, `docker
  run/exec/compose`, and `$(…)`/backtick substitution. `doas`, `pkexec` and `run0` are stripped like
  `sudo` (value-taking flags such as `sudo -u root` are now skipped too), so `doas rm -rf /` is refused.
  Root/home targets inside code (`system("rm -rf /")`, `shutil.rmtree('/')`) are refused like `rm -rf /`.

## [0.3.11] - 2026-09-23

- Bash safety: commands run from another command's arguments are now classified too. `find … -delete`
  and the command behind `find -exec/-execdir/-ok/-okdir`, `fd -x/-X`, `xargs`, `sh/bash/zsh -c '…'` and
  `eval` count toward the line's intent, so `find / -exec rm -rf {} \;`, `xargs -n1 rm`,
  `sh -c 'rm -rf /'` and `busybox rm -rf /` are no longer read-only or unknown: plan mode blocks them,
  the approval prompt flags them, and root/home/system-path targets are refused. `truncate` and
  `unlink` are now destructive, and `busybox` is stripped like `sudo`.
- Test-edit guard for the self-fix loop: during a self-correction round, `write_file` / `edit_file` /
  `architect_edit` to a path matching a test pattern (`test/`, `tests/`, `spec/`, `__tests__/`,
  `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`) is refused and the model is told to fix the source or
  say the test is wrong. Outside a fix round, a test-file edit that follows a failing check is allowed
  but flagged in the run output, next to the final `✓ verified` line, and as a review finding in the
  quality ledger. `OB1_TEST_EDIT_GUARD=refuse|flag|off` (default `refuse`). Answers the "what stops the
  loop from patching the test instead of the bug" question.

## [0.3.10] - 2026-09-22

- Bash safety: `env …`, `timeout …` and `nice …` wrappers are now stripped before a command is
  classified, so `env rm -rf /` no longer passes as read-only and `timeout 5 rm -rf /` no longer
  slips through as unknown. Wrapper forms that cannot be parsed fail closed to `unknown`.
- `web_fetch`: redirects are followed manually (at most five hops) and every hop is re-checked
  against the SSRF guard, both by literal host and by what it resolves to — a public page that
  302s to the cloud metadata IP or a loopback service is refused. Also blocks the v4-compatible
  IPv6 spelling of loopback (`::7f00:1`), `localhost.` and the CGNAT range 100.64.0.0/10.

## [0.3.9] - 2026-08-25

- MCP config is now shared with Claude Code: OB-1 reads `.mcp.json` and `.ob1/.mcp.json` in addition to
  the existing `.ob1/mcp.json` and `mcp.json`. The file shape was already identical, so a project's
  existing Claude Code config works with no second file to maintain. Dot-forms take precedence; every
  previously supported path keeps working. Thanks @LoneRifle (#16, #18).
- An MCP config that parses but has no top-level `mcpServers` key now warns at startup instead of
  silently loading nothing — including the common `{"mcp": {"servers": ...}}` mistake. A deliberate
  `{"mcpServers": {}}` stays silent. Corrected the config shape shown in `docs/mcp.md`. Thanks
  @LoneRifle (#17).
- New "blast-radius" eval task (`side-effect-after-txn-commit`): a multi-call-site fixture that grades
  completeness of a fix across a call graph — direct, transitive and nested violations plus an
  already-correct decoy — rather than single-function synthesis. Thanks @LoneRifle (#19, #20).

## [0.3.8] - 2026-08-19

- Rewrote the npm package description around what OB-1 actually gives you: a free open-source coding
  agent that runs with no account, no API key and no card.
- Added npm keywords for the terms people search when they want exactly that, including `free`,
  `no-api-key`, `keyless`, `open-source` and `ai-coding-agent`.

## [0.3.7] - 2026-07-08

- Free-model catalog refresh now starts in the background when the Free models provider is active, then
  polls regularly so free and paid catalogs stay current without waiting for a model call.
- Reworded free-model catalog copy around the actual entitlement: free users get new free models after
  30 days; hosted plans get them immediately.

## [0.3.6] - 2026-07-08

- When `/upgrade` or `/subscribe` sees a payment clear, the running TUI now force-refreshes the signed
  catalog immediately, so newly released free models unlock in-session without waiting for the normal
  refresh interval.

## [0.3.5] - 2026-07-08

- Free models now refresh from OB-1's signed catalog endpoint: free/anonymous sessions get models after the
  30-day promotion window, while signed-in hosted plans get newly released free models immediately.
- The CLI verifies catalog signatures before activating a refreshed catalog, keeps separate free/paid
  caches, and falls back to the bundled free catalog offline.
- Updated free-model copy to avoid stale fixed-count claims and show the active catalog tier in `/free`.

## [0.3.4] - 2026-07-07

- Polished first-run onboarding copy to match the final Free, endpoint, and Hosted frontier flows.
- Simplified Hosted frontier setup so it sends users straight into account signup from the CLI.
- Updated the fresh-install smoke expectation for the new free-models activation summary.

## [0.3.3] - 2026-07-07

- Changed `/mode` to the user-facing execution picker: `auto`, `act`, and `plan`.
- Added Auto mode as the no-questions-asked path: mutating tools run without prompts.
- Kept Plan and Act as compatibility shortcuts, but removed them from the primary slash menu.
- Moved forced best-of-N orchestration to `/fusion`; `/solo` exits it.

## [0.3.2] - 2026-07-07

- Fixed installed `/login` being hijacked by a stale `OB1_SERVER=http://localhost:8787` shell export.
  Localhost server overrides now require `OB1_ALLOW_LOCAL_SERVER=1`; remote self-hosted `OB1_SERVER`
  overrides still work normally.

## [0.3.1] - 2026-07-07

- Added in-session `/login` and `/logout` browser auth commands.
- Added `/subscribe` as a visible alias for opening the signed-in subscription page.
- Changed `/plan` into a Plan/Act toggle; `/plan on`, `/plan off`, and `/act` remain explicit paths.

## [0.3.0] - 2026-07-07

Verified multi-agent rework. OB-1 now spends extra compute only when it can prove the extra compute was
needed, and it grounds every multi-agent decision in your project's own checks instead of a model's
self-opinion.

- Fusion v2 is selection-first best-of-N: it generates N candidate attempts and picks the winner by an
  objective verifier signal auto-detected from your project (build, typecheck, tests, linters — whatever
  the repo actually has), with zero configuration. When no signal exists it falls back to synthesis rather
  than guessing.
- Verified escalation is ON by default: a turn runs a single agent first, and only escalates to best-of-N
  after automated checks prove that single-agent attempt failed. Easy work stays 1× — the extra agents are
  spent when, and only when, a check says the first attempt did not pass.
- Added `/review`: an independent reviewer that reviews the working diff and tries to REFUTE each of its own
  findings before reporting them, so you get the surviving issues instead of a wall of speculation. It also
  runs automatically after an escalated apply.
- Added `/deep`: adaptive generate-vs-refine search for hard problems, using AB-MCTS-style Thompson sampling
  to decide at each step whether to widen (try a new approach) or deepen (refine an existing one), with
  verified early-stop.
- Removed the modes our own compute-matched evaluations showed did not beat a single agent given the same
  budget: personas, council, fanout, ledger, and the adaptive router. `/review` and `/deep` remain because
  they earned their place.
- Added a 42-task evaluation suite (every check proven to actually discriminate) and adopted the policy that
  a mode which cannot beat compute-matched Solo gets deleted.
- Added the first unit-test suite: 83 tests across the multi-agent core (fusion, reviewer, deep, evaluate)
  and the agent loop.
- Fusion now handles honest prose answers (a candidate that correctly says "nothing to change" is no longer
  penalized against candidates that edited files).
- Free-models router now fails a fusion candidate over to the next provider on a 429 instead of aborting the
  candidate.
- Fixed keyless custom endpoints: an env/custom OpenAI-compatible endpoint with no API key is now treated as
  reachable instead of being skipped.

## [0.2.0] - 2026-07-06

- Free models: replaced the external FreeLLMAPI service with an embedded free-models router that runs
  in-process inside the CLI — no second process, no local server, no git clone, no Docker/Node
  dependency, and no dashboard to run or sign into.
- Free models: added one editable keys file at `~/.ob1/keys.env` (owner-only, auto-generated template).
  Adding or removing a provider key activates or deactivates it on your next message, no restart.
- Free models: keyless providers (Kilo, Pollinations, OVH, LLM7) work with zero setup, so OB-1 answers
  the first message with no keys and no account.
- Added `/free` (status, keys, strategy, health) to manage the free-models pool, and a "Free models ▸"
  entry under `/models` to pick `auto` or pin a specific model.
- Added routing strategies for the free-models router: `priority`, `balanced` (default), `smartest`,
  `fastest`, `reliable` — with automatic failover, rate-limit window tracking, escalating cooldowns after
  429s, and a reliability score.
- Migration: existing "freellmapi" setups are automatically migrated to the embedded "free" router
  (model `auto`) on next launch. No action needed. The external FreeLLMAPI service is no longer needed.
- Removed `/freellm`.

## 0.1.5 - 2026-07-05

- Safety: the trust gate is now ON BY DEFAULT — a first run in a new/untrusted folder starts in `ask`
  (prompt before each edit/command) instead of autopilot. An explicit choice (`OB1_PERMISSION` or a saved
  preference) and trusted folders are unaffected; `/trust` enables autopilot for the current folder.
- Safety: friendly crash handling — an unhandled rejection/exception now renders a readable message and
  reaps child processes instead of dumping a raw stack trace.
- Onboarding: the free path no longer dead-ends when Docker/Node are missing (it falls through to endpoint
  and hosted options), and Esc at the first picker starts the free path (matching the README).
- npm: added a `files` allowlist and a `bin/ob1.mjs` Node shim so `npm i -g @overbrilliant/ob1` works
  without a global Bun (the shim locates Bun or prints an actionable install message).
- Attribution: browser-opened auth/checkout URLs now carry a `source=cli*` tag so signups and checkouts can
  be attributed to the CLI.
- Process hygiene: foreground shell commands spawn detached and group-kill their children on cancel.

## 0.1.4 - 2026-07-02

- Made the first-run contract explicit: FreeLLMAPI is the default free path, BYOK/env endpoints are
  first-class, and hosted frontier models are the optional paid convenience tier.
- Added runtime env routing for `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `GROQ_API_KEY`, and `OB1_BASE_URL` / `OB1_API_KEY`.
- Added named OpenAI-compatible provider presets for OpenRouter, Ollama, LM Studio, llama.cpp, vLLM,
  Groq, and Custom endpoint.
- Kept FreeLLMAPI references on the existing public repository while making it the default free path.
- Added update-check plumbing, Biome config, demo assets, contributor templates, and architecture docs.

OB-1-written share: record this per release once the release branch is cut. Suggested command:

```sh
git diff --shortstat "$(git describe --tags --abbrev=0)..HEAD"
```
