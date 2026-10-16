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
just up                                      # everything, the factory included
just secret-set factory OPENROUTER_API_KEY   # the factory's agents need a real model for this
just factory                                 # restarts the factory with the key
```

With a key, each factory run costs real money: a few dollars, never more than the cap of $25 a
run ($150 a week). Without one, the factory replays scripted model turns for a repair of bank 1,
for free. But a replay only works while the bank shows the same pages the script expects, and the
stack's ambient hazards (a promotion, a slow page) keep changing them. Use the key.

Run `just open` for three tabs: Swagger UI at http://localhost:8000/docs, the Console at
http://localhost:8080 (it lands on the Dashboard; Runs, Inbox and Recommendations are in its bar,
and Data, Drivers shows each driver's state and its repair cases), and the staff inbox at
http://localhost:8089, where the bank's sign-in codes arrive. Add a fourth for bank 1 at
http://localhost:8081/corelink/. The logins are in `secrets/credentials.txt`. ACCESS.md has the
rest.

## Part 1: a crawl that works

```sh
TOKEN=$(just api-token 2>/dev/null)
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"generic","memberId":"40017732","account":"Everyday Checking"}'
```

Or in Swagger UI: [`POST /tasks/check-balance`](http://localhost:8000/docs#/tasks/check_balance). Press **Authorize** first and enter the client id and secret from `secrets/credentials.txt`.

When it asks, answer the sign-in code in the Console inbox; the code is in the staff inbox. Then
read the run with `curl -s http://localhost:8000/tasks/<runId> -H "Authorization: Bearer $TOKEN"`,
or in Swagger UI with [`GET /tasks/{runId}`](http://localhost:8000/docs#/tasks/get_task).
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

Or in Swagger UI: [`GET /banks`](http://localhost:8000/docs#/catalog/list_banks).

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

Here the factory meets a bank it has never seen and writes its crawler. Use bank 3, Sample
Savings Bank (`sample`): nothing has ever crawled it. The Scout and the Supervisor work toward all
three tasks; what the bank gets, once a person approves and the bank's own results agree, is Check
Balance. Start with the stack up (`just up`) and a token (`TOKEN=$(just api-token)`).

### 1. Give the factory a model key

Copy your OpenRouter key to the clipboard, then:

```sh
just secret-set factory OPENROUTER_API_KEY
```

You should see `✓ OPENROUTER_API_KEY set in …`, with the clipboard cleared. An Anthropic key works
the same way, as `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`). A run stops before it spends $25, and
all runs together before $150
in a week. The Console's **Model calls** table shows what each call cost.

With no key, use bank 2 instead: `just onboard example` replays a recorded onboarding of bank 2,
for free. Every step below is the same, with `example` in place of `sample`, except that bank 2
already serves Check Balance from a hand-written profile; the factory's version takes over once
it is promoted.

### 2. Check that bank 3 has no crawler

```sh
curl -s http://localhost:8000/banks -H "Authorization: Bearer $TOKEN"
```

Or in Swagger UI: [`GET /banks`](http://localhost:8000/docs#/catalog/list_banks).

You should see `sample` with an empty `tasks` list.

### 3. Start the onboarding

```sh
just onboard sample
```

Leave this terminal open. It restarts the factory with your key, runs the whole flow, and waits
for you twice. It begins:

```text
factory run build-sample-1a2b3c4d: build at sample
goal: check-balance
```

### 4. Answer each sign-in code

The Scout signs in to bank 3 as a member of staff would, and the bank sends a code. The code is in
the staff inbox (http://localhost:8089) under **Sample Savings Bank**. Enter it in the Console
Inbox, on the factory's **Staff code** task, as in the end-to-end test. A code left for 15
minutes ends the run.

### 5. Watch the three goals

The Scout works toward a balance, then the statements list, then a transfer's review page; it
never presses submit. The Supervisor reads every page the Scout reaches and tells it what to do
next. For each goal the terminal prints a line as it starts and one as it ends:

```text
goal: download-statements
  ended: …
```

### 6. Review the recommendation

When the goals are done, the terminal prints:

```text
lessons: … recorded, … relied on, … contradicted
recommendation rec_…: … claims, awaiting a person
Approve or reject rec_… in the Console: http://localhost:8080/recommendations
```

Open **Recommendations** in the Console. The card lists each thing the Supervisor claims about
bank 3: its words for each control, its screens and its refusals. Each claim is **seen** (it is
on the frames it cites) or a **guess**.

1. Press **Frames** beside a few claims and check them against the pictures.
2. Tick **I accept this guess** beside each guess you accept. An unticked guess blocks approval.
3. Type a reason of at least ten characters and press **Approve**.

### 7. Watch the gate

The terminal moves on the moment you approve. The profile becomes version 1 of bank 3's crawler
and runs the hazard check: a run with nothing forced, then one run for each of the 18 hazards,
each judged by the outcome table and by the bank's own ledger. The check reads sign-in codes from
the bank itself, so nothing waits for you. Probation follows: runs until two in a row are clean.

```text
v1: the hazard check
v1: a probation run: succeeded
v1: a probation run: succeeded
v1: promoted; it serves check-balance at sample
  memory told
version dv_… is promoted
```

### 8. Use it

Ask for the bank list again ([`GET /banks`](http://localhost:8000/docs#/catalog/list_banks) in
Swagger UI). `sample` now lists `check-balance`. Then a balance on bank 3:

```sh
curl -s -X POST http://localhost:8000/tasks/check-balance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bank":"sample","memberId":"40017732","account":"Everyday Checking"}'
```

Or in Swagger UI: [`POST /tasks/check-balance`](http://localhost:8000/docs#/tasks/check_balance).

Answer its sign-in code as usual. The run ends `succeeded`, and no model ran: the crawler is the
profile the factory wrote and you approved.

### Bank 4

Bank 4 (`placeholder`) onboards the same way up to the gate. Its staff read sign-in codes from an
authenticator app (the panel in the staff inbox), while the hazard check reads the codes a bank
sends. So its run with nothing forced fails, and bank 4's version stays a candidate.

### If onboarding goes another way

| You see | What it means | What to do |
|---|---|---|
| `no recording for run build-sample-…` | no model key, and bank 3 has no recording | set a key (step 1), or onboard `example` for free |
| `the run has spent … of $24.00` or `the week has spent … of $150.00` | a spending cap stopped the run ($1 of each run is kept for its lessons) | nothing more is spent; start again once the week allows |
| `Not approved: nothing changes.` | you pressed **Reject** | `just onboard sample` starts a fresh run |
| `failed: control`, or `failed:` and hazard names | the profile gave another result than the outcome table | the version stays a candidate and nothing serves bank 3; the hazard lab shows what that hazard does |
| `version dv_… is candidate` after the probation runs | four probation runs without two clean in a row | the version goes back to candidate; `just gate rec_…` runs the gate again |
| you closed the terminal before approving | the run's recommendation still waits in the Console | approve it, then `just gate rec_…` runs the gate |

## If something goes wrong

| What | Where to look |
|---|---|
| a run is waiting | the Console inbox: a sign-in code or an approval |
| a run failed | the Console's Runs page, the run's Frames button |
| the factory stopped | the `just repair` terminal; its run in the Console, where the last step says why |
| the gate failed | the terminal names each hazard that gave another result; the version stays a candidate |
| spending | each factory run stops at $25; the Console's Model calls table shows the cost |
| a service is down | `just ps`; the health checks in ACCESS.md |
