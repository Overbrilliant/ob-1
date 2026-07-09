# Install OB-1

OB-1 runs on macOS and Linux. The command is `ob1` in every install path.

## macOS

Use Homebrew for normal installs and upgrades:

```sh
brew install overbrilliant/tap/ob1
ob1
```

Pin a release when you need a controlled rollout:

```sh
curl -fsSL https://github.com/Overbrilliant/ob-1/releases/latest/download/install.sh | sh -s -- --version v0.3.4
```

Apple Silicon and Intel macOS release archives are published separately. The installer picks the right
archive and verifies it with `checksums.txt`.

## Linux

Use the native installer:

```sh
curl -fsSL https://github.com/Overbrilliant/ob-1/releases/latest/download/install.sh | sh
ob1
```

The installer supports Linux arm64 and x64 release archives. If it cannot write to a system bin
directory, it prints the path it used so you can add that directory to `PATH`.

## npm

Use npm when Node tooling is already standard on the machine:

```sh
npm install -g @overbrilliant/ob1
ob1
```

The npm package expects Bun to be available at runtime:

```sh
bun --version
```

## Source

Use a source checkout for development, forks, or local patching:

```sh
git clone https://github.com/Overbrilliant/ob-1.git
cd ob-1
bun install
./scripts/install.sh
ob1
```

Build a standalone binary from source when you need to test the release artifact path locally:

```sh
bun run build:bin
```

## After Install

Start in any Git repository:

```sh
ob1
```

Choose **Start free** on first run. OB-1 provisions nothing external: the free path runs through the
embedded free-models router, and keyless cloud providers work out of the box. Add your own free
provider keys to `~/.ob1/keys.env` for more capacity.

Use these checks when debugging an install:

```sh
ob1 --version
ob1 --help
ob1 onboard
```

Fresh-install coverage and package-manager notes are tracked in [Distribution](distribution.md) and
[Package managers](package-managers.md).
