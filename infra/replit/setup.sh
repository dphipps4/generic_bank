#!/usr/bin/env bash
# Before the services start on Replit: the build, Replit's database, the secrets. Each step skips
# what is already done, so a second Run starts in seconds.
set -euo pipefail
cd "$(dirname "$0")/../.."
export GB_IN_TOOLS=1 SOPS_AGE_KEY_FILE="$PWD/.run/age/keys.txt"
mkdir -p .run/data/evidence .run/data/sessions .run/models && chmod 700 .run

# The build, as the Node image makes it: no GPU libraries, only Linux's ONNX binaries, and the
# build's tools pruned after it, which keeps the app inside Replit's storage limit.
src=(apps packages package.json package-lock.json tsconfig.json tsconfig.base.json)
stamp="$( { git rev-parse "${src[@]/#/HEAD:}"; git diff HEAD -- "${src[@]}"; } | sha1sum | cut -c1-16)"
if [[ "$(cat .run/build.stamp 2>/dev/null)" != "$stamp" ]]; then
  echo "==> Installing and building: a few minutes the first time"
  ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund --loglevel=error
  rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin node_modules/onnxruntime-node/bin/napi-v6/win32
  npx prisma generate --schema packages/db/prisma/schema.prisma
  npx tsc -b
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
  git checkout -q -- package-lock.json # prune rewrites it; the stamp reads the committed one
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
# OpenRouter key is the one a person enters, as a Replit Secret. Nix's sops has no --value-stdin,
# so the file is decrypted inside .run, given the key, and encrypted again, as secrets-init.sh does.
infra/scripts/secrets-init.sh
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  f=config/factory.secrets.enc.env plain=.run/secrets.factory.plain
  trap 'rm -f "$plain"' EXIT
  ( umask 077
    { sops decrypt --input-type dotenv --output-type dotenv "$f" | grep -v '^OPENROUTER_API_KEY='
      echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"; } > "$plain"
    sops encrypt --input-type dotenv --output-type dotenv --filename-override "$f" "$plain" > "$f.new" )
  mv "$f.new" "$f" && rm -f "$plain"
fi
infra/scripts/render-env.sh

# The schemas, then the banks at the addresses Chrome reaches them by here.
infra/replit/service.sh migrate node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma
infra/replit/service.sh memory-migrate node_modules/.bin/prisma migrate deploy --schema apps/memory/prisma/schema.prisma
psql "$CONTROL_DATABASE_URL" -qc "update \"Bank\" set url = regexp_replace(url, '^http://(bank-[a-z]+):', 'http://\1.localhost:') where url !~ '\.localhost:'"
echo "==> Ready"
