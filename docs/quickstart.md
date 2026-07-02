# OB-1 Quickstart

OB-1 has three supported paths. Start with the free path unless you already know which endpoint you want.

## 1. Free

```sh
brew install overbrilliant/tap/ob1
ob1
```

Choose **Start free**. OB-1 provisions FreeLLMAPI locally, starts it on localhost, creates a local
dashboard account, fetches the unified key, and writes the endpoint into `~/.ob1/settings.json`.

Anonymous providers are a bootstrap path with variable quality and shared limits. Add provider keys in
the FreeLLMAPI dashboard when you want stronger free-tier capacity.

Useful commands:

```text
/freellm
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
