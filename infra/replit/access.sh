#!/usr/bin/env bash
# ACCESS.md on Replit, once the services are up: `just access` reads the members through Docker,
# this reads them from Replit's Postgres with the same query, then writes the page the same way.
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
