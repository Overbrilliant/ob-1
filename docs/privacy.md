# Privacy and Telemetry

OB-1 has no client telemetry by default. Local state stays under the workspace `.ob1/` directory and
global settings stay under `~/.ob1/`.

Network traffic happens only for the model route or tool the user configured:

- FreeLLMAPI runs on the user's machine and talks to the providers the user enables.
- BYOK endpoints receive prompts and tool results as part of model calls.
- Hosted frontier models use the managed OB-1 server after sign-in/subscription.
- `web_search` uses the configured search endpoint.
- MCP servers receive only the tool calls routed to them.

Any future crash reporting or usage telemetry must be loudly opt-in.
