#!/usr/bin/env bash
# Run one command in the tools image (sops, age, jq, node with marked), from the repository root:
#   tool.sh sops decrypt config/local.secrets.enc.env
source "$(dirname "$0")/lib.sh"
tool "$@"
