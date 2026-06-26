#!/usr/bin/env sh
# Install OB-1 so you can type `ob1` anywhere.
#
# Release install, no Bun required:
#   curl -fsSL https://github.com/overbrilliant/ob-1/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/overbrilliant/ob-1/releases/latest/download/install.sh | sh -s -- --version v0.1.2
#
# Local repo install:
#   ./scripts/install.sh            # launcher (default), runs via Bun from this repo
#   ./scripts/install.sh --binary   # compile a local standalone executable
set -eu

REPO_SLUG="${OB1_REPO:-overbrilliant/ob-1}"
VERSION="${OB1_VERSION:-latest}"
MODE=""
LOCAL_REPO=""
TMP_DIR=""

usage() {
  cat <<EOF
Install OB-1.

Usage:
  install.sh [--version v0.1.2] [--repo owner/name] [--install-dir DIR]
  install.sh --release [--version v0.1.2]
  install.sh --launcher
  install.sh --binary

Modes:
  --release   Download a GitHub release binary, verify checksums, then install it.
  --launcher  From a checked-out repo, install a Bun launcher. This is the local default.
  --binary    From a checked-out repo, compile and install a standalone binary.

Environment:
  OB1_VERSION      Release tag to install. Defaults to latest.
  OB1_REPO         GitHub repo slug. Defaults to overbrilliant/ob-1.
  OB1_INSTALL_DIR  Install directory. Defaults to the first writable PATH bin dir.
EOF
}

die() {
  echo "✗ $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

need_arg() {
  [ -n "${2:-}" ] || die "$1 requires a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release)
      MODE="release"
      ;;
    --launcher)
      MODE="launcher"
      ;;
    --binary)
      MODE="binary"
      ;;
    --version|--tag)
      need_arg "$1" "${2:-}"
      shift
      VERSION="$1"
      ;;
    --version=*|--tag=*)
      VERSION="${1#*=}"
      ;;
    --repo)
      need_arg "$1" "${2:-}"
      shift
      REPO_SLUG="$1"
      ;;
    --repo=*)
      REPO_SLUG="${1#*=}"
      ;;
    --install-dir)
      need_arg "$1" "${2:-}"
      shift
      OB1_INSTALL_DIR="$1"
      ;;
    --install-dir=*)
      OB1_INSTALL_DIR="${1#*=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

[ -n "$VERSION" ] || die "version cannot be empty"
[ -n "$REPO_SLUG" ] || die "repo cannot be empty"

script_dir=""
case "$0" in
  */*)
    script_dir=$(CDPATH= cd -P "$(dirname "$0")" 2>/dev/null && pwd || true)
    ;;
esac

if [ -n "$script_dir" ] && [ -f "$script_dir/../src/index.ts" ] && [ -f "$script_dir/../package.json" ]; then
  LOCAL_REPO=$(CDPATH= cd -P "$script_dir/.." 2>/dev/null && pwd || true)
fi

if [ -z "$MODE" ]; then
  if [ -n "$LOCAL_REPO" ]; then
    MODE="launcher"
  else
    MODE="release"
  fi
fi

if [ "$MODE" = "binary" ] && [ -z "$LOCAL_REPO" ]; then
  MODE="release"
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

make_tmp_dir() {
  if command_exists mktemp; then
    mktemp -d "${TMPDIR:-/tmp}/ob1-install.XXXXXX"
  else
    dir="${TMPDIR:-/tmp}/ob1-install.$$"
    mkdir "$dir"
    echo "$dir"
  fi
}

choose_bindir() {
  if [ -n "${OB1_INSTALL_DIR:-}" ]; then
    echo "$OB1_INSTALL_DIR"
    return
  fi

  for dir in "$HOME/.local/bin" "/usr/local/bin" "/opt/homebrew/bin" "$HOME/.bun/bin"; do
    case ":${PATH:-}:" in
      *":$dir:"*)
        if [ -d "$dir" ] && [ -w "$dir" ]; then
          echo "$dir"
          return
        fi
        ;;
    esac
  done

  echo "$HOME/.local/bin"
}

install_executable() {
  src="$1"
  target="$2"
  tmp_target="${target}.tmp.$$"
  cp "$src" "$tmp_target"
  chmod 0755 "$tmp_target"
  mv "$tmp_target" "$target"
}

release_asset() {
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)

  case "$os:$arch" in
    Darwin:arm64|Darwin:aarch64)
      echo "ob1-darwin-arm64.tar.gz"
      ;;
    Darwin:x86_64|Darwin:amd64)
      echo "ob1-darwin-x64.tar.gz"
      ;;
    Linux:arm64|Linux:aarch64)
      echo "ob1-linux-arm64.tar.gz"
      ;;
    Linux:x86_64|Linux:amd64)
      echo "ob1-linux-x64.tar.gz"
      ;;
    *)
      die "unsupported platform: $os/$arch"
      ;;
  esac
}

download() {
  url="$1"
  out="$2"
  if command_exists curl; then
    curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 "$url" -o "$out"
  elif command_exists wget; then
    wget -q "$url" -O "$out"
  else
    die "curl or wget is required to download release assets"
  fi
}

sha256_file() {
  file="$1"
  if command_exists shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command_exists sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  else
    die "shasum or sha256sum is required to verify checksums"
  fi
}

verify_checksum() {
  file="$1"
  asset="$2"
  checksums="$3"
  expected=$(awk -v asset="$asset" '$2 == asset { print $1; exit }' "$checksums")
  [ -n "$expected" ] || die "checksums.txt does not contain $asset"
  actual=$(sha256_file "$file")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset"
}

release_base_url() {
  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/$REPO_SLUG/releases/latest/download"
  else
    echo "https://github.com/$REPO_SLUG/releases/download/$VERSION"
  fi
}

BINDIR="$(choose_bindir)"
mkdir -p "$BINDIR"
TARGET="$BINDIR/ob1"

if [ "$MODE" = "launcher" ]; then
  [ -n "$LOCAL_REPO" ] || die "--launcher requires running from a checked-out OB-1 repo"
  command_exists bun || die "Bun is required for launcher installs — install it from https://bun.sh"

  echo "→ installing dependencies"
  (cd "$LOCAL_REPO" && bun install >/dev/null 2>&1) || (cd "$LOCAL_REPO" && bun install)

  echo "→ installing launcher → $TARGET"
  cat > "$TARGET" <<EOF
#!/usr/bin/env bash
# OB-1 launcher generated by scripts/install.sh.
exec bun "$LOCAL_REPO/src/index.ts" "\$@"
EOF
  chmod 0755 "$TARGET"
elif [ "$MODE" = "binary" ]; then
  [ -n "$LOCAL_REPO" ] || die "--binary requires running from a checked-out OB-1 repo"
  command_exists bun || die "Bun is required to build OB-1 — install it from https://bun.sh"

  echo "→ installing dependencies"
  (cd "$LOCAL_REPO" && bun install >/dev/null 2>&1) || (cd "$LOCAL_REPO" && bun install)
  echo "→ compiling standalone binary → $TARGET"
  (cd "$LOCAL_REPO" && bun run scripts/build-bin.ts "$TARGET")
  chmod 0755 "$TARGET"
else
  asset="$(release_asset)"
  base_url="$(release_base_url)"
  TMP_DIR="$(make_tmp_dir)"
  mkdir -p "$TMP_DIR/extract"

  echo "→ downloading OB-1 $VERSION ($asset)"
  download "$base_url/$asset" "$TMP_DIR/$asset"
  download "$base_url/checksums.txt" "$TMP_DIR/checksums.txt"
  echo "→ verifying checksum"
  verify_checksum "$TMP_DIR/$asset" "$asset" "$TMP_DIR/checksums.txt"
  tar -xzf "$TMP_DIR/$asset" -C "$TMP_DIR/extract"
  [ -f "$TMP_DIR/extract/ob1" ] || die "release archive did not contain ob1"
  echo "→ installing binary → $TARGET"
  install_executable "$TMP_DIR/extract/ob1" "$TARGET"
fi

echo "✓ installed: $TARGET"
case ":${PATH:-}:" in
  *":$BINDIR:"*) echo "  $BINDIR is on your PATH — open a terminal anywhere and run: ob1" ;;
  *) echo "  ⚠ $BINDIR is not on your PATH yet. Add this to your shell profile, then restart the shell:"
     echo "      export PATH=\"$BINDIR:\$PATH\"" ;;
esac
