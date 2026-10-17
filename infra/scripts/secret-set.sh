#!/usr/bin/env bash
# Set ONE secret without the value ever being seen.
#
#   just secret-set factory OPENROUTER_API_KEY             asks for the value; what you paste is hidden
#   just secret-set factory OPENROUTER_API_KEY clipboard   the value from the clipboard, then cleared
#   just secret-set local SOME_TOKEN ~/token.txt           the value from a file
#
# The value lives only in a shell variable and a pipe into `sops set --value-stdin`: never on
# screen, never in a process argument, never in shell history. A model key is checked for its
# shape first, so a pasted command or a stray word is refused, not stored. It is read back and
# compared (not printed) before this reports success. Operator-only and factory-only keys are
# refused in the local file, which every app service can read.
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
if [[ "$FROM" == clipboard ]]; then
  command -v pbpaste >/dev/null || die "no clipboard tool; paste the value when asked instead"
  value="$(pbpaste)"; from_clipboard=1
elif [[ -n "$FROM" ]]; then
  FROM="${FROM/#\~/$HOME}"; [[ -r "$FROM" ]] || die "cannot read $FROM"
  value="$(cat "$FROM")"
else
  [[ -t 0 ]] || die "no terminal to ask in; pass clipboard or a file path"
  IFS= read -rsp "  Paste $KEY (hidden), then press Return: " value; echo
fi
value="${value%$'\n'}"
[[ -n "$value" ]] || die "the value is empty; nothing was changed"
# A model key has a known shape; anything else is a slip (a copied command, a stray word).
case "$KEY" in
  ANTHROPIC_API_KEY) shape='^sk-ant-[A-Za-z0-9_-]{20,}$' name='an Anthropic key (sk-ant-…)' ;;
  OPENAI_API_KEY) shape='^sk-[A-Za-z0-9_-]{20,}$' name='an OpenAI key (sk-…)' ;;
  OPENROUTER_API_KEY) shape='^sk-or-[A-Za-z0-9_-]{20,}$' name='an OpenRouter key (sk-or-…)' ;;
  *) shape='' ;;
esac
[[ -z "$shape" || "$value" =~ $shape ]] \
  || die "that isn't $name (${#value} characters); nothing was changed"
printf '%s' "$value" | json_string \
  | sops set --value-stdin "$target" "[\"$KEY\"]"
stored="$(decrypt "$FILE" | grep -E "^${KEY}=" | tail -1 | cut -d= -f2-)"
[[ "$stored" == "$value" ]] || die "read-back did not match; check $target"
[[ "$from_clipboard" == 1 ]] && pbcopy </dev/null
ok "$KEY set in $target (${#value} characters$([[ $from_clipboard == 1 ]] && echo ', clipboard cleared'))"
if [[ "$FILE" == factory ]]; then echo "  Next: ${B}just factory${N} (or ${B}just up${N}) restarts the factory with it."
else echo "  Next: ${B}just up${N} restarts the services that use it."; fi
