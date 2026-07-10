# Hosted API

The hosted tier is the paid convenience path. The open-source CLI, free models, and your own endpoints do
not depend on it.

## What Subscribers Get

- OpenAI-compatible `POST /v1/chat/completions`.
- `GET /v1/models` with hosted model ids, context windows, capabilities, and retail pricing.
- `POST /v1/search` for hosted search.
- `GET /v1/usage` for credits, token totals, model breakdowns, and recent events.
- `GET /v1/usage/export` for CSV usage export.
- Account pages for billing, CLI token management, password reset, and account deletion.

## Billing

Each plan includes a monthly credit balance that spends across frontier models at the per-model prices
returned by `GET /v1/models` (and shown in the app). One balance, no keys to manage — credits cover key
custody, subscription billing, prompt-cache routing, usage dashboards, and search. Free models and your
own endpoints stay free.

## CLI Flow

```text
ob1 login
/upgrade
/models
```

If hosted credits are exhausted, the CLI should show the pricing/upgrade path. Free models and custom
endpoints keep working without a hosted subscription.
