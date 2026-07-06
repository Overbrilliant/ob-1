# AGENTS.md

> OB-1 project memory index. OB-1 refreshes only the marked blocks below; edit freely outside them.
> Keep this concise (under ~200 lines). Put detailed notes in topic files and let episodes hold history.

<!-- OB1:BEGIN project -->
## Project index

### Stack
- TypeScript / Bun

### Commands
- run: `bun run start`

### Key files
- `scripts/delivery-smoke.ts`
- `src/cli/onboarding.ts`
- `scripts/cli-flags-smoke.ts`
- `src/memory/store.ts`
- `src/agent/procs.ts`
- `src/multimind/personas.ts`
- `scripts/router-smoke.ts`
- `src/agent/tools.ts`
- `scripts/verify-smoke.ts`
- `src/agent/loop.ts`

### Topic files
- Detailed notes live in `.ob1/topics/` when they exist.
<!-- OB1:END project -->

<!-- OB1:BEGIN memory -->
## Project memory

### Validated checks
- (none recorded yet)

### Validated behavior checks
- (none recorded yet)

### Durable facts
- (none promoted yet)

### Quality patterns
- (none promoted yet)

### Failure patterns
- (none recorded)

### Known issues / follow-ups
- (none recorded)

### Episodes
- Last episode: `2026-07-06T21-03-25-243Z-count-from-1-to-60-comma-separated-no-other-` — Count from 1 to 60, comma separated, no other text. (2026-07-06)
- Episode files: `.ob1/episodes/*.md` (local, ignored)
<!-- OB1:END memory -->

## Conventions
- **Minimal runtime dependencies.** Prefer Bun built-ins (`bun:sqlite`, `fetch`, `node:*`) where they
  fit. Heavy optional features such as `browser_check` load their packages lazily; keep new runtime
  dependencies justified and narrow.
- **Run `bun run scripts/smoke.ts`** before committing memory/embedding changes.
- **Bundle-check** with `bun build src/index.ts --target=bun --outfile=/tmp/x.js` (no tsc install).
- Each layer is provider-/backend-swappable: sqlite-vec, tree-sitter, and other LLM providers
  are documented drop-in upgrades on a Node runtime.
- See `docs/planning/PROGRESS.md` for the phased roadmap and `docs/planning/ob1-plan.html` for the full design.
