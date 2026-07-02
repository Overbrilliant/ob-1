# AUR Drafts

Recommended packages:

- `ob1-bin`: installs the signed Linux release archive. This should be the first published package.
- `ob1-git`: builds/runs from source for users tracking `main`.

Publishing checklist:

1. Replace `PUT_RELEASE_SHA256_HERE` with the hash from the release `checksums.txt`.
2. Run `makepkg --printsrcinfo > .SRCINFO`.
3. Build in a clean Arch container.
4. Run:

```sh
ob1 --version
ob1 --help
printf '/exit\n' | OB1_SETTINGS_DIR="$(mktemp -d)" ob1
```

Do not publish before a release archive exists for the exact version in `pkgver`.
