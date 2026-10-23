#!/usr/bin/env bash
# Start one service as compose does: a clean environment holding config/app.env, replit.env over
# it, and that service's own secrets from .run/env. Replit hands every secret to every process; this
# keeps each one, the OpenRouter key above all, with the services allowed to see it. A +NAME after
# the secrets passes that one variable through from Replit's environment, by name.
#   infra/replit/service.sh <secrets> [+NAME …] [NAME=value …] <command …>
set -euo pipefail
cd "$(dirname "$0")/../.."
svc=$1
shift
keep=()
while [[ "${1:-}" == +* ]]; do
  n=${1#+}
  keep+=("$n=${!n:-}")
  shift
done
exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ${keep[@]+"${keep[@]}"} \
  bash -c 'set -a; . config/app.env; . infra/replit/replit.env; . ".run/env/$0.env"; set +a; exec env "$@"' "$svc" "$@"
