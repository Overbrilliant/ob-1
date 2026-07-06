# Free Models Guide

OB-1 has an embedded free-models router built into the CLI process. It pools the free tiers of 20+
cloud providers — 150+ free models across 20+ providers — and picks the best available model for every
request. There is no second process, no localhost server, no git clone, no Docker or Node dependency,
and no dashboard to sign into. Some providers are keyless, so OB-1 works instantly on first run with no
keys and no account.

## What It Is

The router runs in-process, inside `ob1` itself. It is not a proxy you start or stop, and it does not
bind a port. "Embedded" means the routing logic — provider selection, failover, rate-limit tracking — all
happens inside the CLI. The models themselves are remote cloud APIs (Google AI Studio, Groq, OpenRouter,
GitHub Models, NVIDIA NIM, Cerebras, Mistral, Cohere, Cloudflare Workers AI, HuggingFace, and more); OB-1
calls them directly over HTTPS. Nothing here is local or on-device — the router is local, the models are
cloud.

## The Keys File

Unlocking the larger pool of providers means adding your own free API keys to one editable file:

```text
~/.ob1/keys.env
```

(Override the directory with `OB1_SETTINGS_DIR` if you keep OB-1 state elsewhere.)

OB-1 creates this file automatically, owner-only (`0o600`), with a generated template grouped into
"Recommended" best-free-tier providers, "More providers," and a note about the keyless four. It is plain
env-style text: one `NAME=value` pair per line, `#` starts a comment, and values may be quoted.

```sh
# Recommended
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY="AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# More providers
# MISTRAL_API_KEY=
# COHERE_API_KEY=
```

Add a key and save the file — that provider's models activate and start routing on your very next
message. No restart needed. Delete or comment out a key to deactivate that provider the same way. Keys
never leave your machine except to call that provider's API directly; there is no shared or unified key
and no encrypted server-side store.

## Keyless Providers

Kilo, Pollinations, OVH, and LLM7 work with zero setup — no key, no account, anonymous free tier. This is
why OB-1 can answer your first message with no configuration at all.

## Routing Strategies

Every request routes to the best available model for the active strategy:

| Strategy | What it optimizes |
|---|---|
| `priority` | Catalog order — a fixed preference list. |
| `balanced` | Default — mixes quality, speed, and availability. |
| `smartest` | Quality first. |
| `fastest` | Throughput first. |
| `reliable` | Fewest recent failures. |

Set one with:

```text
/free strategy <name>
```

or pick one from the `/free` picker.

## The `/free` Command

`/free` manages the whole pool from inside OB-1:

- `/free status` — status summary (active providers, current strategy, health).
- `/free keys` — open the keys file for editing.
- `/free strategy <name>` — switch routing strategy.
- `/free health` — re-check provider health now.
- `/free` with no argument opens the picker: status summary, open keys file, browse providers
  (read-only), pick a strategy, or re-check health.

## Pinning a Specific Model

By default the router picks automatically. To pin one model instead, use:

```text
/models
```

and expand **Free models ▸**. The first row is `auto — best available (recommended)`; below it is the
full catalog so you can pin a specific `platform/modelId`. Picking an entry sets the active model; picking
`auto` goes back to automatic routing.

## Failover, Cooldowns, and Health

Every request goes to the best available model for the active strategy. If a provider is throttled
(rate-limited) or fails, OB-1 benches it for an escalating cooldown window and tries the next-best
provider automatically — you don't see the failure, just a response. Health is re-checked in the
background, and a provider comes back into rotation once it recovers. Keyless providers are treated as
healthy by default since they need no setup to start working.

## Limits Are Real

These are free tiers, and free tiers have rate limits. OB-1's router spreads load and fails over to keep
you working, but it cannot manufacture capacity a provider doesn't offer. Adding more of your own keys
means more headroom: more providers to fail over across, and higher aggregate rate limits before you hit
a wall.
