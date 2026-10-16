#!/usr/bin/env bash
# Set ONE secret without the value ever being seen.
#
#   just secret-set factory ANTHROPIC_API_KEY            value from the clipboard, then cleared
#   just secret-set local SOME_TOKEN ~/token.txt     value from a file
#
# The value lives only in a shell variable and a pipe into `sops set --value-stdin`: never on
# screen, never in a process argument, never in shell history. It is read back and compared
# (not printed) before this reports success. Operator-only and factory-only keys are refused
# in the local file, which every app service can read.
source "$(dirname "$0")/lib.sh"
FILE="${1:-}" KEY="${2:-}" FROM="${3:-}"
[[ -n "$FILE" && -n "$KEY" ]] || die "usage: just secret-set local|factory NAME [path]"
[[ " ${SECRET_FILES[*]} " == *" $FILE "* ]] || die "FILE must be local or factory"
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "KEY must look like AN_ENV_NAME"
target="$(secret_path "$FILE")"
[[ -f "$target" ]] || die "$target does not exist; run just setup"
if [[ "$FILE" == "local" && "$KEY" =~ ^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|FACTORY_[A-Z_]+)$ ]]; then
  die "$KEY must never be in the local file; use the factory file"
fi
from_clipboard=0
if [[ -n "$FROM" ]]; then
  FROM="${FROM/#\~/$HOME}"; [[ -r "$FROM" ]] || die "cannot read $FROM"
  value="$(cat "$FROM")"
else
  command -v pbpaste >/dev/null || die "no clipboard tool; pass FROM=path instead"
  value="$(pbpaste)"; from_clipboard=1
fi
value="${value%$'\n'}"
[[ -n "$value" ]] || die "the value is empty; nothing was changed"
printf '%s' "$value" | json_string \
  | sops set --value-stdin "$target" "[\"$KEY\"]"
stored="$(decrypt "$FILE" | grep -E "^${KEY}=" | tail -1 | cut -d= -f2-)"
[[ "$stored" == "$value" ]] || die "read-back did not match; check $target"
[[ "$from_clipboard" == 1 ]] && pbcopy </dev/null
ok "$KEY set in $target (${#value} characters$([[ $from_clipboard == 1 ]] && echo ', clipboard cleared'))"
echo "  Run ${B}just env${N} and restart the services that use it."
