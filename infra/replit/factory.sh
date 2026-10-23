#!/usr/bin/env bash
# A factory run on Replit, as `just factory` starts one, while the services are running:
#   infra/replit/factory.sh example <member> <from> <to>
# The hard stop is the agents' minutes plus fifteen for a person's three codes.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . config/app.env; set +a
limit=$(( (${FACTORY_RUN_LIMIT_MINUTES:-60} + 15) * 60 ))
echo "  the run's hard limit: $(( limit / 60 )) minutes"
exec timeout -k 10 "$limit" infra/replit/service.sh factory node apps/factory/dist/cli.js "$@"
