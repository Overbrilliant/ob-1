# Troubleshooting

## FreeLLMAPI Port Conflicts

OB-1 starts FreeLLMAPI on a localhost port. The preferred managed port is `MANAGED_PORT = 49317` in
`src/cli/freellm-manage.ts`. If that port is busy, OB-1 automatically picks another free port and stores
the chosen URL in `~/.ob1/freellm.json`.

Open the FreeLLMAPI manager:

```text
/freellm
```

Use the manager after freeing a port, changing Docker/Node state, or when the proxy is stopped. It can
check status, restart the proxy, open the dashboard, stop the proxy, or unmanage it.

## Missing Docker

FreeLLMAPI setup prefers Docker when available and falls back to a Node-based local process. The Node
path can take longer because dependencies must be installed locally.

## Missing Playwright Browser

The browser-check tool loads Playwright lazily. If the optional browser binary is missing, install it
only when you need browser automation. The error message usually includes this command:

```sh
bunx playwright install chromium
```

After installing Chromium, rerun the task or the focused browser check. Non-web projects do not need this
binary.

## Hosted 402 Responses

Hosted frontier models require an active plan. FreeLLMAPI and your own endpoints do not require a hosted
subscription.

## Env Key Not Taking Effect

`OB1_BASE_URL` takes precedence over saved settings, but only in the process where it is set. Named
provider keys such as `OPENROUTER_API_KEY` are used only when no saved provider or hosted subscription
is configured. Verify the key is exported in the same shell that starts `ob1`.
