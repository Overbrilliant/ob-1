# Free-Tier Capacity Ledger

This page is the launch ledger behind the "~1.7B tokens/month" FreeLLMAPI claim. Do not publish a
numeric headline unless each row has been checked against the provider's current public limits and terms
during launch week.

## Accounting Rule

Count only capacity that satisfies all of these:

1. The user runs their own local FreeLLMAPI instance.
2. The user supplies their own provider account/key when a provider requires one.
3. The provider's public free tier allows the intended API use.
4. Limits are expressed in a comparable monthly token estimate, with request/minute and daily caps noted.

Anonymous routes can make first-token setup work, but they should not carry the headline monthly capacity
claim unless their public terms and practical limits are verified.

## Launch Table

| Provider | FreeLLMAPI role | Capacity to verify | Launch note |
|---|---|---|---|
| Gemini | User-added key | Monthly token/request allowance for OpenAI-compatible Gemini API use | Good BYOK path; verify model-specific caps. |
| Groq | User-added key | Free developer allowance and rate limits | Fast hosted open models; verify daily/request caps. |
| Cerebras | User-added key | Free inference allowance and rate limits | Verify whether free limits are account, project, or model scoped. |
| Mistral | User-added key | Free API or trial allowance usable by a local client | Do not count expiring promotional credits as durable free tier. |
| GitHub Models | User-added key | Free request/token allowance and eligibility | Verify account eligibility and model availability. |
| Cohere | User-added key | Free API allowance and rate limits | Convert request limits to token estimate conservatively. |
| Pollinations | Anonymous route | Public anonymous usage posture and throttling behavior | First-token route; avoid promising durable monthly capacity. |
| LLM7 | Anonymous route | Public anonymous usage posture and throttling behavior | First-token route; verify client/proxy use. |
| OVH | Anonymous route | Public anonymous usage posture and throttling behavior | First-token route; verify availability and caps. |
| Kilo | Anonymous route | Public anonymous usage posture and throttling behavior | First-token route; verify terms before launch. |

## How to Publish the Number

Use a short footnote next to the headline:

> Capacity estimate sums provider-published free tiers available to a user running their own local
> FreeLLMAPI instance with their own provider accounts. Actual availability depends on provider limits,
> region, account eligibility, and model choice.

Keep a dated snapshot in release notes whenever the headline changes. If a provider removes or reduces a
free tier, update the table and lower the headline quickly.

## HN FAQ Answer

OB-1 is free because the first tier runs on the user's machine. FreeLLMAPI gives the CLI one local
OpenAI-compatible endpoint, starts with anonymous bootstrap routes, and lets users add their own free
provider keys. Overbrilliant does not run a shared free model pool.
