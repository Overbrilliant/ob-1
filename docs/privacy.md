# Privacy and Telemetry

OB-1 has no client telemetry by default. Local state stays under the workspace `.ob1/` directory and
global settings stay under `~/.ob1/`.

Network traffic happens only for the model route or tool the user configured:

- The embedded free-models router runs in-process and calls the cloud providers you enable via keys;
  keys stay in `~/.ob1/keys.env` on your machine.
- BYOK endpoints receive prompts and tool results as part of model calls.
- Hosted frontier models use the managed OB-1 server after sign-in/subscription.
- `web_search` uses the configured search endpoint.
- MCP servers receive only the tool calls routed to them.

Any future crash reporting or usage telemetry must be loudly opt-in.
