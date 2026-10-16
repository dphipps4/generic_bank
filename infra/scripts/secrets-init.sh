#!/usr/bin/env bash
# Create this machine's age key, the SOPS rules, and the three encrypted secrets files.
# Never overwrites anything that exists: run it as often as you like.
source "$(dirname "$0")/lib.sh"
in_tools "$@"

info "Age key"
shown="${GB_HOST_KEY_FILE:-$SOPS_KEY_FILE}"
if [[ -f "$SOPS_KEY_FILE" ]]; then
  ok "using $shown"
else
  mkdir -p "$(dirname "$SOPS_KEY_FILE")"
  age-keygen -o "$SOPS_KEY_FILE" 2>/dev/null
  chmod 600 "$SOPS_KEY_FILE"
  ok "created $shown (back it up: without it the secrets files cannot be opened)"
fi
pub="$(grep -m1 '^# public key:' "$SOPS_KEY_FILE" | awk '{print $4}')"
[[ -n "$pub" ]] || die "no public key found in $shown"

info "SOPS rules"
sed "s/__AGE_PUBLIC_KEY__/$pub/" infra/secrets/sops.yaml.template > .sops.yaml
ok ".sops.yaml encrypts to ${pub:0:16}…"

info "Secrets files"
new_value() {
  case "$1" in
    hex) random_hex ;;
    password) random_password ;;
    vault | entered | 'entered?') printf '' ;;
    *) die "unknown kind $1" ;;
  esac
}

for f in "${SECRET_FILES[@]}"; do
  target="$(secret_path "$f")"
  if [[ -f "$target" ]]; then
    # Keep every value that exists; add only the secrets the spec has gained since.
    have="$(decrypt "$f" | cut -d= -f1)"
    added=0
    while read -r file key how _; do
      [[ "$file" == "$f" ]] || continue
      grep -qx "$key" <<<"$have" && continue
      printf '"%s"' "$(new_value "$how")" | sops set --value-stdin "$target" "[\"$key\"]"
      ok "$target: added $key"
      added=$((added + 1))
    done < <(grep -v '^\s*#' infra/secrets/secrets.spec | grep -v '^\s*$')
    [[ $added -gt 0 ]] || ok "$target exists (kept)"
    continue
  fi
  # The plaintext stays inside .run (never committed, mode 700) for the moment it takes to encrypt.
  mkdir -p .run && chmod 700 .run
  plain=".run/secrets.$f.plain"; trap 'rm -f "$plain"' EXIT
  ( umask 077; : > "$plain" )
  while read -r file key how _; do
    [[ "$file" == "$f" ]] || continue
    printf '%s=%s\n' "$key" "$(new_value "$how")" >> "$plain"
  done < <(grep -v '^\s*#' infra/secrets/secrets.spec | grep -v '^\s*$')
  sops encrypt --input-type dotenv --output-type dotenv --filename-override "$target" "$plain" > "$target"
  rm -f "$plain"
  ok "created $target"
done

info "Secrets you enter"
# A value someone else issues (an API key) cannot be generated. Each is explained here and entered
# by a person with sops; setup does not go on while a required one is blank.
missing=0 any=0
while IFS= read -r line; do
  read -r f key how _ <<<"$line"
  [[ "$how" == entered || "$how" == 'entered?' ]] || continue
  any=1
  about=""; [[ "$line" == *" -- "* ]] && about="${line#* -- }"
  value="$(decrypt "$f" | grep -E "^${key}=" | tail -1 | cut -d= -f2-)"
  if [[ -n "$value" ]]; then
    ok "$key is set"
  elif [[ "$how" == 'entered?' ]]; then
    warn "$key is blank, which is allowed. $about"
    echo "    To enter it: copy it, then ${B}just secret-set $f $key${N} (it reads the clipboard, never shows it)."
  else
    echo "  ${R}✗${N} $key is required and blank. $about"
    echo "    Enter it: copy it, then ${B}just secret-set $f $key${N} (it reads the clipboard, never shows it)."
    missing=1
  fi
done < <(grep -v '^\s*#' infra/secrets/secrets.spec | grep -v '^\s*$')
[[ $any == 1 ]] || ok "nothing to enter"
[[ $missing == 0 ]] || die "Enter the values marked ✗ with sops, then run just setup again."
