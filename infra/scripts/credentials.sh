#!/usr/bin/env bash
# Write secrets/credentials.txt: every login and token a person needs to reach the stack over
# HTTP, read from the encrypted secrets files. Postgres passwords are left out (read them with
# just secrets-edit). The file is this machine's alone: never committed, readable only by you.
source "$(dirname "$0")/lib.sh"
in_tools "$@"

# The ports this machine uses, with any local overrides from config/local.env.
set -a; source config/app.env; [[ -f config/local.env ]] && source config/local.env; set +a

local_env="$(decrypt local)"
get() { grep "^$1=" <<<"$2" | head -1 | cut -d= -f2-; }

out=secrets/credentials.txt
mkdir -p secrets
umask 077
cat >"$out" <<EOF
# Generic Bank: credentials for this machine's stack. Written by just up (just credentials).
# Never commit this file. Postgres is not here: just secrets-edit local shows it.

Start here
  Swagger UI      http://localhost:${API_PORT:-8000}/docs
  Console         http://localhost:${CONSOLE_PORT:-8080}
  Staff inbox     http://localhost:${BANK_INBOX_PORT:-8089}

Try it with: the seeded demo member, the same on every fresh stack
  member          40017732 (Alex Sample)
  bank 1          accounts "Everyday Checking" and "Rainy Day Savings"
  bank 2          the account ending 7255
  Swagger UI's Try it out starts from these

Console: the admin UI
  address         http://localhost:${CONSOLE_PORT:-8080}
  email           admin@generic-bank.local
  password        $(get CONSOLE_ADMIN_PASSWORD "$local_env")

The two banks' staff sites. Sign in to any of them as ${BANK_OPERATOR_ID} or ${BANK_SUPERVISOR_ID} (passwords below);
each bank names the username field its own way:
  Generic Bank (bank 1)            "Operator ID"   http://localhost:${BANK_GENERIC_PORT:-8081}/corelink/
  Example Credit Union (bank 2)    "Username"      http://localhost:${BANK_EXAMPLE_PORT:-8082}/

Teller: who does the work
  username        ${BANK_OPERATOR_ID}
  password        $(get BANK_SERVICE_PASSWORD "$local_env")

Supervisor: who approves large transfers
  username        ${BANK_SUPERVISOR_ID}
  password        $(get BANK_SUPERVISOR_PASSWORD "$local_env")

Staff inbox: where the sign-in codes arrive
  address         http://localhost:${BANK_INBOX_PORT:-8089}

The banks' admin API, header Authorization: Bearer <token>
  ports           ${BANK_GENERIC_ADMIN_PORT:-9081} and ${BANK_EXAMPLE_ADMIN_PORT:-9082}, banks 1 and 2
  token           $(get BANK_ADMIN_TOKEN "$local_env")

Task API: Swagger UI's Authorize takes this client id and secret
  Swagger UI      http://localhost:${API_PORT:-8000}/docs
  client id       $(get API_LOCAL_CLIENT_ID "$local_env")
  client secret   $(get API_LOCAL_CLIENT_SECRET "$local_env")
  access token    just api-token (8 hours), or Authorize in Swagger UI with the id and secret

Memory API, header Authorization: Bearer <token>
  address         http://localhost:${MEMORY_PORT:-8470}
  runner token    $(get MEMORY_TOKEN_RUNNER "$local_env")
  curator token   $(get MEMORY_TOKEN_CURATOR "$local_env")

Factory gateway, header Authorization: Bearer <token>
  address         http://localhost:${FACTORY_PORT:-8200}
  token           $(get FACTORY_GATEWAY_TOKEN "$(decrypt factory 2>/dev/null || true)")

Forced hazards
  header          just hazard-header late-rows,promo (a signed X-Hazards value)
EOF
chmod 600 "$out"
ok "$out written (readable only by you)"
