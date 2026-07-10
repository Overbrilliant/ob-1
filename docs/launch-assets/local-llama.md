# r/LocalLLaMA Launch Angles

Use technical posts with reproducible commands. Avoid marketing language.

## Angle 1: An Embedded Router for Free-Tier Model Pooling

Title:

```text
I gave OB-1 an embedded router that pools 20+ free-tier model providers
```

Outline:

- Problem: coding agents usually start by asking for a paid key.
- Design: OB-1 has an in-process free-models router — no server, no clone — that pools free tiers
  across 20+ cloud providers and picks the best available model per request.
- Keyless providers (Kilo, Pollinations, OVH, LLM7) work immediately; serious usage means adding your
  own provider keys to `~/.ob1/keys.env`.
- The same CLI can switch to Ollama, LM Studio, llama.cpp, vLLM, or a LAN GPU endpoint.
- Ask: feedback on the routing model, failover behavior, and failure modes.

Commands:

```sh
brew install overbrilliant/tap/ob1
ob1
/models
/free
```

## Angle 2: Persistent Memory Graph

Title:

```text
I gave a terminal coding agent an inspectable project memory graph
```

Outline:

- OB-1 stores project facts, revisions, and relationships locally.
- `/memory` inspects stored facts; graph export makes memory reviewable.
- The memory is not a hidden hosted profile.
- Ask: what memory should a coding agent keep, and what should it forget?

Commands:

```text
/memory
/memory add <fact>
/memory search <query>
/memory export dot
```

## Angle 3: LAN GPU Workflow

Title:

```text
Running OB-1 against a LAN vLLM/Ollama endpoint
```

Outline:

- Set `OB1_BASE_URL` to the LAN endpoint.
- Use `OB1_MODEL` to pin a served model.
- Keep secrets out of settings with runtime env vars.
- Use `/models` later to save a local profile if desired.

Command:

```sh
OB1_BASE_URL=http://<lan-gpu-host>:8000/v1 OB1_API_KEY=local OB1_MODEL=qwen2.5-coder ob1
```
