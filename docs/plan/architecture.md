# Generic Bank Architecture

> **The boxes named here:** box A runs the application (Task API, Console, workflows, the
> Runner); box B holds every durable thing (Postgres, Vault, object storage, Memory); box D
> is the software factory, created for a factory session and destroyed after. The four banks
> are not ours: they stand in for the outside world.

---

## Overview

This system lets an AI agent get work done inside a legacy bank application that has no API.

The agent calls a typed task: check a balance, prepare a transfer, fetch statements. The
system carries it out by operating the bank's website the way a person would, then returns a
typed result. When it can't go on safely, it parks the work for a person, along with the
evidence that person needs.

**The boundary is the whole design: models build, runs stay deterministic, and people move
money.**

No model runs inside a production task. A production task is reviewed TypeScript running a
driver a person approved. The reasoning happens earlier, in the software factory, where a
mistake costs a red evaluation and not a member's money.

And no automation, deterministic or not, may press a money-moving control without a
single-use grant. A person issues that grant for exactly that transfer.

Three structural choices follow from that:

- **The UI is read from what is drawn.** The Runner builds a screen model from the browser's
  own layout, the accessibility tree, and fingerprints of the images the factory has named.
  Drivers ask for "the field
  labeled Amount" and "the button named Submit transfer". They never ask for a selector.
  That's what makes a deliberately hostile legacy UI drivable at all. It's also what lets the
  same drivers work on desktop or terminal surfaces later.
- **One vendor, many tenants.** A driver is written once per vendor product, and each tenant
  is just a profile. To onboard a new tenant of a known vendor, the factory writes a profile.
  As evidence accumulates, Memory widens what it learns from one tenant to the whole vendor
  family.
- **Small on purpose.** One Postgres, a workflow library instead of a workflow server,
  AdminJS instead of a hand-built console. The whole stack fits on an 8 GB laptop.

### The failure mode this architecture is built against

> **A wrong click costs money. A stopped run costs a minute.**

Every automation that drives a UI eventually meets a screen it didn't expect. A system that
guesses will one day guess on a money page.

So when in doubt, the system stops. An unrecognized screen escalates. An unclear submit is
checked against the bank's own history and never pressed twice. A frame that can't be proven
clean of personal data is withheld, not stored.

---

## System Architecture

![Generic Bank: the shape in one picture](diagrams/system.svg)

The same system in text, for diffs and terminals:

```text
      AI agent          approver / operator
         │ typed task         │ browser
         ▼                    ▼
 ┌─ BOX A · app ──────────────────────────────────────────────────────────────────────────┐
 │  control                                       runner                                  │
 │  ┌────────────────────────────────────┐        ┌────────────────────────────────────┐  │
 │  │ Task API ─▶ workflows (DBOS)       ├─start─▶│ screen model · drivers             │  │
 │  │ AdminJS Console                    │        │ guardrails · evidence              │  │
 │  │   approval inbox                   │◀─parked┤ one headless Chromium              │  │
 │  │   hazard lab                       │        │   per task                         │  │
 │  └───────────────┬────────────────────┘        └───────┬─────────────────────┬──────┘  │
 │                  │                                     │                     │         │
 └──────────────────┼─────────────────────────────────────┼─────────────────────┼─────────┘
                    │ Prisma                              │ masked writes       │ clicks and
                    ▼                                     │                     │ keys only
 ┌─ BOX B · data ─────────────────────────────────────┐   │                     │
 │ Postgres + pgvector   Vault         MinIO          │   │                     │
 │ control · memory ·    member        masked frames, │   │                     │
 │ workflow state        credentials   screen models, ┤◀──┘                     │
 │                       (typed, never run folders    │                         │
 │ Memory service         returned)                   │                         │
 │                                                    │                         │
 └──────────────────────────────────▲─────────────▲───┘                         │
                      pack, lessons │             │ run folders                 │
                                    │             │                             │
 ┌─ BOX D · factory (disposable) ───┴─────────────┴───────────┐                 │
 │ factory agent: Operator + Supervisor, model gateway        │                 │
 │ operator browser ──────────────────────────────────────────┼─────────┐       │
 │ ┌─ sandbox · no route out ───────────────────────────────┐ │         │       │
 │ │ eval runner (E0 to E3) ─▶ throwaway bank,              │ │         │       │
 │ │                            forced hazards only         │ │         │       │
 │ │ candidate code runs nowhere else until approved        │ │         ▼       ▼
 │ │                                                        │ │ ┌─ THE WORLD ──────────────────┐
 │ └────────────────────────────────────────────────────────┘ │ │ Generic Bank          :8081  │
 └────────────────────────────────────────────────────────────┘ │ Example Credit Union  :8082  │
                                                                │ bank-db (own Postgres)       │
                                                                │ fake inbox :8089 (people)    │
                                                                └──────────────────────────────┘
```

Why split the boxes this way? Box A holds no durable data, so it can be rebuilt at any time.
Box B holds everything and reaches nothing. Box D runs model-written code and live model
calls, so it's created for a session and destroyed after, and its sandbox has no network
route out at all.

People and tests can reach the fake inbox. The Runner and the factory can't, so a one-time
code is always a human step.

### Who may reach whom

```text
 network     members                                         may reach
 ─────────   ─────────────────────────────────────────────   ─────────────────────────────
 edge        Console/API :8080, banks :8081-2, inbox :8089   published to the host
 app         control, runner                                 box B (Postgres, Vault, MinIO)
 data        Postgres, Vault, MinIO, memory                  nothing outbound
 world       bank-generic, bank-example, bank-db             (reached by runner, operator)
 factory     factory, operator-browser                       control API, memory, MinIO,
                                                             world, the model API
 sandbox     eval runner, bank-sandbox, sandbox-db           nothing (internal: true)
```

---

## Generic Bank (the target)

### Responsibilities

Generic Bank plays the part of a legacy **staff console**: **CoreLink Branch Console**, from
the fictional Acme Core Systems. Member-services employees use it to look up a member and act
for them.

It is deployed as four banks on slightly different URLs. **Generic Bank** (CoreLink 4.2) and
**Example Credit Union** (CoreLink 4.3) are driven in the submission. **Sample Savings Bank**
(a customized 4.3) and **Placeholder Federal Credit Union** (CoreLink 4.4) are kept for the
factory to crawl later.

Our system acts as an employee, through one staff service account per bank. It never acts as
a member.

The bank owns a real double-entry ledger, operators with roles and one-time codes, members
and their accounts, and statements generated from the ledger. It also has a hazard engine
that produces the same runtime trouble real enterprise apps produce.

### Interfaces

```text
  base URL                  blank "Loading…" shell; script moves on after a delay
  └─▶ staff sign-in         ─▶ wrong password · operator locked · rate-limited
      │                        (a trusted workstation gets a "Welcome back" layout)
      └─▶ staff code        text or email, to the operator's fake phone or inbox
          └─▶ /auth/callback        blank and held: mid-sign-in, not signed in
              └─▶ console frameset  banner · nav · main
                  └─▶ Member Search ─▶ no member found · record in use · member closed
                      └─▶ Member summary "Member 40017732 · A. Sample" (tiles re-render)
                          ├─▶ Activity      rows arrive late
                          ├─▶ Statements ─▶ "Statement" ─▶ new window ─▶ PDF by GET
                          └─▶ Transfer   ─▶ Review ─▶ (over threshold: supervisor approval)
                                                   ─▶ Posted, confirmation number
```

| Bank | URL | Labels | Layout | Account wording | Supervisor over |
|---|---|---|---|---|---|
| Generic Bank (4.2) | `localhost:8081/corelink/` | Operator ID, Member Search, Transfer Funds, Submit transfer | nav frame on the left; styled like 2003: bevelled grey buttons, tiny Verdana, a marquee | "Account ending in 7890" | $2,500 |
| Example Credit Union (4.3) | `localhost:8082/` | Username, Find Member, Move Money, Confirm (an image) | tab frame across the top, from another origin | "Share ****3456-S01" | $1,000 |
| Sample Savings Bank (4.3, customized; later) | `localhost:8083/online/branch/` | Staff number, Member Inquiry, Internal Transfer, Post | as bank 2, plus a notices frame; section headings drawn as images | "Acct 1234-5678-90" | $500 |
| Placeholder FCU (4.4; later) | `127.0.0.1:8084/cu/ib/` | User, Search (popup results), Authorize | menu bar, no frameset; sign-in in a cross-origin iframe; transfer split over two pages | "··· 7890 (Checking)" | $2,000 |

### Config and State

- **Tenant config** decides everything that differs: labels, theme, layout variant, account
  format, thresholds, code delivery, and each page's **markup dialect** (how a button, a
  label or a field is spelled in HTML on that page).
- **Markup is stable per build** (seeded), just as enterprise UIs are. `BANK_UI_VERSION`
  simulates a slow vendor upgrade for the repair loop.
- **Data** lives in the bank's own Postgres (`bank_generic`, `bank_example`), seeded from a
  fixed seed. That gives about six members per tenant, covering every business case, with
  twelve months of history. Statements are generated from the ledger on request with
  pdf-lib, then cached.

### Error Handling

The hazard engine runs in two modes:

```text
  request ──▶ forced?  (HAZARDS_FORCEABLE=true  AND  valid HMAC on X-Hazards)
                 │ yes ─▶ exactly the named hazards, nothing random
                 │ no  ─▶ ambient draw from HAZARD_SEED:
                 │          latency 250 ms to 1.8 s on every response
                 │          script errors: harmless 10% · widget 5% · fatal 2%
                 │          503 3% · confirm dialog 10% · promo 10% · early expiry 2%
                 ▼
          every draw written to hazard_events  (ground truth for tests; never shown)
```

Some hazards only happen when forced: swallowed submit, swallowed click, late rows, injected
instruction, unknown screen, and on-demand permission, not-found and validation errors.

Every test uses the same oracle: a state-change counter and the ledger, read through a
test-only admin port.

---

## Task API and the workflow engine

### Responsibilities

The Task API accepts typed tasks, starts one durable workflow per task, holds idempotency,
and answers with exactly one typed result. The caller never sees the UI, a selector, a
screenshot or raw page text.

### Interfaces (API)

| Endpoint | Purpose |
|---|---|
| `GET /tasks` | the catalog: task names and input schemas |
| `POST /tasks/check-balance` | tenant, member reference, account |
| `POST /tasks/transfer` | tenant, member reference, from, to, amount in cents, memo, idempotency key |
| `POST /tasks/download-statements` | tenant, member reference, account, months |
| `GET /tasks/:id?wait=30` | long-poll for the result |
| `POST /human-tasks/:id/{answer,approve,reject,take-over,cancel}` | every Console action, as an API |

A task run's life:

```text
  POST ─▶ run row; workflow id = idempotency key
            │
            ▼
   ┌─ prepare ────────────────────────────────┐    recoverable, bounded, recorded:
   │ sign in · code? · find accounts · read   │◀── dismiss a dialog · sign in again once ·
   └──────┬──────────────────────┬────────────┘    retry 503, slow or fatal-script (reads)
          │ needs a person       │ business outcome
          ▼                      ▼
   park: recv(answer, deadline)  settle ─▶ business_outcome
          │ answered             │ deadline passed ─▶ expired
          ▼
   ┌─ act ─────────┐   ┌─ verify ──────┐
   │ the one step  │──▶│ next screen,  │──▶ settle ─▶ succeeded | escalated | failed
   │ that matters  │   │ history       │
   └───────────────┘   └───────────────┘
```

### The result

```text
  succeeded ─────────── done and verified
  business_outcome ──── no_such_member · no_such_account · insufficient_funds ·
                        permission_denied · limit_exceeded · invalid_amount ·
                        access_locked · approval_rejected
  needs_human ───────── awaiting_code · awaiting_approval · awaiting_step_up_code
  handed_off ────────── a person took over
  escalated ─────────── unknown_screen · stuck · ambiguous_outcome · guard_tripped
  failed ────────────── app_error · unavailable · bad_credentials · step_timeout · no_driver
                        (each with retryable true or false)
  expired · cancelled
```

### Config and State

We use **DBOS** as the task runner. Each task runs as a workflow, and its state is kept in
Postgres.

Workflow code calls a small interface of our own rather than DBOS directly, and every side
effect happens in a step.

A few details:

- When a task waits for a person, the workflow waits for a message with a deadline.
- Long waits (days for a review, weeks for probation) are durable timers.
- The workflow id is the task's idempotency key, so calling the same task twice returns the
  same run.

### Error Handling

- **Bad input** is refused by the schema with the field that failed (HTTP 400). Nothing starts.
- **No promoted driver** for the bank and task is refused before a browser opens
  (`failed: no_driver`).
- **A repeated idempotency key** returns the existing run, never a second one.
- **Postgres down** means HTTP 503 on new calls. Running workflows pause and pick up where
  they stopped.
- **Messages to the caller are ours**, fixed per code. If a message carries a selector, a
  stack trace, an internal host or a query string, a filter swaps it for one of three canned
  sentences and logs the original.

Every other failure, and what the caller sees for it, is in
[How failures are handled](#how-failures-are-handled).

---

## The Runner

### Responsibilities

The Runner executes one task at a time in one headless Chromium. It works through a promoted
driver, under the guardrails, and writes the trail as it goes. It's the only component that
touches a bank in production.

### The screen model

The bank's pages are shells until their own JavaScript draws them. So the reader has to be a
real Chromium that executes every script the bank sends.

The Runner reads the drawn result from outside the page. It never injects script of its own.
A cross-origin frame is read through its own DevTools session. And when the layout can't be
read on a page that is visibly drawn, the Runner finds targets on the screenshot instead.

```text
  after every action, wait until FULLY RENDERED:
      load event in every frame
      two screenshots 700 ms apart identical, layout key unchanged
      no aria-busy, spinner, skeleton, "Loading…", or disabled form
                          │
                          ▼
  ┌─ capture: from outside the page, no script injected ─────────────────────┐
  │ DOMSnapshot (every frame)    accessibility tree    screenshot            │
  └──────────────────────────────────────────────────────────────────────────┘
                │                                                   │
                ▼                                                   ▼
   flatten frames into page coordinates          match images against the
   drop hidden, zero-size, off-screen and         bank's learned fingerprints
   covered nodes (hit-test at each center)                 │
                │                                          │
                └────────────────────┬─────────────────────┘
                                     ▼
   SCREEN MODEL   controls c1..cn: role · name · box · state (never a value)
                  text runs with boxes
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          ▼                          ▼                          ▼
     RECOGNIZE                    TARGET                     MASK
     score every screen           field("Amount") by         boxes for every input
     signature; exactly one       label geometry;            and sensitive text run;
     must match, or escalate      button("Submit             cover white + ****,
                                  transfer") by name         or withhold the frame
```

### Interfaces

Drivers are state machines over named screens, written against a small SDK:

| SDK call | What it does |
|---|---|
| `expect(...screens)` | recognize the current screen; anything else is an outcome, a recovery or an escalation |
| `field(label)`, `button(name)`, `tile(text, id)`, `rowWhere(col, value)` | target by meaning; exactly one match or an error |
| `click(target)`, `type(target, text)`, `typeSecret(target, field)`, `press(key)` | act with the real mouse and keyboard; re-check the target just before acting |
| `read(target)` | read a value from the screen for the result (masked everywhere else) |

### Config and State

A **driver** is per vendor (`packages/drivers/corelink`). A **profile** is per tenant:
labels, synonyms, signature overrides, account format, thresholds. The catalog maps tenant
and task to the promoted driver version.

Step limits are 2 minutes for sign-in, 45 seconds for a page and 60 seconds for a document.
The stall watchdog fires after 3 minutes with no step and no navigation.

### Error Handling

```text
  screen after an action
     ├─ expected ─────────────────────────────▶ continue
     ├─ known recoverable (dialog, expiry, 503) ▶ recover (bounded) ─▶ continue or fail
     ├─ business outcome screen ──────────────▶ business_outcome
     ├─ bank error page, retries used ────────▶ failed (retryable)
     └─ unknown, or two matches ──────────────▶ escalated: unknown_screen  + final frame
```

---

## Transfers: approval and the one click

![A transfer: prepared by automation, approved by a person, one click](diagrams/transfer.svg)

### Responsibilities

Money moves only when a person has approved exactly this transfer. An unclear submit can
never become two transfers.

### Interfaces

```text
  RUNNER                         CONSOLE / PERSON                  BANK
  ──────                         ────────────────                  ────
  prepare: sign in, find the
  member, fill form,
  "Continue" ─────────────────────────────────────────────────────▶ review page
  read from, to, amount
  off the screen
  park: awaiting_approval ─────▶ inbox: masked review frame,
  (browser held, 15 min)         values as read, trail
                                 Approve (+ supervisor code if over threshold)
          ◀──────────────────── grant {run, from, to, amount, memo token,
                                       nonce, expires in 5 min}
  guard checks: grant unused and unexpired · screen is the review page ·
                from, to and amount on screen equal the grant
  journal: intent + grant id
  click "Submit transfer" ────────────────────────────────────────▶ commits (maybe silently)
  grant consumed
  confirmation shown? ──yes──▶ read number ─┐
          │ no / unclear                    ▼
          └──────────▶ open activity, find the memo token
                         once  ─▶ succeeded
                         twice ─▶ escalated: ambiguous_outcome (duplicate)
                         none  ─▶ escalated: ambiguous_outcome   (never resubmit)
```

### Config and State

`approval_grant` rows are single-use and bound to values, not to a browser. If the browser is
lost while the run is parked, approval resumes it with a fresh sign-in. The run re-fills the
form, re-reads the review page and checks it against the grant before the click.

### Error Handling

If the grant and the screen disagree (the amount changed, the accounts differ), the click is
refused and the run escalates. We generate the memo token and type it into the bank's memo
field. That makes the bank's own history the idempotency record.

---

## Guardrails

### Responsibilities

Every rule that keeps the system safe lives in `packages/guardrails`, which imports nothing
from the drivers, the Runner or the factory. Every layer is enforced in code. Prompts only
repeat the rules.

```text
                  a click or key press the driver asks for
                                   │
                                   ▼
    ┌──────────────────────────────────────────────────────────────────────┐
    │ 1  task allowlist     is this capability in the task at all?         │
    │ 2  network gate       tenant host only; non-GET only if listed       │
    │ 3  element guard      money and account-change words on the          │
    │                       control's visible name                         │
    │ 4  page guard         money or account page: read and leave          │
    │ 5  approval grant     the only key to the one money click            │
    │ 6  outcome watch      confirmation wording that should not appear    │
    └──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                      allowed ─▶ act      refused ─▶ GUARD TRIP
                                                   run escalated, journal row,
                                                   tenant frozen, notification
```

Around those layers sit a few more protections:

- Credentials are typed from Vault and never returned. Plain typing of anything resembling a
  secret is refused.
- Sign-ins are paced and capped by a ledger that fails closed.
- Injected page text is ignored structurally, because guards judge controls, not
  instructions.
- The factory has model caps and the tool allowlist.
- Compose networks limit reach.

### Error Handling

A guard error always propagates. An E0 lint rule forbids catching it.

The trap matrix test runs every money trap and injected instruction with each layer removed
in turn, and records which layers each trap depends on. For every read task, the bank's
state-change counter must stay at zero.

---

## How failures are handled

Every failure lands in one of four places, and each has one rule.

| Kind | Rule | The caller sees |
|---|---|---|
| **Business outcome** | the bank said no for a reason a member would understand; stop, report it | `business_outcome` with a code |
| **Recoverable condition** | handle it inside the run, bounded, recorded; never let it reach the caller | nothing, unless the bound is used up |
| **Hard failure** | stop cleanly, leave a final frame, say whether a retry could help | `failed` with `retryable` |
| **Escalation** | stop where it is safe, keep the context, hand it to a person | `escalated` or `needs_human` |

Four principles hold throughout:

- **Only reads are retried**, and never more than twice. Anything that could change state is
  never retried; it is checked.
- **Every run that ends badly ends with a picture**: a final masked frame and the trail
  before it.
- **Infrastructure fails closed.** If a guard, a secret store or the spend meter cannot be
  consulted, the action does not happen.
- **The caller gets our words.** Raw page text, stack traces, selectors and internal hosts
  never leave the system.

### Failures in the bank

| Failure | Detected by | The system | The caller sees | Recorded |
|---|---|---|---|---|
| Wrong password | sign-in error screen | stops; never submits again | `failed: bad_credentials`, not retryable | step, frame, sign-in ledger |
| Operator locked or rate limited | lock screen | stops; freezes sign-ins for that bank until a person clears them | `failed: operator_locked`, not retryable | step, frame, freeze |
| Staff code needed | code screen with proof a code was sent | parks; opens a human task | `needs_human: awaiting_staff_code` | human task |
| Code rejected or expired | the bank's own wording | reports it; one attempt per code; asks for a new code only if the bank offers to send one | `needs_human` again, or `failed` after three rounds | human task, step |
| No member found, member closed | lookup result screen | stops | `business_outcome: no_such_member` / `member_closed` | step, frame |
| Record in use by another operator | lookup result screen | retries the read up to twice, then stops | `failed: record_in_use`, retryable | step, recoveries |
| Insufficient funds, permission, restricted, limit, validation | transfer or review screen | stops before anything is submitted | `business_outcome` with the code | step, frame |
| Slow page, late rows | fully-rendered wait | waits up to the step limit | nothing | span timings |
| 503 or fatal script error page | error screen signature | retries a read up to twice with backoff | nothing, or `failed: unavailable`, retryable | recoveries, frames |
| A widget failed to draw | screen model missing a needed control | reloads once | nothing, or `escalated: unknown_screen` | recovery |
| Session expired | sign-in screen inside the frameset | signs in again once, returns to the same screen, re-checks the member | nothing, or `failed` | recovery |
| Confirmation dialog, promo | dialog or interstitial signature | answers with the non-committal choice | nothing | recovery |
| Control moved before the click | re-read just before acting | re-targets, up to twice | nothing, or `escalated` | step |
| Layout cannot be read on a drawn page | empty screen model with a non-empty screenshot | waits and reads once more | nothing, or `escalated` | step, frame |
| Unknown screen, or two matches | recognition | stops where it is | `escalated: unknown_screen` | final frame, screen model |
| Unclear submit result | no confirmation screen | never clicks again; reads history for the memo token | `succeeded`, or `escalated: ambiguous_outcome` | journal intent, history read |
| Grant does not match the screen | guard before the click | refuses the click | `escalated` | journal, guard decision |
| Guard trip | any guard layer | stops; freezes the bank | `escalated: guard_tripped` | journal, freeze, notification |

### Failures in our own system

| Failure | The system | The caller sees |
|---|---|---|
| Worker or browser crash mid-run | the workflow resumes at its last completed step; a lost browser means a fresh sign-in and a return to the same screen. If the crash came between a submit's journaled intent and its result, the run goes straight to the history check and never clicks again | nothing, or `escalated: ambiguous_outcome` |
| Stall (no step, no navigation for 3 minutes) | the watchdog saves a final frame and ends the run | `escalated: stuck` |
| Nobody answers a human task | the deadline ends the run | `expired` |
| Postgres down | the API answers 503; running workflows pause and resume when it returns | HTTP 503 on new calls |
| Vault down | no secret can be typed, so the run stops before sign-in | `failed: unavailable`, retryable |
| MinIO down | frames are held on the runner's disk (at most 60 a run) and uploaded when it returns; if they cannot be kept, they are withheld with the reason | nothing |
| Memory down | runs continue; their episodes wait in an outbox and are sent later. The factory will not start a run without its knowledge pack | nothing for tasks |
| Masking cannot prove a frame clean | the frame is withheld; the run continues | nothing |
| No promoted driver for the bank and task | refused before any browser opens | `failed: no_driver`, not retryable |
| Invalid task input | refused by the schema with the field that failed | HTTP 400 |
| Same idempotency key twice | the existing run is returned | the same run |

### Failures in the factory

| Failure | The factory |
|---|---|
| Model API error or timeout | retries with backoff inside the run's caps; then hands back |
| A cap reached (spend, turns, sign-ins, hours) | stops and hands back; a run can lower a cap, never raise it |
| Spend ledger unreadable, or a model with no known price | refuses the call; fails closed |
| The same failure twice, or three turns without progress | ends the build loop and hands back |
| A tool call outside the role's allowlist | vetoed, recorded, and the model is told why |
| An eval rung could not run | never a pass; the run reports "could not run" |
| Review gate not answered | one reminder at 24 hours; expires at 7 days |
| A regression on probation | reopens the build once; a second regression hands back |

---

## Evidence and redaction

### Responsibilities

Every run leaves a trail from its first step, however it ends. Nothing personal is ever
stored unmasked.

```text
  step ─▶ frame:  screenshot (viewport) ─┐
                  screen model ──────────┼─▶ COVER ─▶ provably clean? ─yes─▶ MinIO + index row
                  host + path, step, at ─┘    │                │
                                              │                └─ no ─▶ WITHHELD (reason only)
                                              └─ white boxes filled with asterisks over every
                                                 input, sensitive text run and unreadable image
  also: steps · hash-chained journal (intent before action) · network events (no bodies,
        no query strings) · run-folder manifest (path, size, sha256, written last)
```

Masking works from two sources. The first is known values: the member's credentials, codes,
name, account numbers and email, all known before the run starts. The second is patterns:
four or more digits, currency amounts, emails, phones, street lines.

The screen model already knows where every piece of text is, so each
input, each matching text run, and each image or canvas the crawler cannot read is covered
with a white box filled with asterisks. A frame whose screen model could not be read, or that
shows a known value outside a covered box, is withheld.

Logs pass through pino's key redaction and then a final scrubbing pass. A run keeps at most
60 frames. A capture failure is logged and never breaks the run.

### Error Handling

The PII suite runs every task on banks 1 and 2. Then it scans every database row, object and
log line those runs produced, looking for every seeded secret and personal value. Any hit
fails the suite.

---

## Observability

Two questions come up every day: **what did the crawler do**, and **what did the agent do**.
Both have the same answer. It is in the database, you see it in the Console, and the logs
and traces say the same thing with the same ids.

### Three signals, one id

```text
  api · console · runner · memory · factory
     │  every row, log line and span carries  runId · traceId · step
     │
     ├──▶ records ──▶ Postgres ──▶ the Console's timelines        source of truth
     │
     ├──▶ JSON logs ──▶ stdout and .data/logs/*.jsonl            make logs
     │
     └──▶ OpenTelemetry spans ──▶ .data/traces/*.jsonl           make trace RUN=…
                                └─▶ OTLP ─▶ Collector ─▶ Tempo (traces) · Loki (logs)
                                                       └─▶ Grafana     make observe
```

Every task run and every factory run gets a `runId`, and that run is one OpenTelemetry trace.
The `runId`, the trace id and the current step travel on every database row, every log line
and every span. So any one of them leads to the other two.

| Signal | Where it lives | What it is for |
|---|---|---|
| **Records** | Postgres, box B | the source of truth: runs, steps, frames, journal, human tasks, model calls, tool calls, evals, registry events |
| **Logs** | JSON lines on each container's stdout, kept in rotating files under `.data/logs/` | what each process was doing, in order, for debugging the system itself |
| **Traces** | OpenTelemetry spans, written to `.data/traces/` by default, or sent to a collector | the shape and timing of a run: where the time went, which step failed, what waited on whom |

### What the crawler did

For a task run, the Console shows (and the records hold):

- every **step**: the screen it recognized, the action it took, the outcome, how long it took
- every **frame**: a masked screenshot and the masked screen model, with the step that took it
- every **recovery**: the dialog dismissed, the re-sign-in, the retry, and which hazard caused it
- every **guard decision**: allowed or refused, by which layer, on which control
- every **network event**: method, host, path, status, duration (no bodies, no query strings)
- the **journal**: intent before each action, result after, hash-chained
- the **human tasks**: who answered, when, and what they saw

The trace for the same run has one span per step, with child spans for the fully-rendered
wait, screen recognition, targeting, the action and each guard check. A slow sign-in shows up
as a long span; a recovery shows up as a retried span with the hazard as an attribute.

### What the agent did

For a factory run, the Console shows (and the records hold):

- every **model call**: role (Operator or Supervisor), model, prompt id and version, input,
  output and cached tokens, cost, and the latency
- every **tool call**: the tool, its arguments (masked), a compact result, and whether the
  veto refused it and why
- every **Supervisor verdict**: continue, wait or stop, with the reason and the frame it judged
- every **eval rung**: passed, failed or could not run, with its JSON
- the **lessons**: served, relied on, contradicted and proposed
- the **spend**: per call, per run and per week, against the caps

The trace has one span per phase (intake, scout, build, evals, live verify, lessons, review,
probation), with model calls and tool calls as child spans. Model-call spans follow the
OpenTelemetry **GenAI semantic conventions** (`gen_ai.request.model`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and the rest), so any tool that
understands those conventions can read them.

### Why not LangSmith

LangSmith is the usual answer for watching agents, and it is good. We do not use it here,
for two reasons. It is a hosted service, and our prompts and frames, even masked, should not
leave the machine by default. And it would be a second, separate record of what the agent
did, when the database already holds the authoritative one.

OpenTelemetry keeps the door open. Because spans use the GenAI conventions and leave over
OTLP, pointing them at LangSmith, Langfuse or Phoenix later is a configuration change, not a
rewrite.

### Locally, and later

**Locally (default).** No extra containers. Logs go to stdout and to rotating JSON files;
traces go to JSON files through a small file exporter. `make logs`, `make <group>-logs` and
`make trace RUN=<runId>` read them. The Console is the main window.

**Locally, when wanted.** `make observe` starts an OpenTelemetry Collector, **Grafana Tempo**
for traces, **Loki** for logs and **Grafana**, about 600 MB together, so it stays off by
default on an 8 GB laptop. The Console then links each run to its trace in Grafana.

**With more time (plan 2).** The same collector, Tempo, Loki and Grafana run always-on, with
dashboards for outcomes by code, recoveries by hazard, driver states and model spend, and
alerts through ntfy.

### Masking applies to telemetry too

Logs and spans go through the same masking as everything else. Span attributes never carry a
value from a field, a credential, a code, an account number, an amount or a name. Frames are
referred to by key, never embedded. A test runs a task under every hazard and scans the log
and trace files for every seeded secret and personal value, exactly as it scans the database.

### Metrics

Counts and rates come from SQL views over the records (shown on the Console's Home, Health and
Cost pages) and, when the collector runs, from OpenTelemetry metrics: task duration, outcomes
by code, recoveries by hazard, guard refusals by layer, human-task wait time, model tokens and
spend by role.

---

## The Console

### Responsibilities

The Console is the operator's window into everything. It's built on **AdminJS** over the
Prisma models.

```text
 ┌─ AdminJS on Fastify ─────────────────────────────────────────────────────────────┐
 │ generated from Prisma                      custom components and pages           │
 │ ─────────────────────                      ───────────────────────────           │
 │ task runs · steps · human tasks            Home dashboard: waiting, stuck,       │
 │ drivers · versions · registry events         frozen, probation, spend            │
 │ factory runs · model calls · eval results  Inbox: approve · reject · take over   │
 │ repair cases · freezes · sign-in ledger    Trail viewer: masked frames,          │
 │ journal · audit (read-only)                  "only the interesting parts"        │
 │                                            State badges                          │
 │ newest first · filters · search ·          Reasoned actions: promote, roll       │
 │ relations · role-based access                back, freeze, unfreeze              │
 │                                            Hazard lab · Cost · Memory pages      │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

### Interfaces

There are three roles: `viewer`, `approver`, `admin`.

Images are served only through an allow-listed proxy, and only for frames that passed
masking. A withheld frame shows its reason instead. URLs appear as host and path only.
Memory pages read the Memory service's API. The Console never opens Memory's tables.

### Config and State

Driver states and their badges:

```text
   draft ──▶ candidate ──▶ probation ──▶ promoted ──▶ retired
   (grey)    (blue)        (amber)       (green)       (outline)
                              │              │
                              │ regression   │ production faults
                              ▼              ▼
                           reopened        demoted (red) ── previous version serves
                           once

   any state ──guard trip──▶ frozen (purple, striped) ──person clears, with reason──▶ back
   any run   ──no activity past its limit──▶ stuck (orange)
```

### Error Handling

- **Two people answer the same human task:** the first answer wins (compare and set); the
  second sees "already answered", with who answered and when.
- **An approval arrives after its deadline:** refused; the run has already ended `expired`.
- **A grant expires before the click:** the Runner refuses to use it and the run asks again.
- **A missing or withheld image** shows a placeholder with the reason, never an error page.
- **A reasoned action without a reason** (promote, roll back, freeze, unfreeze) is refused.

---

## Memory

### Responsibilities

Memory is how the agents remember. Without it, every factory job starts from zero and
rediscovers what the last one learned. With it, the factory learns from each job, from its
successes and its mistakes, and from every crawler it has shipped.

It keeps four kinds of thing:

| Kind | What it is | Trusted when |
|---|---|---|
| **Episode** | what happened: one run, one attempt, its outcome and evidence | always; it is a record, not a claim |
| **Hypothesis** | what an agent believes but has not proven | never served as truth |
| **Fact** | a typed claim proven by a run that succeeded | only after a promoted run (enforced) |
| **Lesson / pattern** | advice for future jobs, with its evidence and scope | once confirmed |

Episodes are episodic memory, facts are semantic memory, and lessons, with the curated rules,
checks, scenarios and approaches, are procedural memory. A lesson's scope is one bank, every
bank on the same product, or everywhere. The last is a pattern: the most valuable kind and the
most dangerous, so only a person can approve one.

![Memory: who reads and writes, through one door](diagrams/memory.svg)

```text
  ┌─ WRITE: signed, screened at the door ──────────────────────────────┐
  │ runner, factory ─▶ episodes: run, attempts, failure signature      │  code only, every run
  │ factory         ─▶ facts: typed triplets built from templates      │  never from page text
  │ supervisor      ─▶ lesson proposals, relied on, contradicted       │  the only model input
  └────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─ RULES: pure functions of stored evidence ─────────────────────────┐
  │ merge     similarity ≥ 0.95 in the same scope: evidence grows      │
  │ confirm   driver promoted ─▶ lessons its probation runs used       │
  │ dispute   one contradiction: still served, with a warning          │
  │ retire    two runs contradict, or one later-promoted run does      │
  │ widen     tenant ─▶ vendor at 2 tenants; vendor ─▶ pattern         │
  │           candidate at 3 vendors (a curator approves)              │
  │ return    a retired lesson a later promoted run relied on          │
  │ demote    driver demoted ─▶ its confirmations back to disputed     │
  └────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─ READ ─────────────────────────────────────────────────────────────┐
  │ knowledge pack, in tiers, within a size budget:                    │
  │ patterns ─▶ vendor ─▶ tenant ─▶ proposed ("verify before           │
  │ relying") ─▶ disputed (with reason), plus recurring failures       │
  │ and the two nearest drivers as examples                            │
  └────────────────────────────────────────────────────────────────────┘
        every write appends one row to a hash-chained change log
```

### Interfaces (API)

| Endpoint | What it does |
|---|---|
| `episodes/runs`, `episodes/attempts` | record a run and its attempts, with any promotion or demotion mark |
| `episodes/search`, `/recent`, `/recurring` | find similar failures, a bank's latest attempts, or a vendor's recurring failures |
| `facts`, `facts/search`, `facts/invalidate` | write a fact at the role's truth level; retrieve served facts; close a fact backed by a failed run |
| `lessons/proposals`, `lessons/relied-on` | propose a lesson (a near-duplicate merges); record which served lessons a run used |
| `lessons/confirm`, `lessons/retire` | confirm or retire a lesson, as a new version |
| `curated`, `curated/approve` | propose a curated version; a person approves it |
| `knowledge/pack` | everything a run starts from |
| `history`, `history/verify` | what changed and when; verify the change log |

Agents ask mid-run questions with one tool, `memory_query`. People read memory in the Console,
which goes through this API, so memory keeps one door.

### Config and State

- **Postgres is the store,** in its own `memory` database that only the Memory service opens.
  Episodes, versions and the change log are written in plain SQL by code, with no model in the
  loop.
- **Facts are bi-temporal rows** (`valid_at`, `invalid_at`, `expired_at`): closed, never
  deleted, so memory can say what was believed at the time of any past run.
- **Search is hybrid:** full-text ranking and pgvector similarity, fused by reciprocal rank,
  with embeddings from a local model.
- **Every writer holds a role token,** and writes are signed with a key only deterministic code
  holds. No agent can promote its own belief into truth.
- **Provenance on every entry** (run, model, prompt versions, evidence hash), **nothing
  overwritten**, and a **privacy screen** on every write.

### How autocrawl turns into knowledge

```text
  scout signs in with a test member, explores read-only
     │ each screen reached: masked frame, screen model, labels, controls, transition
     ▼
  episodes + hypotheses  (screens, labels, controls, transitions)
     │
     ▼
  factory builds a profile ─▶ evals ─▶ review ─▶ probation ─▶ PROMOTED
                                                                 │
     confirmed lessons, widened to the vendor at the second tenant ◀┘
     │
     ▼
  the next CoreLink tenant starts with a pack that already knows the product
```

### Error Handling

| Response | Means |
|---|---|
| `401` | no token, or an unknown one |
| `403 role_forbidden` | a known role, not allowed this write; or an unsigned write |
| `409` | a verified fact with no successful run, an attempt with no run, or an approval that would move a version backward |
| `422` | the privacy screen refused a value |
| `503` | the memory database is down; runs keep going and their episodes wait in an outbox, but the factory will not start without its knowledge pack |

A change log that fails verification puts Memory into read-only mode and notifies, until a
person looks.

---

## The software factory

### Responsibilities

Give the factory a tenant and a task, and it produces a driver version. That version is
proven offline, verified live and reviewed by a person. Then it has to earn promotion on
probation.

In build mode the factory starts from the vendor's driver and the knowledge pack. In repair
mode it starts from a repair case and the failing runs' trails.

The agents run on **pi** ([pi.dev](https://pi.dev)), an open-source agent harness. Each role
is its own pi session; the session file is the checkpoint and the record of what the agent
did. pi reaches the model only through our metering gateway, and pi's tool-call hook asks our
registry before any tool runs, so spend, caps and the tool allowlist stay in our code.

```text
  ┌─ FactoryRun: one durable workflow ─────────────────────────────────────────┐
  │ INTAKE        knowledge pack, caps, the repair case if any                 │
  │   ▼                                                                        │
  │ SCOUT         autocrawl, read-only: every screen, label and transition     │
  │   ▼                                                                        │
  │ BUILD ⇄ OFFLINE EVAL   profile or code; E0 lint, E1 contract,              │
  │                        E2 hazard matrix, E3 replay                         │
  │   ▼                                                                        │
  │ LIVE VERIFY   E4: fresh and remembered sign-in on the real tenant          │
  │   ▼                                                                        │
  │ LESSONS       the Supervisor writes what was learned                       │
  │   ▼                                                                        │
  │ REVIEW        a person approves the candidate in the Console               │
  │   ▼                                                                        │
  │ PROBATION     two clean production runs in 30 days ─▶ PROMOTED             │
  │                                                                            │
  │ stall: the same failure twice, or 3 turns without progress                 │
  │   ─▶ HAND-BACK: what is known, what is not, what would settle it           │
  └────────────────────────────────────────────────────────────────────────────┘

  each Operator browser step:
     Operator ──tool call──▶ veto (role, caps, host, secret) ──▶ operator browser
         ▲                                                              │
         │                                                     masked screenshot
         │                                                              ▼
         └────────── continue | wait | stop ◀─────────────────── Supervisor
                     (an unreadable answer counts as wait)
```

### Interfaces

| Role | Model | Writes | Sees |
|---|---|---|---|
| Operator | `claude-opus-5-5` | the driver bundle and its tests | masked screens, tool results, the knowledge pack |
| Supervisor | `claude-sonnet-5-5` | step verdicts; lessons at the end | the screenshot and the step, never the Operator's reasoning |

The tools are a closed set:

- browser look, click, type, press, scroll and wait, by control reference
- typing a credential, by field name only
- entering a code a person supplied
- reading and writing the bundle
- lint, tests, evals and live verification
- Memory and catalog reads
- recording a lesson
- reading this run's frames

No tool moves money, runs script in a page, makes its own non-GET request, or reaches a host
outside the allowlist. On the transfer task, factory work stops at the review page.

### Config and State

Caps live in one file with no imports: $25 a run, $150 a rolling week, 6 Operator turns, 6
live sign-ins, 4 active hours, 3 failed-check turns, 2 live verifications, and $1 reserved
for lessons. A run's input can lower a cap but never raise it. The spend meter checks before
every model call and fails closed.

Prompts are reviewed files, loaded only through the prompt loader. Mock mode replays
recorded model responses, so you can watch the loop without an API key.

### Error Handling

A failed check goes back to BUILD as a typed failure, with its evidence and the one file the
fix may touch.

Candidate code runs only in the sandbox until a person approves it. Before it runs anywhere,
its sha256 must match and E0 runs again inside the worker. It then loads in its own module
scope, importing only the driver SDK.

A rung that could not run is never a pass.

---

## Evaluations

```text
  rung               proves                                    where
  ────────────────   ───────────────────────────────────────   ──────────────────────
  E0 lint            the code follows the rules                 sandbox (static)
  E1 contract        typed outcomes on recorded screen models   sandbox
  E2 hazard matrix   control run, then each forced hazard       sandbox, throwaway bank
                     alone, each with its expected result
  E3 replay          behavior matches recorded trails           sandbox
  E4 live verify     fresh and remembered sign-in, ambient      the real tenant
                     hazards on
  E5 probation       two clean production runs in 30 days       production
  E6 stability       N runs: success rate, recoveries used,     production-like
                     p50 and p95 duration
```

The eval CLI prints exactly one JSON object and exits 0 (passed), 1 (failed) or 2 (could not
run). If the exit code and the JSON disagree, that's not a pass.

The hazard list for E2 is read from the bank, never kept by hand. Prompts have their own
eval cases, run on demand under their own cap.

---

## Dependencies

| Package | Used for |
|---|---|
| Fastify | every HTTP service |
| AdminJS, `@adminjs/fastify`, `@adminjs/prisma` | the Console |
| Prisma | schema, migrations, client for `control` and `memory` |
| DBOS Transact | durable workflows |
| PostgreSQL 16, pgvector | all durable data and embeddings |
| Our DevTools Protocol client, full Chromium (Debian's package) | the Runner, the Operator browser, the eval runner |
| sharp | masking, image fingerprints, frame comparison |
| zod, ajv | task contracts, config, prompt answer schemas |
| pdf-lib, argon2 | the bank's statements and passwords |
| pi (pi.dev) | the factory's agent harness: one session per role |
| `@anthropic-ai/sdk` | the factory's model gateway |
| `@huggingface/transformers` | in-process embeddings for Memory |
| HashiCorp Vault, MinIO, SOPS with age | secrets and evidence storage |
| pino | logs with redaction |
| vitest, dependency-cruiser, cspell, gitleaks | tests and checks |

---

## Known Limitations

- **The web is the surface this system drives.** Desktop and terminal capture sources plug
  into the same screen-model seam. The next additions are the E6 stability report and a
  bounded assisted fallback at runtime.
- **One browser at a time** by default, to fit in 8 GB. Concurrency is a setting.
- **Banks 3 and 4 have no drivers yet.** They're kept for the factory to crawl after the
  submission.
- **Hazards are ours.** The bank produces the failure modes we chose. Real vendors will find
  others. When a new one shows up, the answer is an escalation, then a scenario, then a
  lesson.
- **Production hardening** (multi-machine deployment, private networking, credential rotation,
  intrusion detection, paging) is in Part 2 of `GENERIC_BANK_PLAN.md`.
