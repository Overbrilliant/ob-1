# Troubleshooting

## Free Models: No Keyed Providers / Rate Limited

If free-model responses feel slow, low-quality, or rate-limited, you are likely running only on keyless
providers (Kilo, Pollinations, OVH, LLM7), which have shared, variable limits. Add your own free provider
keys to `~/.ob1/keys.env` — saving the file activates the provider on your next message, no restart.

```text
/free health
/free strategy <name>
```

`/free health` re-checks provider status now instead of waiting for the background check. `/free
strategy` switches routing behavior (for example `reliable` to favor providers with fewer recent
failures, or `fastest` for throughput). See the [Free models guide](free-models.md) for the full keys
file format and strategy list.

## Missing Playwright Browser

The browser-check tool loads Playwright lazily. If the optional browser binary is missing, install it
only when you need browser automation. The error message usually includes this command:

```sh
bunx playwright install chromium
```

After installing Chromium, rerun the task or the focused browser check. Non-web projects do not need this
binary.

## Hosted 402 Responses

Hosted frontier models require an active plan. Free models and your own endpoints do not require a hosted
subscription.

## Env Key Not Taking Effect

`OB1_BASE_URL` takes precedence over saved settings, but only in the process where it is set. Named
provider keys such as `OPENROUTER_API_KEY` are used only when no saved provider or hosted subscription
is configured. Verify the key is exported in the same shell that starts `ob1`.
