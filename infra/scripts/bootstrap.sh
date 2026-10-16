#!/usr/bin/env bash
# Install just, the command runner every step uses, from its pinned release: the prebuilt binary
# for this machine, checked against its published sha256 before it is trusted. Needs only bash,
# curl and tar, which macOS and Linux ship. Then check Docker.
#   infra/scripts/bootstrap.sh            installs into ~/.local/bin
#   JUST_DIR=/some/dir infra/scripts/bootstrap.sh
set -euo pipefail

VERSION=1.59.0
DIR="${JUST_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  target=aarch64-apple-darwin;      sum=6574cea774ed4cae12e24b6aa11857de33e80dab4667cf628fd5840df96a2a9d ;;
  Darwin-x86_64) target=x86_64-apple-darwin;       sum=036ead9df9bc31dbae9934ae3b4236ed124d0bafcffd33439460ae084d5c9cb7 ;;
  Linux-x86_64)  target=x86_64-unknown-linux-musl; sum=409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e ;;
  Linux-aarch64) target=aarch64-unknown-linux-musl; sum=23871b1702bfd550fb5f901778fd4290ecf2ee034a45a889fbe96d89b188086d ;;
  *) echo "  ✗ no pinned just build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

if command -v just >/dev/null && [[ "$(just --version | awk '{print $2}')" == "$VERSION" ]]; then
  echo "  ✓ just $VERSION is already installed ($(command -v just))"
else
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  file="just-$VERSION-$target.tar.gz"
  curl -fsSL "https://github.com/casey/just/releases/download/$VERSION/$file" -o "$tmp/$file"
  got="$( (command -v sha256sum >/dev/null && sha256sum "$tmp/$file" || shasum -a 256 "$tmp/$file") | cut -d' ' -f1)"
  [[ "$got" == "$sum" ]] || { echo "  ✗ just $VERSION: checksum mismatch, not installed" >&2; exit 1; }
  tar -xzf "$tmp/$file" -C "$tmp" just
  mkdir -p "$DIR"
  install -m 0755 "$tmp/just" "$DIR/just"
  echo "  ✓ just $VERSION installed in $DIR (checksum verified)"
  case ":$PATH:" in
    *":$DIR:"*) ;;
    *) echo "  ! $DIR is not on your PATH; add it:  export PATH=\"$DIR:\$PATH\"" ;;
  esac
fi

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  echo "  ✓ Docker is running"
else
  echo "  ! Docker isn't running: start Docker Desktop, then run  just setup"
fi
