#!/usr/bin/env bash
# Replace one generated secret with a fresh random value, without showing either.
#   just secret-rotate local API_TOKEN_HASH_KEY
source "$(dirname "$0")/lib.sh"
in_tools "$@"
FILE="${1:-}" KEY="${2:-}"
[[ -n "$FILE" && -n "$KEY" ]] || die "usage: just secret-rotate local|factory NAME"
how="$(awk -v f="$FILE" -v k="$KEY" '$1==f && $2==k {print $3}' infra/secrets/secrets.spec)"
[[ -n "$how" ]] || die "$KEY is not a $FILE secret in infra/secrets/secrets.spec"
case "$how" in
  hex) value="$(random_hex)" ;; password) value="$(random_password)" ;;
  *) die "$KEY is not generated (it is $how); enter it with just secrets-edit $FILE" ;;
esac
printf '%s' "$value" | json_string \
  | sops set --value-stdin "$(secret_path "$FILE")" "[\"$KEY\"]"
ok "$KEY rotated in $(secret_path "$FILE"). Run just env, then restart the services that use it."
