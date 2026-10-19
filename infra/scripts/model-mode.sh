#!/usr/bin/env bash
# The last thing just setup and just up print: each factory role's model and provider, as
# config/app.env sets them, and whether that provider's key is set. With no model key, the factory
# refuses every model call. Names only; no value is ever shown.
source "$(dirname "$0")/lib.sh"
set_keys=" $(decrypt factory 2>/dev/null | grep -E '^(OPENAI|OPENROUTER)_API_KEY=.' | cut -d= -f1 | tr '\n' ' ' || true)"
setting() { sed -n "s/^$1=//p" config/app.env | tail -1; }
keyOf() { echo "$(echo "$1" | tr '[:lower:]' '[:upper:]')_API_KEY"; }

if [[ -z "${set_keys// /}" ]]; then
  key="$(keyOf "$(setting FACTORY_SUPERVISOR_PROVIDER)")"
  echo
  echo "  ${R}✗ The factory needs a model key; until then it refuses every model call.${N}"
  echo "  ${R}  just secret-set factory $key   (the provider config/app.env names)${N}"
  exit 0
fi
for role in Scout Supervisor; do
  upper="$(echo "$role" | tr '[:lower:]' '[:upper:]')"
  provider="$(setting "FACTORY_${upper}_PROVIDER")"
  model="$(setting "FACTORY_${upper}_MODEL")"
  key="$(keyOf "$provider")"
  if [[ "$set_keys" == *" $key "* ]]; then
    echo "  ${G}Factory: the $role on $model, through $provider${N} ($key is set)"
  else
    echo "  ${R}✗ Factory: the $role is set to $provider in config/app.env, but $key is not set.${N}"
    echo "  ${R}  just secret-set factory $key${N}"
  fi
done
