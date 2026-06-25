# Contributing to Overbrilliant / OB-1

Thanks for your interest in contributing to OB-1.

## Development Setup

```bash
bun install
bun run start
```

Run focused checks before opening a pull request:

```bash
bun run scripts/ci-smokes.ts
bun run typecheck
```

## Contribution Guidelines

- Keep changes focused and minimal.
- Read relevant code before editing.
- Add or update tests for behavioral changes.
- Do not commit secrets, `.env` files, `.ob1/`, local databases, logs, generated binaries, or `node_modules/`.
- Use clear commit messages that describe the user-visible change.
- For UI or interactive behavior, include browser/runtime verification when possible.

## Pull Requests

Please include:

- What changed.
- Why it changed.
- How it was tested.
- Any limitations or follow-up work.

## Security Issues

Do not report security issues in public pull requests or issues. Follow `SECURITY.md`.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0.
