#!/usr/bin/env bash
# Create this machine's age key, the SOPS rules, and the three encrypted secrets files.
# Never overwrites anything that exists: run it as often as you like.
source "$(dirname "$0")/lib.sh"
need sops "brew install sops"; need age-keygen "brew install age"; need openssl ""

info "Age key"
if [[ -f "$SOPS_KEY_FILE" ]]; then
  ok "using $SOPS_KEY_FILE"
else
  mkdir -p "$(dirname "$SOPS_KEY_FILE")"
  age-keygen -o "$SOPS_KEY_FILE" 2>/dev/null
  chmod 600 "$SOPS_KEY_FILE"
  ok "created $SOPS_KEY_FILE (back it up: without it the secrets files cannot be opened)"
fi
pub="$(grep -m1 '^# public key:' "$SOPS_KEY_FILE" | awk '{print $4}')"
[[ -n "$pub" ]] || die "no public key found in $SOPS_KEY_FILE"

info "SOPS rules"
sed "s/__AGE_PUBLIC_KEY__/$pub/" infra/secrets/sops.yaml.template > .sops.yaml
ok ".sops.yaml encrypts to ${pub:0:16}…"

info "Secrets files"
new_value() {
  case "$1" in
    hex) random_hex ;;
    password) random_password ;;
    blank) printf '' ;;
    *) die "unknown kind $1" ;;
  esac
}

for f in "${SECRET_FILES[@]}"; do
  target="$(secret_path "$f")"
  if [[ -f "$target" ]]; then
    # Keep every value that exists; add only the secrets the spec has gained since.
    have="$(decrypt "$f" | cut -d= -f1)"
    added=0
    while read -r file key how; do
      [[ "$file" == "$f" ]] || continue
      grep -qx "$key" <<<"$have" && continue
      printf '"%s"' "$(new_value "$how")" | sops set --value-stdin "$target" "[\"$key\"]"
      ok "$target: added $key"
      added=$((added + 1))
    done < <(grep -v '^\s*#' infra/secrets/secrets.spec | grep -v '^\s*$')
    [[ $added -gt 0 ]] || ok "$target exists (kept)"
    continue
  fi
  plain="$(mktemp)"; trap 'rm -f "$plain"' EXIT
  while read -r file key how; do
    [[ "$file" == "$f" ]] || continue
    printf '%s=%s\n' "$key" "$(new_value "$how")" >> "$plain"
  done < <(grep -v '^\s*#' infra/secrets/secrets.spec | grep -v '^\s*$')
  sops encrypt --input-type dotenv --output-type dotenv --filename-override "$target" "$plain" > "$target"
  rm -f "$plain"
  ok "created $target"
done
