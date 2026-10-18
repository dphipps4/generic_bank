# Access

Everything you can open, call or poke once `just up` has run. That command starts the whole
stack: the data box, memory (empty until the factory learns something), the Task API, the Console,
the runner, both banks, the staff inbox and the factory. Every port listens only on this machine (127.0.0.1).

The logins are in `secrets/credentials.txt`. `just up` writes it from the encrypted secrets, and
`just credentials` writes it again. The file never leaves your machine and is never committed.
The Postgres login isn't in it; read that one with `just secrets-edit local`.

## In a browser

| What | URL | Sign in with |
|---|---|---|
| Console (admin) | http://localhost:8080 | `admin@generic-bank.local` and the Console password |
| Console inbox (codes, approvals, escalations) | http://localhost:8080/inbox | the same |
| Console runs, with each run's frames | http://localhost:8080/runs | the same |
| Hazard lab | http://localhost:8080/lab | the same |
| Recommendations (tables the factory learned, waiting for approval) | http://localhost:8080/recommendations | the same |
| Freezes | http://localhost:8080/freezes | the same |
| API clients, Console users, the audit log (AdminJS) | http://localhost:8080/admin | the same |
| Task API, Swagger UI | http://localhost:8000/docs | press Authorize, enter the local client's id and secret (secrets/credentials.txt) |
| Bank 1, Generic Bank (2003 frameset) | http://localhost:8081/corelink/ | `teller0412` and its password |
| Bank 2, Example Credit Union | http://localhost:8082/ | the same |
| Staff inbox (the bank staff's phone and email) | http://localhost:8089 | none |

Supervisor `supervisor0901` signs in just like `teller0412`. A transfer over a
bank's manager threshold ($2,500 at bank 1) asks for a supervisor's code; the crawler doesn't
handle that page, so the run stops and a person finishes it.

Banks send their sign-in codes to the staff inbox. A code lasts five minutes.

## APIs

| Service | Base URL | Auth |
|---|---|---|
| Task API | http://localhost:8000 | `Authorization: Bearer $(just api-token)` |
| Task API, OpenAPI document | http://localhost:8000/openapi.json | none |
| Task API, agent tools | http://localhost:8000/tools | `Authorization: Bearer $(just api-token)` |
| Bank admin API, banks 1 and 2 | http://localhost:9081 and 9082 | `Authorization: Bearer` the bank admin token |
| Memory | http://localhost:8470 | `Authorization: Bearer` a memory role token |
| Factory gateway | http://localhost:8200 | `Authorization: Bearer` the factory gateway token |

The bank admin API reads a bank's own state, which is how tests judge what really happened:
`/state`, `/members/{member}/balances`, `/hazards` (the hazard log) and `/messages` (the codes
it sent).

## Health

Each answers 200 when the service is up.

| Service | URL |
|---|---|
| Task API | http://localhost:8000/healthz |
| Console | http://localhost:8080/healthz |
| Runner (the crawler) | http://localhost:8100/healthz |
| Factory | http://localhost:8200/healthz |
| Memory | http://localhost:8470/healthz |
| Banks 1 and 2 | http://localhost:8081/healthz, :8082 |
| Bank admin APIs | http://localhost:9081/healthz, :9082 |
| Staff inbox | http://localhost:8089/healthz |

All of them at once:

```sh
for u in 8000 8080 8100 8200 8470 8081 8082 8089 9081 9082; do
  printf '%-5s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$u/healthz"
done
```

## Members to try

| Member | What it is |
|---|---|
| `40017732` | healthy: checking, savings and money market |
| `40021145` | checking and an IRA; a transfer out of the IRA is refused |
| `40023318` | checking and a CD; a transfer out of the CD is refused |
| `40025561` | checking with $3.17 available |
| `40027794` | a savings account marked "refer to branch" |
| `40029907` | a closed member |
| `40031120` | large balances, for supervisor approval and the daily limit |
| `40099999` | doesn't exist: "No member found" |

## Things to try with curl

Bank 2 turns away anything that doesn't look like a browser, the way a real bank's bot
screen does. Bank 1, the old site, doesn't check:

```sh
curl -i http://localhost:8082/             # 403 Access denied
curl -i http://localhost:8081/corelink/    # 200
```

### Faults

The banks throw faults on their own now and then. To force one, sign a hazard header and send it
with the request. A bank only obeys a header signed with this machine's key.

```sh
H=$(just hazard-header service-unavailable)
curl -i -H "X-Hazards: $H" http://localhost:8081/corelink/     # 503, the gateway's error page
```

Most hazards strike on the pages behind sign-in (an error page, a dialog, rows that come late),
so a bare curl only reaches the ones at the front door. The crawler is the better way to meet
the rest.

The hazards: `confirm-dialog`, `early-expiry`, `injected-instruction`, `js-error-fatal`,
`js-error-harmless`, `js-error-widget`, `late-rows`, `latency`, `permission-denial`, `promo`,
`record-in-use`, `record-not-found`, `service-unavailable`, `slow-handoff`, `swallowed-click`,
`swallowed-submit`, `unknown-screen`, `validation-error`. Several can go in one header,
separated by commas.

To watch the crawler meet a hazard and land on the right result, run a whole task under it, from
the command line or the Console's hazard lab:

```sh
just try late-rows
just try permission-denial
just try swallowed-submit transfer
```

Each prints the run, the expected result and a Console link to it, where the Frames button shows
every page the crawler saw.

To see what the bank itself recorded:

```sh
BANK_ADMIN_TOKEN=$(awk '/^Bank admin API/{f=1; next} f && /^  token/{print $2; exit}' secrets/credentials.txt)
curl -s http://localhost:9081/hazards -H "Authorization: Bearer $BANK_ADMIN_TOKEN"
curl -s http://localhost:9081/members/40017732/balances -H "Authorization: Bearer $BANK_ADMIN_TOKEN"
```

## Other ways in

| Command | What it does |
|---|---|
| `just try …` | one task under a forced hazard, with its expected result |
| `just api-token` | an access token for curl, from the local client (8 hours) |
| `just ps`, `just logs` | what's running, and its logs |
| `just db-shell` | psql on the control database |
| `just urls` | the main pages, printed |

## Try the Task API

All of this runs on this machine. `just setup` made a local API client; its id and secret are in
`secrets/credentials.txt`.

**In the browser, with Swagger UI.** Open http://localhost:8000/docs and press **Authorize**. Under
`client`, enter the id and secret; Swagger UI gets the token itself. Then open a task, press
**Try it out**, then **Execute**.

**With curl.** First a token, good for 8 hours:

```sh
TOKEN=$(just api-token)
```

A balance on bank 1. It answers with a `runId`:

```sh
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","account":"Everyday Checking"}'
```

Read the result. `?wait=30` holds the call until the run ends, or 30 seconds pass. When the bank asks
for a sign-in code, the run waits for you: the code is in the staff inbox, http://localhost:8089,
and you enter it in the Console inbox, http://localhost:8080/inbox, within its five minutes. If a safety check stops a
run, it freezes that bank until an admin clears it on the Console's Freezes page.

```sh
curl -s "http://localhost:8000/tasks/<runId>?wait=30" -H "Authorization: Bearer $TOKEN"
```

The same on bank 2, once the factory has learned it and a person has approved its table (see
below); until then bank 2 answers `task_not_available`. An account goes by its last four digits, and
the bank's admin API lists them:

```sh
BANK_ADMIN_TOKEN=$(awk '/^Bank admin API/{f=1; next} f && /^  token/{print $2; exit}' secrets/credentials.txt)
curl -s http://localhost:9082/members/40017732/balances -H "Authorization: Bearer $BANK_ADMIN_TOKEN"
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"example","memberId":"40017732","account":"<last four>"}'
```

A transfer stops on the bank's review page until a person approves it in the Console inbox, with a
reason of at least ten characters; then read its result as above. Send the same `idempotencyKey`
again and you get the same run back, never a second transfer:

```sh
curl -s -X POST http://localhost:8000/tasks/transfer \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","from":"Everyday Checking","to":"Rainy Day Savings","amountCents":2500,"memo":"rent","idempotencyKey":"try-transfer-0001"}'
```

## Run the factory

The factory learns bank 2, or repairs it if a repair case is open. Give it a member and two of their
accounts by last four (the bank admin API lists them, as above):

```sh
just factory example 40017732 <from last four> <to last four>
```

While it runs, enter the bank's sign-in codes in the Console inbox as above. It ends with a report:
its cost, the actions judged and refused, the corrections, and the lessons sent. A table that passes
its live check waits on the Console's Recommendations page, each row beside its picture; approving it
puts bank 2 into service. Each run is capped at $25.
