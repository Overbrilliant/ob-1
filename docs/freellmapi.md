# FreeLLMAPI Guide

FreeLLMAPI is the default free path for OB-1. It is a local OpenAI-compatible gateway that OB-1 can
download, start, and connect without asking you for an API key first.

Repository: <https://github.com/tashfeenahmed/freellmapi>

## What OB-1 Does

When you choose **Start free**, OB-1:

1. Picks a localhost port, preferring `49317`.
2. Clones FreeLLMAPI into `~/.ob1/freellmapi`.
3. Writes a local `.env` with `ENCRYPTION_KEY`, `PORT`, and `HOST_BIND=127.0.0.1`.
4. Starts FreeLLMAPI with Docker when available, otherwise with Node.
5. Generates a local dashboard login and creates the local dashboard account.
6. Fetches the unified `/v1` API key.
7. Saves the local endpoint and key in `~/.ob1/settings.json`.

The state file is `~/.ob1/freellm.json` and is written owner-only. OB-1 does not move or rename the
FreeLLMAPI repository; it uses the public repository under the personal account by design.

The generated dashboard email and password are printed during setup and saved in `~/.ob1/freellm.json`
so you can sign into the dashboard later if the browser asks. If an existing FreeLLMAPI dashboard
account is already present, OB-1 falls back to asking for that existing login instead of replacing it.

## First Token

FreeLLMAPI includes anonymous provider routes, so `/v1/models` can be usable before you add provider
keys. Treat anonymous routes as a bootstrap path: good for setup, quick checks, and low-stakes tasks,
but variable in quality and limits.

For serious coding sessions, open the dashboard and add your own free provider keys:

```text
/freellm
```

OB-1 keeps talking to one local `/v1` endpoint after you add keys.

## Managing the Proxy

Inside OB-1:

```text
/freellm
```

The manager can show status, restart the proxy, open the dashboard, stop the proxy, or unmanage it.
Restart heals the common cases: stopped Docker container, stale Node process, missing build output, or a
reused checkout that needs to be started again.

## Docker vs Node

Docker is preferred because the proxy can keep running after OB-1 exits. If Docker is missing or not
running, OB-1 falls back to Node and npm. The Node path may take longer on first run because it installs
dependencies and builds the FreeLLMAPI server locally.

## Data and Keys

FreeLLMAPI stores provider keys inside its own local server state and encrypts them at rest with the
generated `ENCRYPTION_KEY`. OB-1 stores only the FreeLLMAPI endpoint and unified key it needs for `/v1`.

The defensive posture is local-by-default:

- The proxy binds to `127.0.0.1`.
- Users consume their own provider accounts and free tiers.
- There is no centrally hosted shared free pool.
- Provider terms and anonymous-provider policies should be checked before public launch claims.

## Troubleshooting

If setup fails, run:

```text
/freellm
```

If a port is busy, OB-1 picks another localhost port and records it in `~/.ob1/freellm.json`.

See [Troubleshooting](troubleshooting.md) for Docker, port, and browser-tool notes.
