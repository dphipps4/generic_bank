#!/usr/bin/env bash
# Shared helpers for the make targets. Sourced, never run.
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

# Decrypt one secrets file to KEY=VALUE lines on stdout. Never written to disk.
decrypt() { sops decrypt --input-type dotenv --output-type dotenv "$(secret_path "$1")"; }

random_hex() { openssl rand -hex 24; }
random_password() { ( set +o pipefail; LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20 ); }
