# Manual test: a bank redesigns, the crawl breaks, the factory repairs it

This demo shows the whole idea. A deterministic crawler checks balances at Generic Bank (bank 1).
Then the bank ships a redesign: a new page after sign-in, new words, a menu in a new place. The
crawler can't cope, so the run stops and goes to a person, and the driver comes out of service.
The factory's two agents look at the redesigned bank, work out what changed, and write the
crawler a new profile. You approve it with the evidence in front of you, and the request that
failed works again. No model runs while it does.

Onboarding a bank the factory has never seen (banks 3 and 4) is a separate section at the end.

## What each part shows

| Part | You do | You see | What it proves |
|---|---|---|---|
| 1 | one curl to check a balance | `200` with the balance | the crawler is plain deterministic code; no model runs |
| 2 | turn on the redesign (one line) | bank 1's new look in the browser | a realistic vendor redesign |
| 3 | the same curl | `409` escalated, `unknown_screen`; the frames show the new page | the old crawler fails safely: it stops and asks, it never guesses |
| 4 | nothing | the driver demoted, a repair case in the Console | a fault takes the driver out of service on its own |
| 5 | `just repair generic` | the agents on the redesigned bank; a recommendation citing the new words | the factory reasons from what it sees and writes the new profile |
| 6 | approve it | the hazard check, probation, then promotion | nothing serves customers until a person approves and the bank's own results agree |
| 7 | the same curl | `200` with the same balance | recovered, and deterministic again |

## Before you start

```sh
just up                                     # everything, the factory included
just secret-set factory ANTHROPIC_API_KEY   # the factory's agents need a real model for this
just factory                                # restarts the factory with the key
```

With a key, each factory run costs real money: a few dollars, never more than the cap of $25 a
run ($150 a week). Without one, the factory replays a recorded repair of bank 1 for free. But a
replay only works while the bank shows exactly the pages it showed when it was recorded, and the
stack's ambient hazards (a promotion, a slow page) keep changing them. Use the key.

Keep three tabs open: the Console at http://localhost:8080 (Runs, Inbox, Recommendations, and
Drivers for the driver's state and its repair cases), bank 1 at http://localhost:8081/corelink/,
and the staff inbox at http://localhost:8089, where the bank's sign-in codes arrive. The logins
are in `secrets/credentials.txt`. ACCESS.md has the rest.

## Part 1: a crawl that works

```sh
TOKEN=$(just api-token 2>/dev/null)
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","account":"Everyday Checking"}'
```

When it asks, answer the sign-in code in the Console inbox; the code is in the staff inbox. Then
read the run with `curl -s http://localhost:8000/tasks/<runId> -H "Authorization: Bearer $TOKEN"`.
You get `200` and the balance. No model ran: the driver is code, and the run's `driverVersionId`
in the Console names the version that served it.

## Part 2: the redesign

Open `infra/compose/compose.yaml`, find the `bank-generic` service, and uncomment the one line
waiting under its `environment`:

```yaml
      BANK_REDESIGN: '1'
```

Then restart the banks:

```sh
just bank
```

Look at bank 1 in the browser. After sign-in there's a page it never had, "We've refreshed Online
Banking", with a "Continue to Online Banking" button. The navigation now lives in a "Menu ▾" at
the top right, the branch notices sit on the left, and the words changed:

| Before | After |
|---|---|
| Member Search | Member Lookup |
| Transfer Funds | Move Money |
| Statements | Documents |
| Activity | History |

The money, the members and the rules are all the same. Only the look and the words are new.

## Part 3: the crawl breaks, safely

Run the same balance curl as in Part 1. This time the run ends as `409`, escalated, with
`unknown_screen`. In the Console, the run's frames show where it stopped: on the new page it had
never seen. It didn't click around hoping for the best, and it didn't return a wrong answer.

## Part 4: the driver comes out of service

That fault demotes bank 1's driver automatically. Under Drivers in the Console, the
check-balance driver is `demoted`, a registry event says which run did it, and an open repair
case names that run and the driver version behind it. There's no earlier version to fall back
to, so another balance request at bank 1 is refused (`task_not_available`) before any browser
opens.

## Part 5: the factory repairs it

```sh
just repair generic
```

The factory's two agents go back to bank 1. They start from its old profile and the frames where
the failing run stopped. The Scout runs into the new page and the moved menu; the Supervisor
reads the frames, works out what changed, and steers it through. Answer the sign-in code in the
Console inbox when it asks.

The recommendation shows up under Recommendations in the Console, and it touches only what
changed: the notice and its Continue button, the menu, the new name for member search and for
the tile's history link, and the words of the new home page. Everything else stays as it was,
and every claim cites the frames that show it.

## Part 6: approve the repair

Check the claims against their frames, tick any guess you accept (a guess can't be approved
without its tick), and approve with a reason.

`just repair` has been waiting in its terminal all this time. Once you approve, it runs the gate:
the new profile goes up against bank 1 with each hazard forced in turn, and every result has to
match what the bank really does. Then two clean probation runs promote it. The terminal shows each
step, the repair case closes, and bank 1's check-balance is back in `GET /banks`:

```sh
curl -s http://localhost:8000/banks -H "Authorization: Bearer $TOKEN"
```

If you approve after the command has ended, `just gate <recommendation id>` runs the gate on
its own.

## Part 7: the crawl recovers

Run the Part 1 curl one more time. `200`, the same balance, through the new page and the new
menu, and again no model in the run. Its `driverVersionId` is the repaired version.

## Putting it back

Comment the `BANK_REDESIGN` line out again and run `just bank`. The repaired driver now fails on
the old look, just as safely, and comes out of service. That makes a quick second demo of Parts 3
and 4. `just repair generic` repairs it back.

## Onboarding a new bank

This only works when the driver can handle the bank. The CoreLink driver can't read a balance at
bank 3 (`sample`) or bank 4 (`placeholder`), so their hazard check fails at the control run.

```sh
just onboard sample
```

The Scout signs in and works toward each of the three goals (a balance, the transfer's review
page, the statements list), and the Supervisor looks at every page it reaches and tells it what to
do next. Answer each sign-in code in the Console inbox. When it's done, the Supervisor's draft
profile shows up under Recommendations: the bank's words for each thing, its screens and its
refusals, each claim marked **seen** (it's on the frames it cites) or **guess**. Approve it as in
Part 6, and the same gate runs. Anything the claims can't cover (how an account is worded, how
codes arrive) comes from the bank's base profile in `packages/drivers`.

Bank 4 is harder still. It signs in with an authenticator code, but the gate reads sign-in codes
from the messages the bank sent, so its hazard check needs the authenticator as well.

## If something goes wrong

| What | Where to look |
|---|---|
| a run is waiting | the Console inbox: a sign-in code or an approval |
| a run failed | the Console's Runs page, the run's Frames button |
| the factory stopped | the `just repair` terminal; its run in the Console, where the last step says why |
| the gate failed | the terminal names each hazard that gave another result; the version stays a candidate |
| spending | each factory run stops at $25; the Console's Model calls table shows the cost |
| a service is down | `just ps`; the health checks in ACCESS.md |
