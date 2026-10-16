#!/usr/bin/env bash
# What GitHub's CI checks, on this machine, so a fork can check a change without Actions: the
# Prisma schemas, types, lint, import boundaries, the whole suite, and no secret in the history.
# The fresh-clone job (just setup and just up on a clean machine) is the same as running those
# two here. just check is the quicker version.
source "$(dirname "$0")/lib.sh"
set -e

info "Checks: Prisma schemas, types, lint, import boundaries"
npm run --silent db:generate
CONTROL_DATABASE_URL=postgresql://ci:ci@localhost:5432/control \
  npx prisma validate --schema packages/db/prisma/schema.prisma >/dev/null
MEMORY_DATABASE_URL=postgresql://ci:ci@localhost:5432/memory \
  npx prisma validate --schema apps/memory/prisma/schema.prisma >/dev/null
npm run --silent typecheck
npm run --silent lint
npm run --silent depcruise

info "The whole suite (two workers, so the machine stays usable)"
[[ -x .run/browser/chrome ]] || [[ -n "${CHROME_PATH:-}" ]] || infra/scripts/browser.sh
npx vitest run --maxWorkers=2

info "No secret in the history or in uncommitted changes"
infra/scripts/secrets-scan.sh

ok "everything CI checks passed here"
