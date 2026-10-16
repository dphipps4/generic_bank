# Access

Everything you can open, call or poke once `just up` has run. `just up` starts the whole stack:
the data box, memory and its seed, the Task API, the Console, the crawler, all four banks, the
staff inbox and the factory. Every port listens on this machine only (127.0.0.1).

The logins are in `secrets/credentials.txt`, which `just up` writes from the encrypted secrets
(run `just credentials` to write it again). It never leaves your machine and is never committed.
Postgres isn't in it; read that with `just secrets-edit local`.

If you ran `just fork-ports` in a second copy, add its offset (10000 by default) to every port
below.

## In a browser

| What | URL | Sign in with |
|---|---|---|
| Console (admin) | http://localhost:8080 | `admin@generic-bank.local` and the Console password |
| Console inbox (codes, approvals, escalations) | http://localhost:8080/inbox | the same |
| Console runs, with each run's frames | http://localhost:8080/runs | the same |
| Hazard lab | http://localhost:8080/lab | the same |
| Recommendations (the factory's drafts) | http://localhost:8080/recommendations | the same |
| Journal, Freezes | http://localhost:8080/journal, http://localhost:8080/freezes | the same |
| Database tables (AdminJS) | http://localhost:8080/admin | the same |
| Task API, Swagger UI | http://localhost:8000/docs | press Authorize, paste `just api-token` |
| API reference, static | http://localhost:8099 | none (`just api-docs` serves it) |
| Bank 1, Generic Bank (2003 frameset) | http://localhost:8081/corelink/ | operator `0412` and its password |
| Bank 2, Example Credit Union | http://localhost:8082/ | the same |
| Bank 3, Sample Savings Bank | http://localhost:8083/online/branch/ | the same |
| Bank 4, Placeholder FCU | http://127.0.0.1:8084/cu/ib/ | the same, with a code from its authenticator |
| Staff inbox (the bank staff's phone and email) | http://localhost:8089 | none |
| MinIO console (evidence and statements) | http://localhost:9001 | MinIO user and password |
| Vault | http://localhost:8201/ui | Vault root token |

Bank 2 also serves pages from a second origin on 8092, and bank 4 on 8094; you reach them
through the bank's own pages, not directly. Supervisor `0901` signs in the same way as `0412`
and is the one who approves a large transfer.

A bank sends its sign-in codes to the staff inbox. Bank 4 uses an authenticator app instead,
and the inbox shows that app's current code too.

## APIs

| Service | Base URL | Auth |
|---|---|---|
| Task API | http://localhost:8000 | `Authorization: Bearer $(just api-token)` |
| Task API, OpenAPI document | http://localhost:8000/openapi.json | none |
| Task API, agent tools | http://localhost:8000/tools | none |
| Bank admin API, banks 1 to 4 | http://localhost:9081 to 9084 | `Authorization: Bearer` the bank admin token |
| Memory | http://localhost:8470 | `Authorization: Bearer` a memory role token |
| Factory gateway | http://localhost:8200 | `Authorization: Bearer` the factory gateway token |
| MinIO S3 API | http://localhost:9000 | MinIO user and password |
| Vault API | http://localhost:8201/v1 | `X-Vault-Token` the root token |

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
| Banks 1 to 4 | http://localhost:8081/healthz, :8082, :8083, :8084 |
| Bank admin APIs | http://localhost:9081/healthz to :9084 |
| Staff inbox | http://localhost:8089/healthz |
| MinIO | http://localhost:9000/minio/health/live |
| Vault | http://localhost:8201/v1/sys/health |

All of them at once:

```sh
for u in 8000 8080 8100 8200 8470 8081 8082 8083 8084 8089 9081 9082 9083 9084; do
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

Banks 2 to 4 turn away anything that isn't shaped like a browser, the way a real bank's bot
screen does. Bank 1, the old site, doesn't check:

```sh
curl -i http://localhost:8082/             # 403 Access denied
curl -i http://localhost:8081/corelink/    # 200
```

Ask the Task API for a balance, then read the result. The run waits for a person when the bank
sends a sign-in code: answer it in the Console inbox.

```sh
TOKEN=$(just api-token 2>/dev/null)
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","account":"Everyday Checking"}'
curl -s http://localhost:8000/tasks/<runId> -H "Authorization: Bearer $TOKEN"
```

A transfer stops on the bank's review page until a person approves it in the Console. Send the
same `idempotencyKey` again and you get the same run back, never a second transfer:

```sh
curl -s -X POST http://localhost:8000/tasks/transfer \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","from":"Everyday Checking","to":"Rainy Day Savings","amountCents":2500,"memo":"rent","idempotencyKey":"try-transfer-0001"}'
```

### Faults

A bank throws faults on its own now and then. To force one, sign a hazard header and send it
with the request; a bank only obeys a header signed with this machine's key.

```sh
H=$(just hazard-header service-unavailable)
curl -i -H "X-Hazards: $H" http://localhost:8081/corelink/     # 503, the gateway's error page
```

Most hazards strike on the pages behind sign-in (an error page, a dialog, rows that come late),
so a bare curl only reaches the ones at the front door. The crawler is the better way to meet
the rest.

The hazards: `confirm-dialog`, `early-expiry`, `injected-instruction`, `js-error-fatal`,
`js-error-harmless`, `js-error-widget`, `late-rows`, `latency`, `permission-denial`,
`record-in-use`, `record-not-found`, `service-unavailable`, `slow-handoff`, `swallowed-click`,
`swallowed-submit`, `unknown-screen`, `validation-error`. Several can go in one header,
separated by commas.

To watch the crawler meet a hazard and end in the result it should, run a whole task under it,
from the command line or from the Console's hazard lab:

```sh
just try late-rows
just try permission-denial
just try swallowed-submit transfer
```

Each prints the run, the expected result and a link to the run in the Console, where the Frames
button shows every page the crawler saw.

What the bank recorded, straight from the bank:

```sh
BANK_ADMIN_TOKEN=$(awk '/^Bank admin API/{f=1; next} f && /^  token/{print $2; exit}' secrets/credentials.txt)
curl -s http://localhost:9081/hazards -H "Authorization: Bearer $BANK_ADMIN_TOKEN"
curl -s http://localhost:9081/members/40017732/balances -H "Authorization: Bearer $BANK_ADMIN_TOKEN"
```

## Other ways in

| Command | What it does |
|---|---|
| `just agent` | the demo agent: a member assistant that uses only the Task API's tools (mock mode with no key) |
| `just try …` | one task under a forced hazard, with its expected result |
| `just api-token` | a fresh Task API token, for Swagger UI or curl (15 minutes) |
| `just api-docs` | writes and serves the API reference on port 8099 |
| `just ps`, `just logs` | what's running, and its logs |
| `just db-shell` | psql on the control database |
| `just urls` | the main pages, printed |
