# Free-Tier Capacity Ledger

This page is the launch ledger behind the "150+ free models across 20+ providers" claim. Do not publish
a numeric headline unless each row has been checked against the provider's current public limits and
terms during launch week.

## Accounting Rule

Count only capacity that satisfies all of these:

1. The capacity comes from OB-1's embedded free-models router pooling a provider's free tier.
2. The user supplies their own provider account/key when a provider requires one (added to
   `~/.ob1/keys.env`).
3. The provider's public free tier allows the intended API use.
4. Limits are expressed in a comparable monthly token estimate, with request/minute and daily caps noted.

Keyless routes can make first-token setup work, but they should not carry the headline monthly capacity
claim unless their public terms and practical limits are verified.

## Launch Table

| Provider | Router role | Capacity to verify | Launch note |
|---|---|---|---|
| Gemini | User-added key | Monthly token/request allowance for OpenAI-compatible Gemini API use | Good BYOK path; verify model-specific caps. |
| Groq | User-added key | Free developer allowance and rate limits | Fast hosted open models; verify daily/request caps. |
| Cerebras | User-added key | Free inference allowance and rate limits | Verify whether free limits are account, project, or model scoped. |
| Mistral | User-added key | Free API or trial allowance usable by the router | Do not count expiring promotional credits as durable free tier. |
| GitHub Models | User-added key | Free request/token allowance and eligibility | Verify account eligibility and model availability. |
| Cohere | User-added key | Free API allowance and rate limits | Convert request limits to token estimate conservatively. |
| Pollinations | Keyless route | Public keyless usage posture and throttling behavior | First-token route; avoid promising durable monthly capacity. |
| LLM7 | Keyless route | Public keyless usage posture and throttling behavior | First-token route; verify client/router use. |
| OVH | Keyless route | Public keyless usage posture and throttling behavior | First-token route; verify availability and caps. |
| Kilo | Keyless route | Public keyless usage posture and throttling behavior | First-token route; verify terms before launch. |

## How to Publish the Number

Use a short footnote next to the headline:

> Capacity estimate sums provider-published free tiers pooled by OB-1's embedded free-models router,
> using the user's own provider accounts where a key is required. Actual availability depends on
> provider limits, region, account eligibility, and model choice.

Keep a dated snapshot in release notes whenever the headline changes. If a provider removes or reduces a
free tier, update the table and lower the headline quickly.

## HN FAQ Answer

OB-1 is free because the first tier runs inside the CLI itself. The embedded free-models router pools
free tiers across 20+ cloud providers, starts with keyless routes, and lets users add their own free
provider keys to `~/.ob1/keys.env` for more capacity. Overbrilliant does not run a shared free model
pool; each user's own keys call each provider directly.
