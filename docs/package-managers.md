# Package Managers

Supported today:

- GitHub release archives for macOS/Linux arm64/x64
- Homebrew: `brew install overbrilliant/tap/ob1`
- npm: `npm install -g @overbrilliant/ob1`
- Source checkout through `scripts/install.sh`

## Nix

This repository includes a development flake shell for contributors. It provides the project toolchain
needed to run the Bun-based CLI from source; it is not yet the signed end-user package.

```sh
nix develop
bun install
bun run typecheck
bun run scripts/ci-smokes.ts
```

A fully offline Nix package should vendor Bun dependencies or consume signed release archives with fixed
hashes per release. Until that package exists, use `nix develop` for repeatable local development and the
Homebrew/curl/npm paths for normal installs.

If Nix is available, inspect the current flake outputs with:

```sh
nix flake show
```

## AUR

Recommended split:

- `ob1-bin`: install the signed Linux release archive.
- `ob1-git`: build from source with Bun for users who want main.

The binary package should verify the release checksum from `checksums.txt`.
Draft PKGBUILDs live in `packaging/aur/`. Replace placeholder hashes from the release
`checksums.txt` before publishing.

## winget / Scoop

Windows support needs a tested Windows binary first. Track investigation here until release artifacts
exist:

- `winget`: manifest points at a versioned GitHub release asset.
- `scoop`: bucket manifest points at the same asset and checksum.

Manifest templates and validation commands live in `packaging/windows/README.md`.
