# Manual test: a bank redesigns, the crawl breaks, the factory repairs it

This is the demo of the whole idea. A deterministic crawler, which the software factory wrote,
checks balances at bank 3. The bank then ships a redesign: a new page after sign-in, new words,
and the menu moved. The crawler can't cope, the run stops and goes to a person, and the driver is
taken out of service. Then the factory's two agents look at the redesigned bank, reason about
what changed, and write a new deterministic crawler, which you approve with the evidence in front
of you. The same request that failed now succeeds, and no model runs while it does.

Bank 4 works the same way and makes a good second run.

## What each part shows

| Part | You do | You see | What it proves |
|---|---|---|---|
| 1 | `make onboard BANK=sample` | the Scout and Supervisor working through bank 3; a recommendation in the Console | the factory learns a bank it has never seen, from evidence |
| 2 | approve the recommendation | the hazard check, probation, then bank 3 in `GET /banks` | nothing serves customers until a person approves and the bank's own results agree |
| 3 | one curl to check a balance | `200` with the balance | the crawler is plain deterministic code; no model runs |
| 4 | turn on the redesign (one line) | bank 3's new look in the browser | a realistic vendor redesign |
| 5 | the same curl | `409` escalated, `unknown_screen`; the frames show the new page | the old crawler fails safely: it stops and asks, it never guesses |
| 6 | nothing | the driver demoted, a repair case in the Console | a fault takes the driver out of service on its own |
| 7 | `make repair BANK=sample` | the agents on the redesigned bank; a new recommendation citing the new words | the factory reasons from what it sees and writes a new crawler |
| 8 | approve it | hazard check, probation, promoted | the same gate as the first time |
| 9 | the same curl | `200` with the same balance | recovered, and deterministic again |

## Before you start

```sh
make up                                          # everything, banks 3 and 4 and the factory included
make secret-set FILE=factory KEY=ANTHROPIC_API_KEY  # the factory's agents need a real model for this
```

With a key, each factory run spends real money: a few dollars, and never more than the cap of
$25 a run ($150 a week). Without one the factory replays a recorded run, which costs nothing but
isn't reasoning live, so for this demo the key is worth it.

Keep three tabs open: the Console at http://localhost:8080 (Runs, Inbox, Recommendations), bank
3 at http://localhost:8083/online/branch/, and the staff inbox at http://localhost:8089, where the
bank's sign-in codes arrive. The logins are in `secrets/credentials.txt`; ACCESS.md has the rest.

## Part 1: the factory learns bank 3

```sh
make onboard BANK=sample
```

The Scout signs in and clicks its way toward each goal (a balance, the transfer review page, the
statements list); the Supervisor looks at every page it reaches and tells it what to do next. When
the bank sends a sign-in code, the run waits in the Console inbox: type the code from the staff
inbox. Watch the run in the Console under Runs; its Frames button shows every page the Scout saw.

When it's done, the Supervisor's draft profile shows up under Recommendations: the bank's words
for each thing, its screens and its refusals. Each claim has a Frames button for the pages it came
from, and is marked **seen** (it's on those pages) or **guess**.

## Part 2: approve it

Open the recommendation, check a few claims against their frames, and tick any guess you accept
(a guess can't be approved without its tick). Approve, with a reason.

The factory then runs the new profile against bank 3 with each hazard forced in turn, and every
result has to match what the bank actually does. Two clean runs on probation promote it. When
bank 3 shows up here, it's live:

```sh
curl -s http://localhost:8000/banks
```

## Part 3: a crawl that works

```sh
TOKEN=$(make -s api-token 2>/dev/null)
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"sample","memberId":"40017732","account":"Everyday Checking"}'
```

Answer the sign-in code in the Console inbox if it asks, then read the run with
`curl -s http://localhost:8000/tasks/<runId> -H "Authorization: Bearer $TOKEN"`. You get `200`
and the balance. Nothing in this run called a model: the factory's work became code.

## Part 4: the redesign

Open `infra/compose/compose.yaml`, find the `bank-sample` service, and add one line to its
`environment`:

```yaml
      BANK_REDESIGN: '1'
```

Then restart bank 3:

```sh
make bank-more
```

Look at bank 3 in the browser. After sign-in there's a new "We've refreshed Online Banking" page
with a Continue button, the menu has moved, and the words changed ("Member Search" is now "Find a
Member", and so on). The money, the members and the rules are all the same; only the look and the
words are new.

## Part 5: the crawl breaks, safely

Run the same balance curl as in Part 3. This time the run ends as `409`, escalated, with
`unknown_screen`. In the Console, the run's frames show where it stopped: on the new page it had
never seen. It didn't click around hoping for the best, and it didn't return a wrong answer.

## Part 6: the driver comes out of service

That fault demotes bank 3's driver on its own, and a repair case opens in the Console. Asking for
another balance at bank 3 now gets a plain answer that the task isn't available, before any
browser opens.

## Part 7: the factory repairs it

```sh
make repair BANK=sample
```

The same two agents go back to bank 3, starting from what they already know about it. The Scout
meets the new page and the moved menu; the Supervisor works out what changed from the frames and
steers it through. Answer the sign-in code when the inbox asks.

The new recommendation keeps everything that still holds and changes what doesn't: the
interstitial and its Continue button, the new words, the menu's new place. Every changed claim
cites the frames that show it.

## Part 8: approve the repair

Same as Part 2: check the changed claims against their frames, tick any guess you accept, approve.
The hazard check runs again against the redesigned bank, then probation, then promotion.

## Part 9: the crawl recovers

Run the Part 3 curl one more time. `200`, the same balance, through the new page and the new
menu, and again no model in the run.

## Bank 4

Do it again with bank 4: `make onboard BANK=placeholder`, then add `BANK_REDESIGN: '1'` under
`bank-placeholder` in compose, `make bank-more`, and `make repair BANK=placeholder`. Bank 4 signs
in with an authenticator code (the staff inbox shows it), and its pages are drawn differently from
bank 3's, so the factory has a different redesign to work out.

## Putting it back

Remove the `BANK_REDESIGN` line and run `make bank-more`. The redesigned driver now fails the old
look in the same safe way, which is a quick second demo of Part 5.

## If something goes wrong

| What | Where to look |
|---|---|
| a run is waiting | the Console inbox: a sign-in code or an approval |
| a run failed | the Console's Runs page, the run's Frames button |
| the factory stopped | its run in the Console; the reason is the last step |
| spending | each factory run stops at $25; the factory's Model calls table in the Console shows the cost |
| a service is down | `make ps`; the health checks in ACCESS.md |
