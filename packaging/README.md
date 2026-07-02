# Packaging Drafts

This directory holds package-manager artifacts that cannot be published from this repo alone.

Status:

- Homebrew, npm, and GitHub release archives are the supported launch paths.
- Nix has a contributor flake at the repository root.
- AUR package drafts are under `aur/`.
- Windows package-manager work is blocked on signed Windows release artifacts.

Before publishing any package-manager entry:

1. Cut a GitHub release.
2. Verify the release archive with `checksums.txt` and GitHub artifact attestations.
3. Replace placeholder hashes in the package template.
4. Install on a clean machine.
5. Run `ob1 --version`, `ob1 --help`, and a no-model `/exit` smoke.
