# Manual test: end to end, from a fresh clone

This is the run a reviewer makes: build the stack from nothing, then use each of the three tasks
through the Task API, playing the bank's staff and the approver yourself. It takes about 20
minutes. Each step says what to do, then what you should see.

Once the stack is up, `just open` opens three tabs:

| Tab | Address | What it is |
|---|---|---|
| Swagger UI | http://localhost:8000/docs | the Task API, to read and try |
| Console | http://localhost:8080 | lands on the Dashboard; a person answers sign-in codes and approves transfers in Inbox, and follows each run in Runs |
| Staff inbox | http://localhost:8089 | the simulated phone and email inbox: every sign-in code the banks send their staff arrives here |

## 1. Check the Mac

```sh
just requirements
```

You should see a ✓ on every line: macOS 14 or newer, git, just, Docker Engine 27 or newer,
Compose 2.29 or newer, buildx, Docker's memory (5.25 GB or more), at least 15 GiB of disk free,
and the ports.

## 2. Set up

```sh
just setup
```

It takes about two and a half minutes. It ends with:

```text
Ready. Next: just up, then open http://localhost:8080
Console sign-in: admin@generic-bank.local, password: just console-password
```

and a last line about the factory: green if a model key is set, otherwise a red ✗ telling you to
run `just secret-set factory ANTHROPIC_API_KEY`. The Task API doesn't need a model key, so you can
leave it red for this test.

## 3. Start everything

```sh
just up
```

It takes about a minute and a half. It prints the logins (the same as
`secrets/credentials.txt`), the URLs, and the factory line again.

## 4. Sign in to the Console

Open http://localhost:8080 and sign in as `admin@generic-bank.local` with the password from
`just console-password`.

You land on the **Dashboard**: what waits for a person (nothing yet), frozen banks (none), each
bank and the tasks it serves, the latest runs, and links to Swagger UI and the staff inbox. The
bar reads **Dashboard, Inbox, Runs, Recommendations, Journal, Hazard lab, Freezes, Data**.

## 5. Get a token

```sh
TOKEN=$(just api-token)
echo ${#TOKEN}
```

You should see `48`: a token that lasts 15 minutes. Run it again whenever a call answers `401`.

To try each call in Swagger UI as well, open http://localhost:8000/docs once, press **Authorize**
and, under `client`, enter the client id and secret from `secrets/credentials.txt` (the Task API
section). Swagger UI keeps you signed in, and each step below links to its call, ready to try.

## 6. A balance on bank 1

```sh
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","account":"Everyday Checking"}'
```

Or in Swagger UI: [`POST /tasks/check-balance`](http://localhost:8000/docs#/tasks/check_balance).

You should see the run start: `{"runId":"r_…","task":"check-balance","status":"running"}`.
Copy the `runId`.

The crawler signs in to the bank, and the bank texts a sign-in code to the staff phone:

- **Staff inbox:** under **Generic Bank**, a text to `+1 555 010412`: "Generic Bank: your CoreLink
  sign-in code is 123456. It expires in 5 minutes."
- **Console Inbox:** a **Staff code** task for bank generic, with a box and **Enter code**.

Type the six digits into the Console and press **Enter code**. Then read the result:

```sh
curl -s "http://localhost:8000/tasks/<runId>?wait=30" -H "Authorization: Bearer $TOKEN"
```

Or in Swagger UI: [`GET /tasks/{runId}`](http://localhost:8000/docs#/tasks/get_task).

You should see `"status":"succeeded"` with the balance, for example
`"currentCents":4123165,"availableCents":4114358`. The account label is masked
(`Account ending in ****`).

## 7. A balance on bank 2

Bank 2 names an account by its last four digits. Its admin API lists them:

```sh
BANK_ADMIN_TOKEN=$(awk '/^Bank admin API/{f=1; next} f && /^  token/{print $2; exit}' secrets/credentials.txt)
curl -s http://localhost:9082/members/40017732/balances -H "Authorization: Bearer $BANK_ADMIN_TOKEN"
```

Take the last four digits of the first account's `number` (for example `7255`), then:

```sh
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"example","memberId":"40017732","account":"7255"}'
```

Or in Swagger UI: [`POST /tasks/check-balance`](http://localhost:8000/docs#/tasks/check_balance).

This bank emails its code: in the staff inbox it's under **Example Credit Union**, to
`teller0412@example.bank.localhost`. Enter it in the Console as before, then read the result.
You should see `succeeded`, for example `"availableCents":3705167`, and the bank's own admin
API shows the same available balance.

## 8. A transfer, approved by a person

```sh
curl -s -X POST http://localhost:8000/tasks/transfer \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","from":"Everyday Checking","to":"Rainy Day Savings","amountCents":2500,"memo":"rent","idempotencyKey":"try-transfer-0001"}'
```

Or in Swagger UI: [`POST /tasks/transfer`](http://localhost:8000/docs#/tasks/transfer).

1. **The sign-in code.** Enter it in the Console as before.
2. **The approval.** The crawler fills in the transfer, stops on the bank's review page and waits.
   Reading the run now shows `"status":"needs_human","code":"awaiting_approval"`. The Console
   Inbox shows an **Approval** task with the review page's screenshot (masked) and the values as
   read: from, to, $25.00 and the memo.
3. **Approve it.** Type a reason of at least ten characters (for example "checked the amount and
   both accounts") and press **Approve**. A shorter reason is refused.

Read the result. You should see `"status":"succeeded"` with a `confirmation` such as
`GB-48213-G` and `"seenInHistory":true`: the crawler found the transfer in the account's own
history after submitting it.

Now send the very same request again. You should get the **same** `runId` and the same result
back, not a second transfer.

## 9. Two tasks at once

The Runner works on two tasks at a time, so a transfer waiting for approval holds up nothing.
Start a second transfer with a new key (`try-transfer-0002`) and stop at its approval, without
approving. While it waits, ask for bank 1's balance again (step 6).

You should see the balance finish (after its own sign-in code) while the transfer still waits.
Then approve or reject the transfer.

## 10. Statements

Last month's statement for the same account (put last month in, as `YYYY-MM`):

```sh
curl -s -X POST http://localhost:8000/tasks/download-statements \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","account":"Everyday Checking","months":["2026-09"]}'
```

Or in Swagger UI: [`POST /tasks/download-statements`](http://localhost:8000/docs#/tasks/download_statements).

After its sign-in code, the result lists each month with a `statement` id such as
`st_…_2026-09`. Fetch it:

```sh
curl -s -o statement.pdf http://localhost:8000/statements/<statement> -H "Authorization: Bearer $TOKEN"
open statement.pdf
```

Or in Swagger UI: [`GET /statements/{ref}`](http://localhost:8000/docs#/tasks/get_statement).

You should see the bank's PDF statement for that month.

## 11. Swagger UI

In Swagger UI, open [`GET /banks`](http://localhost:8000/docs#/catalog/list_banks), press
**Try it out**, then **Execute**.

You should see `200` and the four banks, with the tasks each one serves: bank 1 all three, bank 2
Check Balance, banks 3 and 4 none yet.

## 12. Follow a run

In the Console, open **Runs**. You should see each run from this test, newest first, with its
result. Open the transfer: every step the crawler took, screen by screen, each with its masked
screenshot. **Journal** shows the transfer's intent and its single press, and **Verify** says the
chain is intact.

## 13. Memory, and stop

```sh
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep runner
just down
```

The Runner should sit well under its 1.5 GB limit. `just down` stops everything; nothing stays
running.

## If something goes another way

| You see | What it means | What to do |
|---|---|---|
| `401` from the API | the token expired (15 minutes) | `TOKEN=$(just api-token)` |
| a run ends `expired` | nobody answered its code in time; codes last 5 minutes | start the task again and answer sooner |
| a run ends `409` with `escalated` | the crawler met a screen it doesn't know, and stopped rather than guess | the Console Inbox has an **Escalation** with its frames; **Resume** or **Cancel** it |
| a run ends `409` with `guard_tripped`, then that bank answers `404 task_not_available` | a safety check stopped a run and froze the bank | clear it on the Console's **Freezes** page, with a reason |
| `404 task_not_available` | that bank has no crawler for that task yet | banks 3 and 4 are for the factory to learn; see `manual_test.md` |
