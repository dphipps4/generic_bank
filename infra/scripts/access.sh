#!/usr/bin/env bash
# Write ACCESS.md: the one place to start, for this machine's stack. Links, logins, the members and
# their accounts as each bank seeded them, the demo in short, then the internal tokens at the
# bottom. Logins come from the encrypted secrets; the members from .run/members.md, which just
# access reads from the banks first. Never committed, readable only by you.
source "$(dirname "$0")/lib.sh"
in_tools "$@"

set -a; source config/app.env; [[ -f config/local.env ]] && source config/local.env; set +a

local_env="$(decrypt local)"
get() { grep "^$1=" <<<"$2" | head -1 | cut -d= -f2-; }
members="$(cat .run/members.md 2>/dev/null || echo '_The banks were not up: run just access once they are._')"
# The demo's member and two of their accounts at bank 2, read from the banks, never written here.
row="$(sed -n '/^\*\*Bank 2/,$p' .run/members.md 2>/dev/null | grep -m1 '^| `' || true)"
member="$(cut -d'|' -f2 <<<"$row" | tr -dc '0-9' || true)"
fours="$(cut -d'|' -f4 <<<"$row" | grep -oE '[0-9]{4}' | head -2 | tr '\n' ' ' || true)"
factory="just factory example ${member:-<member>} ${fours:-<from> <to>}"
factory="${factory% }"

A=http://localhost:${API_PORT:-8000}
C=http://localhost:${CONSOLE_PORT:-8080}
B1=http://localhost:${BANK_GENERIC_PORT:-8081}/corelink/
B2=http://localhost:${BANK_EXAMPLE_PORT:-8082}/
I=http://localhost:${BANK_INBOX_PORT:-8089}
# On Replit: the workspace's preview address, at the external ports .replit gives each page.
if [[ -n "${REPLIT_DEV_DOMAIN:-}" ]]; then
  w=https://$REPLIT_DEV_DOMAIN
  A=$w:8000 C=$w B1=$w:8081/corelink/ B2=$w:3000/ I=$w:3001
  factory="infra/replit/factory.sh${factory#just factory}"
fi

out=ACCESS.md
umask 077
cat >"$out" <<EOF
# Access

Everything for this machine's stack, in one place. \`just up\` writes it, and \`just access\` writes it again. It's never committed. \`just show\` writes this page again as ACCESS.html and opens it, then every page below. The demos, step by step: [Demo 1, bank 1](docs/demo-1.md) and [Demo 2, bank 2](docs/demo-2.md).

## Open these

| What | Address | Sign in with |
|---|---|---|
| Task API, Swagger UI | $A/docs | Authorize: the client id and secret below |
| Console | $C | the Console login below |
| Bank 1, Generic Bank | $B1 | the teller below ("Operator ID") |
| Bank 2, Example Credit Union | $B2 | the teller below ("Username") |
| Simulated inbox: the staff phone and email | $I | nobody: codes arrive here, each with Copy code |

## Logins

| Who | Username | Password |
|---|---|---|
| Swagger UI's Authorize (client id, secret) | \`$(get API_LOCAL_CLIENT_ID "$local_env")\` | \`$(get API_LOCAL_CLIENT_SECRET "$local_env")\` |
| Console admin | \`admin@generic-bank.local\` | \`$(get CONSOLE_ADMIN_PASSWORD "$local_env")\` |
| Teller, both banks | \`${BANK_OPERATOR_ID}\` | \`$(get BANK_SERVICE_PASSWORD "$local_env")\` |
| Supervisor, both banks | \`${BANK_SUPERVISOR_ID}\` | \`$(get BANK_SUPERVISOR_PASSWORD "$local_env")\` |

A bank's sign-in code goes to the simulated inbox and lasts 7 minutes. Enter it once, in the Console's Inbox; the bank then remembers the workstation for 30 days.

## Members

Bank 1 takes an account by its name, bank 2 by its last four. \`40099999\` is nobody, at both.

$members

## The demo, short

1. **Swagger UI:** Authorize, then \`POST /tasks/check-balance\` with \`{"bank":"generic","memberId":"${member:-<member>}","account":"Everyday Checking"}\`. The first time, copy the code from the simulated inbox into the Console's Inbox. The balance comes back in the same call.
2. **Transfer:** \`POST /tasks/transfer\` on bank 1; approve it in the Console's Inbox; \`GET /tasks/{runId}\`; the run's Frames in the Console.
3. **Hazards:** the Console's Hazard lab, Copy arguments beside \`promo\`, \`confirm-dialog\` or \`swallowed-click\`, added to the end of a bank 1 address.
4. **Bank 2:** \`GET /banks\` says \`"stub": true\`. \`$factory\`, the first member's checking and savings; approve the table on the Console's Recommendations; then a balance on bank 2.

## Internal

For curl and debugging; the demo doesn't need these.

| What | Address | Token, as \`Authorization: Bearer\` |
|---|---|---|
| Task API token for curl | $A | \`just api-token\` (8 hours) |
| Banks' admin API: \`/state\`, \`/members/{m}/balances\`, \`/hazards\`, \`/messages\` | :${BANK_GENERIC_ADMIN_PORT:-9081} and :${BANK_EXAMPLE_ADMIN_PORT:-9082} | \`$(get BANK_ADMIN_TOKEN "$local_env")\` |
| Memory, curator role | :${MEMORY_PORT:-8470} | \`$(get MEMORY_TOKEN_CURATOR "$local_env")\` |
| Factory gateway | :${FACTORY_PORT:-8200} | \`$(get FACTORY_GATEWAY_TOKEN "$(decrypt factory 2>/dev/null || true)")\` |
| A forced hazard for curl, as \`X-Hazards\` | either bank | \`just hazard-header late-rows,promo\` |

**Postgres, for TablePlus or any SQL client.** Host \`127.0.0.1\`, user \`postgres\`, no SSL.

| Server | Port | Databases | Password |
|---|---|---|---|
| The system: runs, people's tasks, API clients, the audit | \`${CONTROL_DB_PORT:-5433}\` | \`control\`, \`memory\` | \`$(get POSTGRES_PASSWORD "$local_env")\` |
| The banks' own data: members, accounts, codes sent | \`${BANK_DB_PORT:-5434}\` | \`bank_generic\`, \`bank_example\` | \`$(get BANK_DB_PASSWORD "$local_env")\` |

Every service answers \`/healthz\`: ports ${API_PORT:-8000}, ${CONSOLE_PORT:-8080}, ${RUNNER_PORT:-8100}, ${FACTORY_PORT:-8200}, ${MEMORY_PORT:-8470}, ${BANK_GENERIC_PORT:-8081}, ${BANK_EXAMPLE_PORT:-8082}, ${BANK_INBOX_PORT:-8089}, ${BANK_GENERIC_ADMIN_PORT:-9081} and ${BANK_EXAMPLE_ADMIN_PORT:-9082}.
EOF
chmod 600 "$out"
# The same, as a page to read in a browser, with a Copy button beside every value.
node "$(dirname "$0")/access-html.mjs" "$out" "${out%.md}.html" && chmod 600 "${out%.md}.html"
ok "$out and ${out%.md}.html written (readable only by you)"
