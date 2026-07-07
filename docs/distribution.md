# Distribution

OB-1 ships through three public channels:

- GitHub releases: native archives plus `install.sh`
- Homebrew: `brew install overbrilliant/tap/ob1`
- npm: `npm install -g @overbrilliant/ob1` (requires Bun at runtime)

## Release pipeline

The release workflow builds four native archives:

- `ob1-darwin-arm64.tar.gz`
- `ob1-darwin-x64.tar.gz`
- `ob1-linux-arm64.tar.gz`
- `ob1-linux-x64.tar.gz`

Linux binaries build on Ubuntu. macOS binaries build on macOS so Apple signing tools are available.
The publish job then creates `checksums.txt`, uploads release assets, and generates GitHub artifact
attestations for every file in `dist/`.

## macOS signing and notarization

The release workflow signs and notarizes macOS binaries only when all Apple secrets below are set in
`Overbrilliant/ob-1` repository secrets:

| Secret | Purpose |
|---|---|
| `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64` | Base64-encoded `.p12` Developer ID Application certificate. |
| `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate. |
| `APPLE_ID` | Apple Developer account email. |
| `APPLE_TEAM_ID` | Apple Developer Team ID. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for `notarytool`. |

If any of these are missing, the release still succeeds and publishes unsigned macOS archives with a
GitHub Actions notice. This keeps emergency releases possible while making the missing hardening
visible in the run log.

Create the certificate secret from a local `.p12` file with:

```sh
base64 -i DeveloperIDApplication.p12 | pbcopy
```

## Provenance verification

Release artifacts have GitHub artifact attestations. To verify one:

```sh
gh release download v0.3.0 --repo Overbrilliant/ob-1 --pattern ob1-darwin-arm64.tar.gz
gh attestation verify ob1-darwin-arm64.tar.gz --repo Overbrilliant/ob-1
```

## Fresh install matrix

The fresh install workflow tests the supported clean-machine paths:

| Path | Matrix |
|---|---|
| `curl .../install.sh \| sh` | macOS arm64, macOS x64, Linux arm64, Linux x64 |
| Homebrew | macOS arm64, macOS x64 |
| npm | Linux x64 with Bun installed |

See `docs/package-managers.md` for Nix, AUR, winget, and Scoop notes.
Draft package-manager artifacts live in `packaging/`.

Run it manually from GitHub Actions, or with:

```sh
gh workflow run fresh-install.yml --repo Overbrilliant/ob-1 -f version=v0.3.0
```

The workflow also runs on published releases and weekly on Mondays.
