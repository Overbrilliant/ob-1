# OB-1 Quickstart

OB-1 has three supported paths. Start with the free path unless you already know which endpoint you want.

## 1. Free

```sh
brew install overbrilliant/tap/ob1
ob1
```

Choose **Start free**. OB-1 works instantly through its embedded free-models router — 150+ free models
across 20+ providers, no server to start, no account, no card. Keyless providers (Kilo, Pollinations,
OVH, LLM7) answer your first message with zero setup.

For stronger free-tier capacity, add your own free provider keys to `~/.ob1/keys.env`. Saving the file
activates the provider on your next message — no restart.

Useful commands:

```text
/free
/models
```

## 2. Your Own Endpoint

Use `/models` and choose a named provider or Custom. You can also use env vars without writing secrets
to settings:

```sh
OB1_BASE_URL=http://localhost:11434/v1 OB1_API_KEY=local ob1
OPENROUTER_API_KEY=sk-or-v1-... ob1
GEMINI_API_KEY=... ob1
GROQ_API_KEY=... ob1
```

`OB1_BASE_URL` is an explicit runtime override and wins over saved provider settings. Named provider
keys such as `OPENROUTER_API_KEY` are used when no saved provider or hosted subscription is configured.
Runtime env routes are never persisted.

## 3. Hosted Frontier

```sh
ob1 login
/models
```

Choose a hosted frontier model after subscribing. The hosted tier is the convenience tier: Claude, GPT,
Gemini, Grok, DeepSeek, Qwen, and search through one OB-1 account and one billing balance.
