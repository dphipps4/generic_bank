#!/usr/bin/env bash
# Start one service as compose does: a clean environment holding config/app.env, replit.env over
# it, and that service's own secrets from .run/env. Replit hands every secret to every process; this
# keeps each one, the OpenRouter key above all, with the services allowed to see it.
#   infra/replit/service.sh <secrets> [NAME=value …] <command …>
set -euo pipefail
cd "$(dirname "$0")/../.."
exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 \
  bash -c 'set -a; . config/app.env; . infra/replit/replit.env; . ".run/env/$0.env"; set +a; exec env "$@"' "$@"
