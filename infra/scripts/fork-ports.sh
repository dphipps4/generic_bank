#!/usr/bin/env bash
# For a second copy of the stack in another folder: write config/local.env with every published
# port moved by OFFSET, so both copies run side by side. Never overwrites an existing file.
source "$(dirname "$0")/lib.sh"
OFFSET="${1:-10000}"
[[ "$OFFSET" =~ ^[0-9]+$ ]] || die "OFFSET must be a number"
[[ -f config/local.env ]] && die "config/local.env exists; edit it, or delete it and run this again"
{
  echo "# Written by make fork-ports: every published port moved by $OFFSET. Not committed."
  grep -E '^[A-Z_]+_PORT=[0-9]+$' config/app.env | while IFS='=' read -r key port; do
    echo "$key=$((port + OFFSET))"
  done
} > config/local.env
ok "config/local.env: ports moved by $OFFSET (the Console is now on $((8080 + OFFSET)))"
