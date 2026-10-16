#!/usr/bin/env bash
# Shared helpers for the just recipes. Sourced, never run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$(pwd)"
SOPS_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
export SOPS_AGE_KEY_FILE="$SOPS_KEY_FILE"
SECRET_FILES=(local ops factory)
secret_path() { echo "config/$1.secrets.enc.env"; }

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B= G= Y= R= D= N=; fi
info() { echo "${B}==>${N} $*"; }
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo "  ${R}✗${N} $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"; }

# ── The tools image ──────────────────────────────────────────────────────────
# sops, age, jq and the plan renderer run from one pinned image (infra/docker/tools.Dockerfile),
# so a Mac needs only Docker. The repository is mounted at /work and the age key's folder at /age.
# Tagged by its Dockerfile's hash: a changed Dockerfile builds a new image, never a stale one.
# Worked out only when the image is needed, and only on the Mac, which is what starts it.
tools_image() {
  TOOLS_IMAGE="generic-bank/tools:$(shasum infra/docker/tools.Dockerfile | cut -c1-12)"
  docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1 && return
  info "Building the tools image (once): sops, age, jq, the plan renderer"
  docker build -q -f infra/docker/tools.Dockerfile -t "$TOOLS_IMAGE" infra/docker >/dev/null
}

# Run one command in the tools image, from the repository's root, as this user.
tool() {
  tools_image
  mkdir -p "$(dirname "$SOPS_KEY_FILE")"
  local tty=(-i)
  [[ -t 0 && -t 1 ]] && tty+=(-t)
  docker run --rm "${tty[@]}" --user "$(id -u):$(id -g)" -e HOME=/tmp -e EDITOR=vi \
    -v "$ROOT:/work" -w /work \
    -v "$(dirname "$SOPS_KEY_FILE"):/age" -e SOPS_AGE_KEY_FILE="/age/$(basename "$SOPS_KEY_FILE")" \
    -e GB_HOST_KEY_FILE="${GB_HOST_KEY_FILE:-$SOPS_KEY_FILE}" \
    "$TOOLS_IMAGE" "$@"
}

# Outside the image these names reach into it; inside it they are the real tools.
if [[ -z "${GB_IN_TOOLS:-}" ]]; then
  sops() { tool sops "$@"; }
  jq() { tool jq "$@"; }
fi

# A script that needs only the tools runs whole inside the image: call this first.
in_tools() {
  [[ -n "${GB_IN_TOOLS:-}" ]] && return 0
  tool bash "infra/scripts/$(basename "$0")" "$@"
  exit $?
}

# A value as a JSON string, for `sops set --value-stdin`.
json_string() { jq -Rs .; }

# Decrypt one secrets file to KEY=VALUE lines on stdout. Never written to disk.
decrypt() { sops decrypt --input-type dotenv --output-type dotenv "$(secret_path "$1")"; }

random_hex() { openssl rand -hex 24; }
random_password() { ( set +o pipefail; LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20 ); }
