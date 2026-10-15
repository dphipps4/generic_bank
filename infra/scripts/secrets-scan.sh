#!/usr/bin/env bash
# Look for secrets with gitleaks, run from its pinned image, so a Mac needs only Docker.
#   secrets-scan.sh                 every commit in the history, then every uncommitted change
#   secrets-scan.sh image REF...    the whole filesystem of each image, as it ships
# Exits non-zero on any finding. Known false positives are allowlisted in .gitleaks.toml.
source "$(dirname "$0")/lib.sh"

SCANNER=ghcr.io/gitleaks/gitleaks:v8.30.1
FLAGS=(--no-banner --redact --verbose --exit-code 1)

scanner() { docker run --rm -i --entrypoint bash "$@"; }

repo() {
  info "Secrets: the history, then the uncommitted changes"
  # A worktree's .git is a pointer into the main checkout's: mount that too, at the same path.
  local common mounts=(-v "$ROOT:/repo:ro")
  common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
  [[ "$common" == "$ROOT/.git" ]] || mounts+=(-v "$common:$common:ro")
  # The checkout belongs to this user, not to the container's root: tell git that is fine.
  scanner "${mounts[@]}" -w /repo \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$SCANNER" -c '
      set -euo pipefail
      gitleaks git '"${FLAGS[*]}"' .
      # Staged, modified and new files that are not ignored, copied out of the read-only mount.
      mkdir /tmp/wip
      { git ls-files -z --modified --others --exclude-standard; git diff --cached --name-only -z; } |
        sort -zu | while IFS= read -r -d "" f; do
          if [[ -f "$f" ]]; then mkdir -p "/tmp/wip/$(dirname "$f")" && cp "$f" "/tmp/wip/$f"; fi
        done
      config=(); [[ -f .gitleaks.toml ]] && config=(--config /repo/.gitleaks.toml)
      cd /tmp/wip && gitleaks dir '"${FLAGS[*]}"' "${config[@]}" .
    ' || die "a secret in the history or the uncommitted changes"
  ok "no secrets in the history or the uncommitted changes"
}

image() {
  local ref cid config=()
  [[ -f .gitleaks.toml ]] && config=(-v "$ROOT/.gitleaks.toml:/gitleaks.toml:ro")
  for ref in "$@"; do
    info "Secrets: the filesystem of $ref"
    cid="$(docker create "$ref")"
    docker export "$cid" | scanner ${config[@]+"${config[@]}"} "$SCANNER" -c '
      set -euo pipefail
      mkdir /fs && tar -x -C /fs
      config=(); [[ -f /gitleaks.toml ]] && config=(--config /gitleaks.toml)
      cd /fs && gitleaks dir '"${FLAGS[*]}"' "${config[@]}" .
    ' || { docker rm "$cid" >/dev/null; die "a secret in $ref"; }
    docker rm "$cid" >/dev/null
    ok "no secrets in $ref"
  done
}

case "${1:-}" in
  "") repo ;;
  image) shift; [[ $# -gt 0 ]] || die "name at least one image"; image "$@" ;;
  *) die "usage: secrets-scan.sh [image REF...]" ;;
esac
