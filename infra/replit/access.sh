#!/usr/bin/env bash
# ACCESS.md on Replit, once the services are up: `just access` reads the members through Docker,
# this reads them from Replit's Postgres with the same query, then writes the page the same way.
# Replit's file tree hides ACCESS.md (it is ignored by git), so the addresses and the Console's
# sign-in are also printed in the Run's console, where a person looks first.
set -euo pipefail
cd "$(dirname "$0")/../.."
export GB_IN_TOOLS=1 SOPS_AGE_KEY_FILE="$PWD/.run/age/keys.txt"
base="$(grep '^BANK_DATABASE_URL_BASE=' .run/env/bank.env | cut -d= -f2-)"
: > .run/members.md
for b in generic example; do
  rows="$(psql "$base/bank_$b" -At -c "SELECT '| \`' || m.number || '\` | ' || m.first_name || ' ' || m.last_name || CASE WHEN m.status = 'closed' THEN ' (closed)' ELSE '' END || ' | ' || string_agg(a.nickname || ' …' || right(a.number, 4), ', ' ORDER BY a.id) || ' |' FROM members m JOIN accounts a ON a.member_number = m.number GROUP BY m.number, m.first_name, m.last_name, m.status ORDER BY m.number" 2>/dev/null || true)"
  [[ -n "$rows" ]] || continue
  { [[ $b == generic ]] && echo "**Bank 1, Generic Bank**" || echo "**Bank 2, Example Credit Union**"
    echo; echo "| Member | Name | Accounts |"; echo "|---|---|---|"; echo "$rows"; echo; } >> .run/members.md
done
infra/scripts/access.sh

echo
echo "Generic Bank is up. Open these in your browser:"
sed -n '/^## Open these/,/^## Logins/p' ACCESS.md | grep '^| [A-Z]' | grep -v '^| What' |
  awk -F' [|] ' '{ sub(/^[|] /, "", $1); printf "  %-30s %s\n", $1, $2 }'
echo
grep '^| Console admin' ACCESS.md | tr -d '`' |
  awk -F' *[|] *' '{ print "Console sign-in, in its own browser tab: " $3 " / " $4 }'
echo "Replit's Preview pane shows the Console but cannot sign in to it: Replit wants an X-Requested-With"
echo "header on a form sent from inside its frame. Open the Console's address in a tab of its own."
echo "Every other login and the members: cat ACCESS.md, in the Shell."
