# Providers and Configuration

OB-1 speaks OpenAI-compatible HTTP for every provider path.

## Built-In Profiles

| Profile | Default endpoint | Key env |
|---|---|---|
| FreeLLMAPI | `http://127.0.0.1:49317/v1` managed by OB-1 | managed locally |
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

## FreeLLMAPI

OB-1 stores FreeLLMAPI state in `~/.ob1/freellm.json` and the managed checkout in
`~/.ob1/freellmapi`. The proxy binds to localhost by default and reuses the existing install on later
runs.

Anonymous providers are useful for first-token setup. For better quality, add free provider keys in the
FreeLLMAPI dashboard.

### Anonymous Providers

FreeLLMAPI is usable before you add provider keys because it includes anonymous routes. These are best
for setup, quick checks, and low-stakes edits; they can throttle, disappear, or vary in quality. Add your
own provider keys in the local FreeLLMAPI dashboard when you need stronger models and more predictable
capacity.

| Route | What to expect | When to add keys |
|---|---|---|
| Pollinations | Anonymous free model access, variable capacity | Add keys before serious coding loops |
| LLM7 | Anonymous free model access, variable quality | Add keys when output quality matters |
| OVH | Anonymous free model access, provider throttling possible | Add keys for longer sessions |
| Kilo | Anonymous free model access, shared limits possible | Add keys for repeatable agent work |

The dashboard stores user-added provider keys inside FreeLLMAPI, encrypted at rest. OB-1 only talks to
the single local `/v1` endpoint and the unified FreeLLMAPI key.

See [FreeLLMAPI guide](freellmapi.md) for the managed lifecycle and [Free-tier capacity ledger](free-tier-capacity.md)
for the launch verification table behind the free-tier headline.

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
