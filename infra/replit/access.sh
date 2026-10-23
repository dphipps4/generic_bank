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
echo "All of it, with the logins, is in Replit's Preview pane: https://$REPLIT_DEV_DOMAIN"
echo "Every other login and the members: cat ACCESS.md, in the Shell."

# The same addresses, without the logins, in Slack: the first thing to find after a Run. Only when
# Slack is linked to the app; without it, nothing is posted and the Run goes on.
token="$(curl -s -m 10 -H 'Accept: application/json' -H "X_REPLIT_TOKEN: repl ${REPL_IDENTITY:-}" \
  "https://${REPLIT_CONNECTORS_HOSTNAME:-none}/api/v2/connection?include_secrets=true&connector_names=slack" 2>/dev/null |
  jq -r '.items[0].settings | .access_token // .oauth.credentials.access_token // empty' 2>/dev/null || true)"
[[ -n "$token" ]] || exit 0
name="$(grep '^SLACK_CHANNEL=' infra/replit/replit.env | cut -d= -f2-)"
channel="$(curl -s -m 10 -H "Authorization: Bearer $token" \
  "https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=1000" |
  jq -r --arg n "$name" '.channels[]? | select(.name == $n) | .id' | head -1)"
[[ -n "$channel" ]] || exit 0
text="$(
  echo "*Generic Bank is up.* Every address and login is on the start page, which is Replit's Preview pane: <https://${REPLIT_DEV_DOMAIN:-}|open it>"
  sed -n '/^## Open these/,/^## Logins/p' ACCESS.md | grep '^| [A-Z]' | grep -v '^| What' |
    awk -F' [|] ' '{ sub(/^[|] /, "", $1); printf "• %s: <%s>\n", $1, $2 }'
)"
jq -n --arg c "$channel" --arg t "$text" '{channel: $c, text: $t, unfurl_links: false}' |
  curl -s -m 10 -H "Authorization: Bearer $token" -H 'Content-Type: application/json; charset=utf-8' \
    -d @- https://slack.com/api/chat.postMessage | jq -r 'if .ok then "Posted the addresses to Slack." else "Slack: \(.error)" end'
