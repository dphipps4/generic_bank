#!/usr/bin/env bash
# Everything GitHub's CI runs, on this machine, so a fork can check a change without Actions:
# the checks, the whole suite, the escalation and transfer-safety suites, the long suite, the images
# it ships with their secret scan, the compose file, and the history's secret scan. Slow (most of an
# hour) and heavy; just check is the quick version.
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

info "The whole suite, the escalation and transfer-safety suites, the long suite (two workers at most)"
[[ -x .run/browser/chrome ]] || [[ -n "${CHROME_PATH:-}" ]] || infra/scripts/browser.sh
npx vitest run --maxWorkers=2 --exclude 'tests/escalation/**' --exclude 'tests/transfer/**'
# In these suites and the long one, a skipped test is a failure: each must run as many as it has.
npx vitest run tests/escalation tests/transfer --maxWorkers=2 \
  --reporter=default --reporter=json --outputFile.json=.run/suites.json
node infra/scripts/suite-ran.mjs .run/suites.json tests/escalation=9 tests/transfer=10
npx vitest run --config vitest.long.config.ts --maxWorkers=1 \
  --reporter=default --reporter=json --outputFile.json=.run/long.json
node infra/scripts/suite-ran.mjs .run/long.json \
  tests/long/swallowed-submit.test.ts=1 tests/long/transfer-swallowed.test.ts=1

info "The images that ship, and no secret inside them"
docker build -q -f infra/docker/node.Dockerfile -t generic-bank/node:ci . >/dev/null
docker build -q -f infra/docker/runner.Dockerfile --build-arg BASE=generic-bank/node:ci -t generic-bank/runner:ci . >/dev/null
docker build -q -f infra/docker/tools.Dockerfile -t generic-bank/tools:ci infra/docker >/dev/null
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/work" -w /work generic-bank/tools:ci bash -c \
  'source infra/scripts/lib.sh && sops --version >/dev/null && age --version >/dev/null && jq --version >/dev/null && node infra/docs/render-plan.cjs >/dev/null'
infra/scripts/secrets-scan.sh image generic-bank/node:ci generic-bank/runner:ci generic-bank/tools:ci

info "The compose file, with every profile"
infra/scripts/render-env.sh >/dev/null
docker compose -f infra/compose/compose.yaml --env-file config/app.env -p generic-bank-ci --profile '*' config -q

info "The Justfile: every recipe parses, and up's commands resolve"
just --summary >/dev/null
just --dry-run up >/dev/null

info "No secret in the history or in uncommitted changes"
infra/scripts/secrets-scan.sh

ok "everything CI runs passed here"
