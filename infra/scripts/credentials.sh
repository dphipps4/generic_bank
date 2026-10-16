#!/usr/bin/env bash
# Write secrets/credentials.txt: every login and token a person needs to reach the stack over
# HTTP, read from the encrypted secrets files. Postgres passwords are left out (read them with
# make secrets-edit). The file is this machine's alone: never committed, readable only by you.
source "$(dirname "$0")/lib.sh"
in_tools "$@"

# The ports this machine uses, moved if make fork-ports was run.
set -a; source config/app.env; [[ -f config/local.env ]] && source config/local.env; set +a

local_env="$(decrypt local)"
ops_env="$(decrypt ops 2>/dev/null || true)"
get() { grep "^$1=" <<<"$2" | head -1 | cut -d= -f2-; }

out=secrets/credentials.txt
mkdir -p secrets
umask 077
cat >"$out" <<EOF
# Generic Bank: credentials for this machine's stack. Written by make up (make credentials).
# Never commit this file. Postgres is not here: make secrets-edit FILE=local shows it.

Console (admin UI)            http://localhost:${CONSOLE_PORT:-8080}
  email                       admin@generic-bank.local
  password                    $(get CONSOLE_ADMIN_PASSWORD "$local_env")

Bank staff sign-in (every bank's console)
  operator 0412 (teller)      $(get BANK_SERVICE_PASSWORD "$local_env")
  operator 0901 (supervisor)  $(get BANK_SUPERVISOR_PASSWORD "$local_env")
  staff codes                 http://localhost:${BANK_INBOX_PORT:-8089} (the staff phone and inbox)

Bank admin API (each bank's :90xx port), header Authorization: Bearer <token>
  token                       $(get BANK_ADMIN_TOKEN "$local_env")

MinIO (evidence store)        http://localhost:${MINIO_CONSOLE_PORT:-9001}
  user                        $(get MINIO_ROOT_USER "$local_env")
  password                    $(get MINIO_ROOT_PASSWORD "$local_env")

Vault                         http://localhost:${VAULT_PORT:-8201}/ui
  root token                  $(get VAULT_ROOT_TOKEN "$ops_env")

Task API (Swagger UI)         http://localhost:${API_PORT:-8000}/docs
  access token                make api-token (a fresh one, valid 15 minutes)

Memory API                    http://localhost:${MEMORY_PORT:-8470}, header Authorization: Bearer <token>
  runner token                $(get MEMORY_TOKEN_RUNNER "$local_env")
  curator token               $(get MEMORY_TOKEN_CURATOR "$local_env")

Factory gateway               http://localhost:${FACTORY_PORT:-8200}, header Authorization: Bearer <token>
  token                       $(get FACTORY_GATEWAY_TOKEN "$(decrypt factory 2>/dev/null || true)")

Forced hazards                make hazard-header HAZARDS=late-rows,promo (a signed X-Hazards value)
EOF
chmod 600 "$out"
ok "$out written (readable only by you)"
