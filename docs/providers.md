# Providers and Configuration

OB-1 speaks OpenAI-compatible HTTP for every provider path.

## Built-In Profiles

| Profile | Default endpoint | Key env |
|---|---|---|
| Free models | Embedded router, in-process | keys in `~/.ob1/keys.env` (optional) |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Ollama | `http://localhost:11434/v1` | optional |
| LM Studio | `http://localhost:1234/v1` | optional |
| llama.cpp | `http://localhost:8080/v1` | optional |
| vLLM | custom host | optional |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| Custom | any OpenAI-compatible URL | `OB1_API_KEY` |

## Precedence

1. `OB1_BASE_URL` plus `OB1_API_KEY`.
2. Well-known provider env keys such as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
   `GOOGLE_API_KEY`, and `GROQ_API_KEY`.
3. Saved provider settings from `/models`.
4. Hosted OB-1 managed route.

Env keys are runtime-only. `saveSettings()` preserves the saved profile and never writes env secrets.

## Free Models

OB-1 has an embedded free-models router: 150+ free models across 20+ cloud providers, routed in-process
inside the CLI. There is no separate proxy, no local state file for a managed checkout, and no
dashboard. Add your own free provider keys to `~/.ob1/keys.env`; saving the file activates a provider on
your next message, no restart.

### Keyless Providers

Four providers need no key at all and are usable the moment you start OB-1:

| Route | What to expect | When to add keys |
|---|---|---|
| Pollinations | Keyless free model access, variable capacity | Add keys before serious coding loops |
| LLM7 | Keyless free model access, variable quality | Add keys when output quality matters |
| OVH | Keyless free model access, provider throttling possible | Add keys for longer sessions |
| Kilo | Keyless free model access, shared limits possible | Add keys for repeatable agent work |

Keys you add stay in `~/.ob1/keys.env` on your machine; OB-1 calls each provider directly with your own
key. There is no unified key and no server-side key store.

See [Free models guide](free-models.md) for the keys file, routing strategies, and the `/free` command,
and [Free-tier capacity ledger](free-tier-capacity.md) for the launch verification table behind the
free-tier headline.

### Gemini BYOK Example

`GEMINI_API_KEY` uses Google's OpenAI-compatible Gemini endpoint at runtime. `OB1_MODEL` pins the model
for that process, and neither variable is written to `settings.json`.

```sh
GEMINI_API_KEY=... OB1_MODEL=gemini-2.5-pro ob1
```

### Vision Escape Hatch

OB-1 only sends screenshots from `browser_check` to models it knows are vision-capable. If your custom
endpoint or router model supports images but is not in OB-1's built-in registry, force image attachment
for that process:

```sh
OB1_FORCE_VISION=1 OB1_BASE_URL=http://localhost:11434/v1 OB1_MODEL=my-vision-model ob1
```

Use this only for endpoints that really accept image content. Text-only endpoints may reject requests
once screenshots are attached.
