# Demo Tapes

These Charm VHS tapes record the **real binary** — no `Type`-faked output. All three GIFs were recorded
2026-07-02 from genuine sessions and are embedded in the README; the marketing site's
`static/media/ob1-*.gif` are the same recordings.

| Tape | GIF | Shows |
|---|---|---|
| `start-free.tape` | `docs/media/start-free.gif` | first run → FreeLLMAPI auto-setup → TUI ready (no key/account) |
| `first-task.tape` | `docs/media/first-task.gif` | agent writes `primes.py`, runs it, shows real output |
| `memory-graph.tape` | `docs/media/memory-graph.gif` | `/memory` facts + relationship graph from real work |

```sh
export OB1_DEMO_HOME="$(mktemp -d)" OB1_DEMO_PROJECT="$(mktemp -d)"
vhs demos/start-free.tape     # pass 1: slow (real npm install); then reset state per tape header
vhs demos/start-free.tape     # pass 2: short final take against the warm clone
pkill -f "server/dist/index.js"   # stop the demo proxy afterwards
```

`first-task.tape` and `memory-graph.tape` need a working provider (a FreeLLMAPI proxy with ≥1 live
provider key, or any OpenAI-compatible endpoint) — anonymous-only pools can be rate-limit-exhausted.
See each tape's header for setup.

Post-processing (raw take → committed GIF), e.g. for the task demo:

```sh
ffmpeg -y -t 66 -i docs/media/first-task-raw.gif \
  -vf "fps=10,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
  docs/media/first-task.gif
gifsicle -O3 --lossy=80 --colors 96 docs/media/first-task.gif -o docs/media/first-task.gif
```

Recording rules:

- **Never fake output.** If a flow can't be recorded (e.g. anonymous model pools exhausted), wait or
  fix the flow — don't type the expected text.
- Sleep-based timing only; VHS 0.11's `Wait+Screen`/`Screenshot` abort these recordings.
- `unset OB1_SERVER` and provider env keys in the hidden preamble, or the CLI skips onboarding.
- Re-render all three tapes at each release so the banner version matches the shipped binary.
