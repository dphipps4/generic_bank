# Generic Bank Architecture

> **The boxes named here:** box A runs the application (Task API, Console, workflows, the
> Runner); box B holds every durable thing (Postgres, Vault, object storage, Memory); box D is
> the software factory, created for a session and destroyed after. The four banks are the
> outside world.

---

## Overview

An AI agent calls a typed task (check a balance, prepare a transfer, fetch statements) on a
legacy bank application with no API. The system operates the bank's website as a person would
and returns a typed result, or, when it can't go on safely, parks the work for a person with
the evidence.

**Models build, runs stay deterministic, and people move money.** A production task is
reviewed TypeScript running an approved driver, with no model inside; models work only in the
software factory. No automation presses a money control without a person's single-use grant
for exactly that transfer. When in doubt, a run stops.

- **The UI is read from what is drawn.** Drivers target "the field labeled Amount", never a
  selector.
- **One vendor, many tenants.** One driver per vendor product; each tenant is a profile.
- **Small.** One Postgres, a workflow library, AdminJS; it fits on an 8 GB laptop.

---

## System Architecture

![Generic Bank: the shape in one picture](diagrams/system.svg)

Box A holds no durable data and can be rebuilt any time. Box B holds everything and reaches
nothing. Box D runs model-written code and live model calls, so it lives one session and its
sandbox has no route out. Only people and tests reach the fake inbox, so a one-time code is
always a human step.

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

A legacy **staff console**, **CoreLink Branch Console** from the fictional Acme Core Systems,
run as the four banks below; the first two have drivers. We sign in as staff, one service
account per bank, never as a member. The bank has a double-entry ledger, operators with roles
and one-time codes, statements built from the ledger, and a hazard engine.

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
| Generic Bank (4.2) | `localhost:8081/corelink/` | Operator ID, Member Search, Transfer Funds, Submit transfer | left nav frame; 2003 styling | "Account ending in 7890" | $2,500 |
| Example Credit Union (4.3) | `localhost:8082/` | Username, Find Member, Move Money, Confirm (an image) | top tab frame from another origin | "Share ****3456-S01" | $1,000 |
| Sample Savings Bank (4.3, customized) | `localhost:8083/online/branch/` | Staff number, Member Inquiry, Internal Transfer, Post | bank 2 plus a notices frame; headings as images | "Acct 1234-5678-90" | $500 |
| Placeholder FCU (4.4) | `127.0.0.1:8084/cu/ib/` | User, Search (popup results), Authorize | menu bar, no frameset; cross-origin sign-in iframe; two-page transfer | "··· 7890 (Checking)" | $2,000 |

### Config and State

- **Tenant config** sets labels, theme, layout, account format, thresholds, code delivery, and
  each page's **markup dialect** (its HTML for a button, label or field).
- **Markup is stable per build** (seeded); `BANK_UI_VERSION` simulates a vendor upgrade for the
  repair loop.
- **Data** is fixed-seeded in the bank's own Postgres (`bank_generic`, `bank_example`): about
  six members per tenant, twelve months of history. Statements are built on request and cached.

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

Only forced: swallowed submit or click, late rows, injected instruction, unknown screen, and
permission, not-found and validation errors. The test oracle is a state-change counter and the
ledger, read through a test-only admin port.

---

## Task API and the workflow engine

### Responsibilities

One typed task in, one durable workflow, one typed result out, idempotently. The caller never
sees the UI, a selector, a screenshot or page text.

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
  business_outcome ──── no_such_member · member_closed · no_such_account ·
                        insufficient_funds · permission_denied · account_restricted ·
                        limit_exceeded · invalid_amount · approval_rejected
  needs_human ───────── awaiting_staff_code · awaiting_approval
  handed_off ────────── taken_over: a person finished it by hand
  escalated ─────────── unknown_screen · stuck · ambiguous_outcome · guard_tripped
  failed ────────────── app_error · unavailable · record_in_use · operator_locked ·
                        bad_credentials · step_timeout · no_driver
                        (retryable: app_error, unavailable, record_in_use, step_timeout)
  expired · cancelled
```

### Config and State

Each task is a **DBOS** workflow in Postgres; every side effect is a step. A wait for a person
is a message with a deadline; long waits are durable timers. The workflow id is the idempotency
key.

### Error Handling

The caller gets one fixed sentence per code, never bank or browser text. Failures are listed in
[How failures are handled](#how-failures-are-handled).

---

## The Runner

### Responsibilities

Runs one task at a time in one headless Chromium, through a promoted driver and the guardrails,
writing the trail as it goes. Nothing else touches a bank in production.

### The screen model

Chromium runs the bank's scripts; the Runner reads the drawn page from outside and never
injects script. Cross-origin frames get their own DevTools session.

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
| `expect(...screens)` | recognize the screen; anything else is an outcome, recovery or escalation |
| `field(label)`, `button(name)`, `tile(text, id)`, `rowWhere(col, value)` | target by meaning; exactly one match, or an error |
| `click(target)`, `type(target, text)`, `typeSecret(target, field)`, `press(key)` | real mouse and keyboard; the target is re-checked just before |
| `read(target)` | a value for the result (masked everywhere else) |

### Config and State

A **driver** is per vendor (`packages/drivers/corelink`); a **profile** is per tenant: labels,
synonyms, signature overrides, account format, thresholds. The catalog maps tenant and task to
the promoted driver version. Step limits: sign-in 2 minutes, page 45 seconds, document 60
seconds. The stall watchdog fires after 3 minutes with no step and no navigation.

---

## Transfers: approval and the one click

![A transfer: prepared by automation, approved by a person, one click](diagrams/transfer.svg)

### Responsibilities

Money moves only on a person's approval of exactly this transfer; an unclear submit is never
repeated.

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
                                 Approve, with a reason
          ◀──────────────────── grant {run, from, to, amount, memo token,
                                       nonce, expires in 5 min}
  guard checks: grant unused and unexpired · screen is the review page ·
                from, to and amount on screen equal the grant
  journal: intent + grant id
  click "Submit transfer" ────────────────────────────────────────▶ commits (maybe silently)
  grant consumed
  over threshold: park again ──▶ supervisor enters the code ◀────── code sent to supervisor
  confirmation shown? ──yes──▶ read number ─┐
          │ no / unclear                    ▼
          └──────────▶ open activity, find the memo token
                         once  ─▶ succeeded
                         twice ─▶ escalated: ambiguous_outcome (duplicate)
                         none  ─▶ escalated: ambiguous_outcome   (never resubmit)
```

### Config and State

`approval_grant` rows are single-use and bound to values, not a browser: a run whose browser was
lost signs in again, re-fills the form and re-reads the review page against the grant.

### Error Handling

A grant that disagrees with the screen refuses the click and escalates. The memo token in the
bank's memo field makes the bank's history the idempotency record.

---

## Guardrails

### Responsibilities

Every safety rule is code in `packages/guardrails`, which imports nothing from the drivers, the
Runner or the factory; prompts only repeat the rules.

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

Also: credentials are typed from Vault and never returned; a fail-closed ledger caps sign-ins;
guards judge controls, so injected page text is inert.

### Error Handling

A guard error always propagates; E0 lint forbids catching it. The trap matrix runs every money
trap and injected instruction with each layer removed in turn and records which layers each
needs. Every read task leaves the bank's state-change counter at zero.

---

## How failures are handled

Every failure lands in one of four places, each with one rule.

| Kind | Rule | The caller sees |
|---|---|---|
| **Business outcome** | the bank said no, for a reason a member would understand; stop and report | `business_outcome` with a code |
| **Recoverable condition** | handled inside the run, bounded and recorded | nothing, unless the bound runs out |
| **Hard failure** | stop cleanly with a final frame; say if a retry could help | `failed` with `retryable` |
| **Escalation** | stop where safe, keep the context, hand to a person | `escalated` or `needs_human` |

Three principles hold throughout:

- **Only reads are retried**, at most twice; anything that could change state is checked.
- **A run that ends badly ends with a picture**: a final masked frame and the trail before it.
- **Infrastructure fails closed.** No guard, secret store or spend meter, no action.

### Failures in the bank

| Failure | Detected by | The system | The caller sees | Recorded |
|---|---|---|---|---|
| Wrong password | sign-in error screen | stops; never submits again | `failed: bad_credentials`, not retryable | step, frame, sign-in ledger |
| Operator locked or rate limited | lock screen | stops; freezes the bank's sign-ins until a person clears them | `failed: operator_locked`, not retryable | step, frame, freeze |
| Staff code needed | code screen, with proof a code was sent | parks; opens a human task | `needs_human: awaiting_staff_code` | human task |
| Code rejected or expired | the bank's wording | one attempt per code; asks for a new one only if the bank offers | `needs_human: awaiting_staff_code` again; `failed: bad_credentials` after three refused codes | human task, step |
| No member found, member closed | lookup result | stops | `business_outcome: no_such_member` / `member_closed` | step, frame |
| Record in use by another operator | lookup result | retries the read twice, then stops | `failed: record_in_use`, retryable | step, recoveries |
| Insufficient funds, permission, restricted, limit, validation | transfer form, in the bank's words | stops; nothing submitted | `business_outcome: insufficient_funds` / `permission_denied` / `account_restricted` / `limit_exceeded` / `invalid_amount` | step, frame |
| Slow page, late rows | fully-rendered wait | waits up to the step limit | nothing | span timings |
| 503 or fatal script error page | error screen signature | retries a read twice, with backoff | nothing, or `failed: unavailable` (503) / `app_error` (fatal script), retryable | recoveries, frames |
| A widget failed to draw | a needed control missing | reloads once | nothing, or `escalated: unknown_screen` | recovery |
| Session expired | sign-in screen in the frameset | signs in again once, returns, re-checks the member | nothing, or `failed: unavailable`, retryable | recovery |
| Confirmation dialog, promo | dialog or interstitial signature | the non-committal choice | nothing | recovery |
| Control moved before the click | re-read just before acting | re-targets, up to twice | nothing, or `escalated: unknown_screen` | step |
| Layout unreadable on a drawn page | empty screen model, non-empty screenshot | reads once more | nothing, or `escalated: unknown_screen` | step, frame |
| Unknown screen, or two matches | recognition | stops where it is | `escalated: unknown_screen` | final frame, screen model |

### Failures in our own system

| Failure | The system | The caller sees |
|---|---|---|
| Worker or browser crash mid-run | resumes at the last completed step; a lost browser signs in fresh and returns to the same screen. A crash between a submit's journaled intent and its result goes to the history check, never a second click | nothing, or `escalated: ambiguous_outcome` |
| Stall (no step, no navigation for 3 minutes) | the watchdog saves a final frame, ends the run | `escalated: stuck` |
| Nobody answers a human task | the deadline ends the run | `expired` |
| Postgres down | 503 on new calls; running workflows pause and resume | HTTP 503 on new calls |
| Vault down | no secret to type; stops before sign-in | `failed: unavailable`, retryable |
| MinIO down | frames wait on the runner's disk (60 a run at most) and upload later; any that can't be kept are withheld with the reason | nothing |
| Memory down | runs continue; their episodes wait in an outbox and are sent later. The factory will not start a run without its knowledge pack | nothing for tasks |
| Masking cannot prove a frame clean | the frame is withheld; the run continues | nothing |
| No promoted driver for the bank and task | refused before a browser opens | `failed: no_driver`, not retryable |
| Invalid task input | refused by the schema, naming the field | HTTP 400 |
| Same idempotency key twice | returns the existing run | the same run |

### Failures in the factory

| Failure | The factory |
|---|---|
| Model API error or timeout | retries with backoff within the caps, then hands back |
| A cap reached (spend, turns, sign-ins, hours) | stops and hands back |
| Spend ledger unreadable, or a model with no known price | refuses the call (fails closed) |
| The same failure twice, or three turns without progress | ends the build loop, hands back |
| A tool call outside the role's allowlist | vetoed and recorded; the model is told why |
| Review gate not answered | a reminder at 24 hours; expires at 7 days |
| A regression on probation | reopens the build once; a second hands back |

---

## Evidence and redaction

### Responsibilities

Every run leaves a trail from its first step, however it ends; nothing personal is stored
unmasked.

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

Masking matches values known before the run (the member's credentials, codes, name, account
numbers, email) and patterns (four or more digits, amounts, emails, phones, street lines). A
frame with an unread screen model, or a known value outside a box, is withheld. Logs get pino's
key redaction and a final scrub. A failed capture is logged, never fatal.

### Error Handling

The PII suite runs every task on banks 1 and 2 and scans every row, object and log line for
every seeded secret and personal value. One hit fails it.

---

## Observability

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

Each run is one OpenTelemetry trace; its `runId`, trace id and current step ride on every row,
log line and span, so any one finds the other two.

### What the crawler did and what the agent did

A task run records every step (screen, action, outcome, duration), masked frame, recovery and
its hazard, guard decision, network event (no bodies or query strings), journal entry and human
answer. A factory run records every model call (role, model, prompt version, tokens, cost,
latency), tool call and veto, Supervisor verdict, eval rung, lesson and its spend. Traces have a
span per step or phase; model-call spans follow the OpenTelemetry **GenAI semantic
conventions**.

Logs and traces stay on the machine: `make logs`, `make <group>-logs` and
`make trace RUN=<runId>` read them, and `make observe` adds a Collector, Tempo, Loki and Grafana
(about 600 MB, off by default). Span attributes never carry a field value, credential, code,
account number, amount or name, and the PII scan covers log and trace files too. SQL views over
the records feed the Console's Home, Health and Cost pages.

---

## The Console

### Responsibilities

The operator's window into everything: **AdminJS** over the Prisma models.

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

Roles: `viewer`, `approver`, `admin`. Images come only through an allow-listed proxy, only for
frames that passed masking (a withheld frame shows its reason). URLs show host and path only.
Memory pages use the Memory API, never Memory's tables.

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

- **Two answers to one human task:** the first wins (compare and set); the second sees "already
  answered", with who and when.
- **An approval after its deadline:** refused; the run already ended `expired`.
- **A grant expired before the click:** unused; the run asks again.
- **A missing or withheld image:** a placeholder with the reason, never an error page.
- **A reasoned action without a reason** (promote, roll back, freeze, unfreeze): refused.

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

Given a tenant and a task, the factory makes a driver version: proven offline, verified live,
reviewed by a person, promoted after probation. Build mode starts from the vendor's driver and
the knowledge pack; repair mode from a repair case and the failing trails.

The agents run on **pi** ([pi.dev](https://pi.dev)), an open-source harness, one session per
role, its session file both checkpoint and record. pi reaches the model only through our
metering gateway, and its tool-call hook asks our registry first, so spend, caps and the tool
allowlist stay in our code.

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

  each Scout browser step:
     Scout ──tool call──▶ veto (role, caps, host, secret) ──▶ scout browser
         ▲                                                              │
         │                                                     masked screenshot
         │                                                              ▼
         └────────── continue | wait | stop ◀─────────────────── Supervisor
                     (an unreadable answer counts as wait)
```

### Interfaces

| Role | Model | Writes | Sees |
|---|---|---|---|
| Scout | `claude-sonnet-5-5` | browser steps, as the Supervisor directs | masked screens, tool results, the knowledge pack |
| Supervisor | `claude-opus-5-5` | the next step; the profile, each claim citing frames, seen or guess; lessons | every frame (screenshot and visible-page JSON), never the Scout's reasoning |

The tools are a closed set: browser actions by control reference, a credential by field name, a
person's code, the bundle, lint, tests, evals, live verification, Memory and catalog reads,
lessons and this run's frames. None moves money, runs page script, makes its own non-GET
request or leaves the host allowlist; transfer work stops at the review page.

### Config and State

Caps live in one import-free file: $25 a run, $150 a rolling week, 6 Scout turns, 6 live
sign-ins, 4 active hours, 3 failed-check turns, 2 live verifications, $1 kept for lessons. A run
can lower a cap, never raise it; the spend meter fails closed. Mock mode replays recorded model
responses, so no API key is needed.

### Error Handling

A failed check returns to BUILD typed, with its evidence and the one file the fix may touch.
Candidate code stays in the sandbox until approved; elsewhere, its sha256 must match, E0 reruns
in the worker, and it loads in its own module scope importing only the driver SDK.

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

The eval CLI prints one JSON object and exits 0 (passed), 1 (failed) or 2 (could not run);
"could not run" is never a pass. E2's hazard list comes from the bank.

---

## Dependencies

Every package and why it was chosen: [techstack.md](techstack.md).

---

## Known Limitations

- **Web only.** Desktop and terminal capture would plug into the same screen-model seam.
- **One browser at a time** by default, to fit in 8 GB; concurrency is a setting.
- **Banks 3 and 4 have no drivers.**
- **Hazards are ours.** Real vendors will have others.
