# Hosted API

The hosted tier is the paid convenience path. The open-source CLI, FreeLLMAPI, and your own endpoints do
not depend on it.

## What Subscribers Get

- OpenAI-compatible `POST /v1/chat/completions`.
- `GET /v1/models` with hosted model ids, context windows, capabilities, and retail pricing.
- `POST /v1/search` for hosted search.
- `GET /v1/usage` for credits, token totals, model breakdowns, and recent events.
- `GET /v1/usage/export` for CSV usage export.
- Account pages for billing, CLI token management, password reset, and account deletion.

## Billing

Hosted model credits spend at OpenRouter cost plus 30%. The margin pays for key custody, subscription
billing, prompt-cache routing, usage dashboards, and one balance across frontier providers.

## CLI Flow

```text
ob1 login
/upgrade
/models
```

If hosted credits are exhausted, the CLI should show the pricing/upgrade path. FreeLLMAPI and custom
endpoints keep working without a hosted subscription.
