# Documentation Stack Decision

Recommendation: use Astro Starlight for `docs.overbrilliant.com`.

## Why Starlight

- Markdown-first, so the CLI repository can own launch docs without a custom CMS.
- Sidebar, search, dark mode, code blocks, and versionable content are built in.
- Static hosting keeps the docs independent from the closed-source hosted server.
- The public story stays aligned with the product: open CLI, portable docs, no hosted dependency.

## Shape

```text
docs.overbrilliant.com/
  getting-started/
    quickstart
    install
    free-models
  concepts/
    sessions
    permissions
    memory
    multimind
  reference/
    commands
    configuration
    mcp
    hosted-api
  launch-assets/
    free-tier-capacity
    evals
```

Until the separate docs site exists, keep the source Markdown in `CLI/docs/` and link it from the
marketing site's `/docs/` route.

The initial Starlight scaffold now lives in `docs-site/`. It links to the canonical Markdown files in
`CLI/docs/` so launch content has one source of truth.

## Alternative

Mintlify is acceptable if hosted docs maintenance becomes the bottleneck. The tradeoff is less ownership
of the build and a weaker open-source posture.
