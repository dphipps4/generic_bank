#!/usr/bin/env bash
# Before the services start on Replit: the build, Replit's database, the secrets. Each step skips
# what is already done, so a second Run starts in seconds.
set -euo pipefail
cd "$(dirname "$0")/../.."
export GB_IN_TOOLS=1 SOPS_AGE_KEY_FILE="$PWD/.run/age/keys.txt"
mkdir -p .run/data/evidence .run/data/sessions .run/models && chmod 700 .run

# The build, as the Node image makes it: no GPU libraries, only Linux's ONNX binaries, and the
# build's tools pruned after it, which keeps the app inside Replit's storage limit.
stamp="$(find apps packages package.json package-lock.json tsconfig*.json -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.tsbuildinfo' -print0 | LC_ALL=C sort -z | xargs -0 sha1sum | sha1sum | cut -c1-16)"
if [[ "$(cat .run/build.stamp 2>/dev/null)" != "$stamp" ]]; then
  echo "==> Installing and building: a few minutes the first time"
  ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund --loglevel=error
  rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin node_modules/onnxruntime-node/bin/napi-v6/win32
  npx prisma generate --schema packages/db/prisma/schema.prisma
  npx tsc -b
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
  npx prisma generate --schema packages/db/prisma/schema.prisma
  echo "$stamp" > .run/build.stamp
fi

# Replit's Postgres holds what our two servers hold under compose: the system's databases and the
# banks'. Its address comes from Replit; render-env.sh lets it win over the compose names.
base="${DATABASE_URL%%\?*}"
base="${base%/*}"
for db in control memory bank_generic bank_example; do
  [[ "$(psql "$DATABASE_URL" -tAc "select 1 from pg_database where datname = '$db'")" == 1 ]] ||
    psql "$DATABASE_URL" -qc "create database $db"
done
psql "$base/memory" -qc 'create extension if not exists vector'
export CONTROL_DATABASE_URL="$base/control" MEMORY_DATABASE_URL="$base/memory" BANK_DATABASE_URL_BASE="$base"

# The secrets: generated here, kept in SOPS files encrypted to this workspace's own age key. The
# OpenRouter key is the one a person enters, as a Replit Secret.
infra/scripts/secrets-init.sh
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  printf '%s' "$OPENROUTER_API_KEY" | jq -Rs . |
    sops set --value-stdin config/factory.secrets.enc.env '["OPENROUTER_API_KEY"]'
fi
infra/scripts/render-env.sh

# The schemas, then the banks at the addresses Chrome reaches them by here.
infra/replit/service.sh migrate node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma
infra/replit/service.sh memory-migrate node_modules/.bin/prisma migrate deploy --schema apps/memory/prisma/schema.prisma
psql "$CONTROL_DATABASE_URL" -qc "update \"Bank\" set url = regexp_replace(url, '^http://(bank-[a-z]+):', 'http://\1.localhost:') where url !~ '\.localhost:'"
echo "==> Ready"
