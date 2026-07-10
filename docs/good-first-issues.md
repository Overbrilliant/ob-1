# Good First Issues

Seed these as GitHub issues before launch. Keep each issue small, scoped, and tied to one validation
command.

| Title | Area | Acceptance check |
|---|---|---|
| Add a provider preset for Together AI | Providers | `bun run scripts/provider-smoke.ts` |
| Add a provider preset for Fireworks AI | Providers | `bun run scripts/provider-smoke.ts` |
| Add `/memory export json` docs and smoke | Memory | `bun run scripts/memory-export-smoke.ts` |
| Improve the `~/.ob1/keys.env` template copy (grouping, comments) | Onboarding | `bun run scripts/free-router-smoke.ts` |
| Add a troubleshooting entry for corporate proxies | Docs | Markdown link from `docs/README.md` |
| Add a focused smoke for `/upgrade` locked-model copy | Hosted upsell | New smoke plus `bun run scripts/ci-smokes.ts` |
| Add shell completion investigation notes | CLI polish | `docs/package-managers.md` updated |
| Add a small MCP stdio config example | MCP | `docs/mcp.md` updated |
| Add a local vLLM quickstart snippet | Local models | `docs/providers.md` updated |
| Add a LM Studio screenshot-free setup checklist | Local models | `docs/providers.md` updated |
| Add a sample `.ob1/settings.json` reference fixture | Config | `bun run scripts/config-validate-smoke.ts` |
| Add a recovery hint for missing `git` | Install | focused smoke or manual note |
| Add a changelog entry lint/check script | Release | script exits nonzero when `CHANGELOG.md` lacks current version |
| Add docs for `OB1_FORCE_VISION` examples | Browser/vision | `docs/configuration.md` updated |
| Add a docs page for session export/resume | Sessions | `docs/README.md` link plus Markdown page |

Issue labels:

- `good first issue`
- `documentation`
- `providers`
- `install`
- `memory`
- `mcp`
- `needs-triage`

Do not seed issues that require paid provider keys, secret access, or edits to the embedded free-models
router's provider credentials.
