# Hacker News Launch Copy

Link target: <https://github.com/Overbrilliant/ob-1>

## Title

```text
Show HN: OB-1 - free open-source coding agent with persistent memory
```

## First Comment

```text
Hi HN, I built OB-1 because coding agents arrived metered and forgetful.

OB-1 is an Apache-2.0 terminal coding agent. The default path starts free: the CLI provisions a local
FreeLLMAPI gateway, can use anonymous bootstrap routes, and lets you add your own provider keys for
reliable capacity. No card, no account, no hosted trial pool.

The second part is memory. OB-1 keeps an inspectable project memory graph: facts, revisions,
relationships, and exports are visible from the CLI. The goal is that a long-lived project gets more
useful over time without locking you into one model vendor.

The paid business model is separate: hosted frontier models are the convenience tier for people who
want one account, managed keys, usage dashboards, search, and one bill. The CLI keeps working with
FreeLLMAPI, OpenRouter, Ollama, LM Studio, llama.cpp, vLLM, Groq, Gemini, and any OpenAI-compatible
endpoint.

I would especially like feedback on the first-run install, the FreeLLMAPI setup path, and whether the
memory graph is useful in real projects.
```

## Fast Replies

**How is this different from OpenCode or aider?**

OB-1 is trying to own a narrower wedge: free local first-run, durable inspectable memory, and
compute-matched multi-agent modes. OpenCode and aider are both strong tools; OB-1 should be judged on
whether the free path and memory graph matter in practice.

**Can the free tier disappear?**

The free path runs on the user's machine through FreeLLMAPI and the user's own provider accounts. It is
not a hosted trial-credit pool.

**Is the hosted service required?**

No. It is the paid convenience tier. The CLI speaks OpenAI-compatible HTTP and works with local/self-hosted
endpoints.

**What about ToS?**

The defensible posture is local and user-owned: each user runs their own proxy and uses their own
provider accounts. Provider-specific limits still need to be respected.
