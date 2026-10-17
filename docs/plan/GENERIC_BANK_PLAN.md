# Generic Bank: the plan

Sections 1 to 9 are Part 1, what is built. Section 10 is Part 2, what more time buys. Three
appendices hold the reference tables, the running and building detail, and Part 2's plans.

The whole system in one picture: [the architecture diagram](architecture.md#system-architecture).

## 1. What it is

1. **Four fake bank websites** on one made-up back-office product, CoreLink Branch Console: the
   staff console a credit union employee uses to look up a member, check a balance, pull a
   statement or move money. Legacy on purpose (framesets, nested tables, no ids, content drawn by
   script) and unreliable on purpose (slow pages, script errors, outages, pop-ups).
2. **A crawler with three jobs:** Check Balance, Transfer Funds, Download Statements. It reads the
   drawn screen and clicks and types like a person. No CSS selectors, and no model at runtime.
3. **A typed REST API** over the crawler, for any caller, an AI agent included. The caller never
   sees a screen, a selector or a password.
4. **One rule about money:** the crawler fills in a transfer and stops on the bank's review page.
   Only after a person approves in our Console does it press the one button that moves money.
5. **A software factory** where two agents on [pi](https://pi.dev) learn a bank they haven't seen
   and write its crawler as a profile, which a person approves and real runs promote.
6. **A memory** that keeps what each factory run learned, kept or retired by fixed rules against
   what really happened.
7. **A Console** where people answer codes, approve transfers, resolve escalations and read every
   run's masked trail.

All TypeScript on Node 26, run on a laptop with Docker Compose and just.

**What works end to end:** bank 1 does all three tasks, transfers with a person's approval; bank 2
checks balances. The factory repairs bank 1's crawler after a vendor redesign, and learns a bank in
mock mode from a recorded run. Banks 3 and 4 are left for the factory.

## 2. The pieces

| Box | Runs | Holds | May reach |
|---|---|---|---|
| **The app box** | Task API, Console, workflow engine (DBOS), the Runner with one headless Chromium per active task (two at a time) | nothing durable | the data box; the banks |
| **The data box** | Postgres (pgvector), MinIO, the Memory service | everything durable, masked: runs, trails, journal, registry, memory, evidence | nothing outbound |
| **The factory box** | the model gateway, and per run the agents and the Scout's browser | nothing | the data box; the banks |

The four banks are "the world": their own network and database, sharing no code or store with the
system. Only the Runner and the Scout's browser reach them.

Risk lives in four places, each with one guard: the money-moving click (a person's single-use
grant), typing passwords (SOPS secrets, typed by the system, never shown), writing anything (masked
first, or withheld), and agent-written profiles (a person approves each before it runs).

**The Console** is AdminJS over the control database, beside our own pages: the **Inbox** (codes,
approvals, escalations), **Runs** (each step with its masked frame), the **Journal** (hash-chained,
with Verify), **Freezes**, **Recommendations** (the factory's profiles, approved or rejected with
their frames), **API clients**, and the **Hazard lab**. Every action needs a written reason of at
least ten characters, writes an audit entry, and is also an API call. Nothing unmasked is shown.

Data models: [the Prisma schema](../../packages/db/prisma/schema.prisma). Technology:
[techstack.md](techstack.md).

## 3. The API

| Endpoint | Does |
|---|---|
| `POST /tasks/check-balance` | `bank`, `memberId`, `account` (last four digits or nickname) → available and current balance in cents, as-of time, masked label |
| `POST /tasks/transfer` | `bank`, `memberId`, `from`, `to`, `amountCents`, `memo?`, `idempotencyKey` → confirmation number, seen in the account's history |
| `POST /tasks/download-statements` | `bank`, `memberId`, `account`, `months[]` → per month, a statement id, or "not available" in the bank's words |
| `GET /tasks/:id?wait=30` | long-polls a run to its result |
| `GET /statements/:id` | the stored PDF |
| `GET /banks`, `GET /tasks`, `GET /tools` | which banks serve which tasks; input schemas; tool definitions for agents |
| `POST /oauth/token`, `POST /oauth/revoke` | OAuth2 |

`bank` is an input, not an endpoint. The registry maps each bank and task to its promoted
crawler; a newly promoted bank appears in `GET /banks` with no new endpoint and no redeploy. A
`transfer` waits on a person, and its idempotency key returns the same run on every retry.

**One result per run, and the HTTP status tells the caller what to do:**

| Result | HTTP | The caller |
|---|---|---|
| running, or `needs_human` (a code or an approval) | `202` | asks again after `Retry-After` |
| `succeeded` | `200` | uses it |
| `business_outcome` (the bank said no: funds, permission, closed member…) | `422` | tells the member |
| `escalated`: a person must look | `409` | waits; asking again never starts a second run |
| `expired`, `cancelled` | `410` | starts again, or gives up |
| `failed`, retryable | `503` | retries after `Retry-After` |
| `failed`, not retryable | `502` | gives up |

Errors are RFC 9457 problem documents with `code`, `runId` and `retryable`. After a `409` a person
resumes, finishes by hand or cancels in the Console, and the caller just asks again. Every code:
[Appendix A.1](#a1-results-and-http).

**OAuth2.** An admin creates a client per caller in the Console; the caller trades a one-time code
for a 15-minute access token and a 30-day refresh token. Refresh tokens rotate, and presenting a
spent one revokes its whole family. Scopes cover each task, and optionally limit a client to named
banks. `just setup` also makes a local client that takes tokens by client credentials, for
`just api-token` and Swagger UI's Authorize.

The contracts are zod schemas in `packages/contracts`; the OpenAPI document
([docs/api/openapi.json](../api/openapi.json)), Swagger UI at `/docs` and the tool definitions are
generated from them, and a test fails if any of them disagree.

## 4. The four banks

One product, **CoreLink Branch Console** by Acme Core Systems, used through one staff service
account per bank, never as a member. One codebase (`apps/bank`) started with four tenant configs.

| | Bank 1 | Bank 2 | Bank 3 | Bank 4 |
|---|---|---|---|---|
| Brand | **Generic Bank** | **Example Credit Union** | **Sample Savings Bank** | **Placeholder Federal Credit Union** |
| Version | CoreLink 4.2 | 4.3 | 4.3, customized | 4.4 |
| Address | `localhost:8081/corelink/` | `localhost:8082/` | `localhost:8083/online/branch/` | `127.0.0.1:8084/cu/ib/` |
| Crawler | all three tasks, by hand | Check Balance, a profile by hand | for the factory | for the factory |
| Layout | nav frame, main frame | tab strip from another origin | an extra notices frame | menu bar, sign-in in a cross-origin iframe |
| Look | 2003: beveled gray, Verdana 10px, marquee, "NEW!" GIF | teal and beige | maroon and cream, dense | flat gray skin over the same tables |
| Sign-in words | Operator ID, Password, Sign In | Username, Passcode, Log In | Staff number, PIN, Enter | User, Password, Continue |
| Member lookup | Member Search | Find Member | Member Inquiry, by number or last name | one box, results in a popup |
| Accounts read | "Account ending in 7890" | "Share ****3456-S01" | "Acct 1234-5678-90" | "··· 7890 (Checking)" |
| Transfer | Transfer Funds, Submit transfer | Move Money, Confirm (an image) | Internal Transfer, Post | Amount, then Accounts, then Authorize |
| Staff code | text or email | email | text, then "Terms updated" | authenticator style |
| Supervisor over | $2,500 | $1,000 | $500 | $2,000 |
| Text as pictures | none | labels and Confirm | section headings | none |

Every bank is hostile in the same ways: content exists only after script runs; four to seven
levels of nested tables; no ids, no `data-*`, no `<label for>`; labels in a neighboring cell, split
across cells or drawn as images; class names hashed and form field names randomized per session;
four submit dialects; a trusted workstation that changes the sign-in page; decoys that move money
or change records ("Waive fee", "Add payee", "Change address") in plain view.

**Hazards.** "Stable UIs, but real runtime errors": every page draws from a seeded source
(latency, script errors, a 503, dialogs, promotions, a record in use, early session expiry, a slow
hand-off), never on the transfer pages, and the ones that could stop a run reach about 1 run in
240. Tests and the Hazard lab force any hazard by a signed header, including the dangerous ones
(a swallowed submit, a swallowed click, late rows, an injected instruction, an unknown screen).
Banks 3 and 4 add their own trouble, and banks 2 to 4 answer "403 Access denied" to anything not
shaped like a browser. Rates and lists: [Appendix A.3](#a3-hazards).

**Ground truth.** Each bank keeps a double-entry ledger in its own database, seeded identically on
every clone (about 25 members, twelve months of history, every case the brief names), and builds
statements from it on request. Tests read the ledger through a bank-admin API; they never take the
crawler's word. Sign-in codes go to a fake staff inbox at `:8089`, which people read and the
crawler can't.

## 5. The crawler

| Job | Steps |
|---|---|
| Check Balance | sign in, find the member, pick the account by its digits, read available and current balance |
| Download Statements | sign in, find the member, open the account's statements, press "Statement" for each month, keep the PDF |
| Transfer Funds | sign in, find the member, fill the transfer, stop on the review page ([§6](#6-transfers)) |

**Reading a screen.** Chromium runs every bank script. The Runner reads what was drawn from
outside the page over the DevTools Protocol (layout snapshot, accessibility tree, screenshot, every
frame flattened into one picture) and keeps only what is visible and on top, so a hidden twin of a
button can't be clicked. No script is ever injected. Pictures of text get their names from
perceptual hashes the factory learned; an unnamed image is never clicked.

**Ready means drawn.** Never network idle: the expected screen is recognized, a control is usable,
nothing says loading, and the layout has held for 300 ms. A usable page that matches no known screen
is unknown after 10 seconds; a page still loading gets a minute.

**Exactly one screen.** Every screen the product can show is a signature (phrases required and
forbidden, control kinds). Exactly one must match; none or two means stop and escalate with the
masked screenshot.

**Targeting by meaning.** `field("Amount")` finds the label, then the one editable control beside or
below it by geometry; `button("Submit transfer")` matches the visible name; accounts and rows are
picked by identity, never position. Clicks and keys are real mouse and keyboard, with a re-read
just before each click.

**One driver per product, one profile per bank.** The CoreLink driver is a state machine over
screens; each bank's profile carries its words, account format, thresholds and layout. A bank that
behaves differently produces an escalation, never a wrong answer.

**Failures, kept apart.** A business no is reported. A recoverable condition (a dialog, a 503 on a
read, an expired session) is handled inside the run, bounded, and never reaches the caller. A hard
failure says whether a retry helps. Anything unsafe goes to a person. Only reads are retried.
Every failure and its result: [Appendix A.2](#a2-failures).

**Chrome on a Mac.** One consistent identity, Chrome on an Apple-silicon Mac, set at launch by
switches, the DevTools Protocol and a small extension, before any page script runs. In Docker the
banks' origins are treated as secure, so Chrome sends the same headers it would over HTTPS. The
reference capture from a real Mac is
[tests/fixtures/browser/mac-chrome.json](../../tests/fixtures/browser/mac-chrome.json).

## 6. Transfers

Diagram: [architecture.md](architecture.md#transfers-approval-and-the-one-click).

1. **Prepare:** fill the form, stop on the review page, read back from, to, amount and memo. The run
   parks `needs_human: awaiting_approval` (15 minutes), holding its browser.
2. **Approve:** a person sees the masked review in the Console and approves, rejects, takes over or
   cancels. Approval mints a single-use grant (5 minutes) bound to the run, the accounts, the amount,
   the memo token and a nonce; over the bank's threshold the person also gives the supervisor code.
3. **Submit once:** the guard lets one click through, only with that grant, only on the review page,
   only if the screen still matches. The intent is journaled first, hash-chained.
4. **Verify:** each transfer carries a memo token of ours (`GBX 7Q4M`). The run reads the
   confirmation, then finds the token in the account's history.
5. **Never twice:** if the answer is unclear (a 502, a page that never finishes, 10 seconds of
   nothing, a lost session), the run never presses again. It reads the history, up to three times if
   the bank gets in the way: found once is `succeeded`; none or two is `escalated:
   ambiguous_outcome` for a person.

A lost session while parked is rebuilt after approval and checked against the grant; the grant binds
values, not a browser.

## 7. The factory

Given a bank and a task, the factory produces a crawler profile: **build** from the product's
driver and memory's knowledge pack, or **repair** from a failing run's trail.

- **The Scout** drives a live browser, one simple step at a time, through a closed set of tools.
- **The Supervisor** reads every frame (the masked screenshot and the visible page as JSON),
  decides the next step or stops, drafts the profile as a recommendation in which every claim cites
  the frames that show it and says **seen** or **guess**, and writes the run's lessons.

**Phases:** scout (read-only autocrawl) → recommend → lessons → review gate. A person approves the
recommendation with its frames in front of them; a guess is never approved by default. Then the
**hazard check** runs the profile with each hazard forced against the outcome table, and
**probation** promotes it after two clean real runs in a row (at most four, then back to
candidate).

**Lifecycle.** Each crawler, per bank and task, is draft, candidate, probation, promoted, demoted
or frozen. A crawler's first real fault demotes it, the previous version serves, and a repair case
opens; bank faults (a 503, an app error) don't count. A guard trip freezes the bank until a person
clears it. `BANK_REDESIGN` simulates a vendor upgrade, and the repair demo
([manual_test.md](manual_test.md)) shows the whole loop.

| Tool | Role | Limits |
|---|---|---|
| `browser_open` | Scout | allowed hosts only |
| `browser_look` | both | masked screenshot and screen model |
| `browser_click`, `browser_type`, `browser_choose`, `browser_press`, `browser_wait` | Scout | by control reference; typing refuses secrets; never a transfer's submit |
| `browser_type_credential`, `browser_enter_code` | Scout | the server types the value; the model never sees it |
| `recommend`, `record_lesson` | Supervisor | refused without frames from this run |
| `memory_query` | both | read-only |

No tool moves money, runs script in a page or reaches an unknown host. The factory writes profiles,
which are data, not code.

**Our code owns the limits.** Each role is a pi session whose only route to a model is our
metering gateway. Caps live in code: $25 a run, $150 a rolling week, turns, sign-ins and hours; a
run can lower a cap, never raise it. A model with no known price counts as free. Models and
effort are configuration in `config/app.env` (both roles `qwen/qwen3.8-flash`), reached through
OpenRouter, so any model in its catalog works. Without a key, **mock mode** replays a
recorded run.

## 8. Memory

![Memory: who reads and writes, through one door](diagrams/memory.svg)

Memory makes the second CoreLink bank cheaper than the first. It keeps four kinds of thing:
**episodes** (what each run did; records, always trusted), **hypotheses** (what an agent believes;
never served as truth), **facts** (claims about a bank, written only when a promoted run proves
them) and **lessons** (advice, scoped to one bank, every bank on the product, or everywhere).

Agents only propose. **Promotion is the proof:** when a crawler is promoted, memory checks its own
records and confirms the lessons the probation runs relied on. **Forgetting is by evidence:** one
contradiction disputes a lesson, two retire it, and a demotion undoes what its promotion confirmed.
Fixed rules decide, never a model; a person approves anything meant to hold everywhere. Nothing is
overwritten: every change is a new version plus a row in a hash-chained change log.

**One door.** Memory has its own Postgres database, opened only by the Memory service. Every writer
holds a role token and signs with a key only code holds, and a privacy screen refuses anything
shaped like a password, a code, an account number or a person. Facts are bi-temporal rows
(`valid_at`, `invalid_at`), closed and never deleted, so memory can say what was believed at the
time of any run. Search fuses Postgres full-text ranking with pgvector similarity; the embeddings come
from a small local model (`bge-small-en-v1.5`), because lessons from different banks say the same
thing in different words, and only meaning matches them.

**Use.** Every factory run starts from a **knowledge pack** (patterns, the product's lessons, this
bank's, its recent attempts, the two nearest crawlers), and stops if memory can't supply one. Every
settled task run writes one episode through an outbox; memory being down never changes a task's
result. It starts from a cleaned seed of rules, lessons and failure scenarios (`just memory-seed`).
Rules and endpoints: [Appendix A.6](#a6-memory). On a graph: [Appendix C.2](#c2-memory-on-a-graph).

## 9. Safety

| Layer | Does | Part |
|---|---|---|
| **The guard on every action** | every click, key and choice is decided against the task's allowlist (screen, verb, control) before the browser; money and account-change controls are on no list | 1 |
| **Approval grant** | a person's single-use key for the one money-moving click | 1 |
| **Secret typing** | the system types credentials; text that holds the stored password is never typed into another field | 1 |
| **Guard trip** | ends the run `escalated: guard_tripped`, journals it, freezes the bank; a lint rule forbids catching a guard error | 1 |
| **Masking** | known values and patterns (four or more digits, amounts, emails, phones) covered before anything is written; a frame that can't be proven clean is withheld | 1 |
| **Caps and tools** | model spend and turns in code; a closed tool set per role | 1 |
| **Networks** | compose networks decide who reaches whom; the data network is internal | 1 |
| **Page and outcome** | classify each page; trip on confirmation wording that shouldn't appear | 2 |
| **Member scope** | act only on screens showing the member the task named | 2 |
| **Network after sign-in** | refuse state-changing requests the allowlist doesn't name | 2 |
| **Sign-in pacing** | a ledger that caps and paces sign-ins, failing closed | 2 |
| **Customer-safe messages** | a filter on every result the API sends | 2 |

Page text is data, never an instruction: the guards judge controls and pages, never what the text
asks for. Logs record requests, never member details. The proof is the guard's tests and the PII
scan, which runs a balance and a transfer on bank 1 and searches every database row, stored object
and log line for the seeded personal details. The allowlist: [Appendix A.5](#a5-the-allowlist).

The principles behind it all: a verified outcome or none; look, then act; recognize the screen
first; target by meaning; never inject script; never retry anything irreversible; one password
submit per sign-in, and a code asked of a person only after the bank proves it sent one; no false
success; a clean hand-back beats a clever partial; code owns every limit.

## 10. Part 2: with more time

| Item | Why it waits |
|---|---|
| Production ground: Hetzner with Terraform, Tailscale, Google sign-in, Cloudflare in front of the API, real HTTPS | a laptop needs none of it |
| Vault for staff credentials, dynamic and short-lived | SOPS covers a local stack |
| Temporal behind the same workflow interface | DBOS runs in-process with no extra service |
| Memory on a graph: Neo4j, with Graphiti for facts | the ideas fit in Postgres tables at this size |
| The remaining guardrails (§9) and the trap matrix | the guard on every action and the grant already stop every money path |
| The factory live: banks 3 and 4 end to end, with a real model budget | mock mode and the repair demo prove the loop |
| Evals E0, E1, E3, E4; the prompt library and its checker | Part 1 has the two rungs that gate promotion |
| The Console complete: memory, prompts, drivers, cost and health pages | the Inbox, Runs, Journal and Freezes cover what a person must do |
| Traces, metrics and alerting | records and JSON logs share one run id |
| Scaling out: runners per bank, several factory boxes | two runs at a time suit one machine |

Details: [Appendix C](#appendix-c-part-2).

# Appendices

## Appendix A. Reference

### A.1 Results and HTTP

| Status | Codes | HTTP |
|---|---|---|
| `succeeded` | | `200` |
| `handed_off` | `taken_over` (a person finished by hand) | `200` |
| `needs_human` | `awaiting_staff_code`, `awaiting_approval` | `202` |
| `business_outcome` | `no_such_member`, `member_closed`, `no_such_account`, `insufficient_funds`, `permission_denied`, `account_restricted`, `limit_exceeded`, `invalid_amount`, `approval_rejected` | `422` |
| `escalated` | `unknown_screen`, `stuck`, `ambiguous_outcome`, `guard_tripped` | `409` |
| `failed`, retryable | `app_error`, `unavailable`, `record_in_use`, `step_timeout` | `503` |
| `failed` | `operator_locked`, `bad_credentials`, `no_driver` | `502` |
| `expired`, `cancelled` | | `410` |

Also: `400` with the field that failed; `404 unknown_bank` or `task_not_available` with the banks
that do serve the task; `401` with `WWW-Authenticate: Bearer`; `403 insufficient_scope`; `429` with
`Retry-After`. A `409` carries the escalation id and whether it is `resolvable`; a guard trip is not,
until a person clears the freeze.

### A.2 Failures

| Failure | The crawler | The caller sees |
|---|---|---|
| Wrong password | stops; never submits again | `failed: bad_credentials` |
| Operator locked | stops | `failed: operator_locked` |
| Staff code needed | parks once the bank proves it sent one; one attempt per code | `needs_human: awaiting_staff_code` |
| No member, closed member | stops | `business_outcome` |
| Record in use | retries the read twice, then stops | `failed: record_in_use`, retryable |
| Funds, permission, restricted, limit, validation | stops before anything is submitted | `business_outcome` |
| Slow page, late rows | waits within its limit | nothing |
| 503 or fatal script page | retries a read twice with backoff | nothing, or `failed: unavailable` |
| Widget failed to draw | reloads once | nothing, or `escalated` |
| Session expired | signs in again once, returns, re-checks the member | nothing, or `failed` |
| Dialog or promotion | the non-committal answer | nothing |
| Unknown screen, or two matches | stops where it is | `escalated: unknown_screen` |
| Unclear submit | never clicks again; reads the history | `succeeded`, or `escalated: ambiguous_outcome` |
| Grant doesn't match the screen | refuses the click | `escalated` |
| Guard trip | stops; freezes the bank | `escalated: guard_tripped` |
| Worker or browser crash | the workflow resumes at its last step; a crash after a submit's intent goes straight to the history | nothing, or `escalated: ambiguous_outcome` |
| Nobody answers a person's task | the deadline ends the run | `expired` |
| Postgres down | the API answers `503`; workflows resume when it returns | `503` |
| MinIO down | the frame is missing; the run continues | nothing |
| Memory down | episodes wait in an outbox; the factory won't start without its pack | nothing |
| No promoted crawler | refused before any browser opens | `404 task_not_available` |
| Same idempotency key | returns the existing run | the same run |

In the factory: a model error retries within the caps; a cap stops and hands back; an unreadable
spend ledger refuses the call; the same failure twice or three turns without progress ends the
build; a tool outside the role's list is vetoed and the model told why; a hazard check that could
not run is never a pass.

### A.3 Hazards

Per page, from `HAZARD_SEED`, never on the transfer pages. `HAZARDS=gentle` quarters every rate;
`harsh` doubles it.

| Hazard | Rate | Effect |
|---|---|---|
| Latency | every response | 0 to 150 ms; frames load in any order |
| Script error, harmless | 2% | a console `TypeError` |
| Script error, widget | 0.005% | a widget fails to draw |
| Script error, fatal | 0.002% | "An unexpected error has occurred" |
| Service unavailable | 0.01% | a gateway 503 |
| Confirmation dialog | 1% of summaries | `window.confirm(…)` |
| Promotion | 1% of first loads | "New in CoreLink" with "Not now" |
| Record in use | 0.002% of lookups | "in use by another operator" |
| Early session expiry | 0.002% | the sign-in page inside the main frame |
| Slow hand-off | 2% of sign-ins | the callback holds 2 to 3 seconds |

**Forced only**, by a signed `X-Hazards` header on a bank with `HAZARDS_FORCEABLE=true`: a
swallowed submit (posted, answer lost), a swallowed click, late rows, an injected instruction, an
unknown screen, and permission, not-found and validation errors.

| Bank 3's trouble | Bank 4's trouble |
|---|---|
| a hidden copy of the password field and Sign In | a hand-off that flashes the console, then returns to sign-in |
| a field that reads its value only from key presses | an expired code clears the field silently |
| notices and tax forms among the statements | statements open in a viewer with its own Download |
| twelve rows, then "View more statements" | statement links bound to their window |
| a row menu drawn at the end of the page | account tiles in a new order on every load |
| a notice bar covering the submit control | "Bill pay is temporarily unavailable" on a working page |

Banks 2 to 4 refuse with "403 Access denied": curl (its user agent, or its bare three-header
request), a page request missing `Accept-Language` or `Sec-Fetch-*`, a headless user agent, and
client hints that contradict the user agent. Bank 1 checks nothing.

### A.4 Time limits

| Wait | Limit |
|---|---|
| A page to finish loading | 1 minute |
| A usable page that matches no screen | 10 seconds, then unknown |
| Activity rows, a statement download | 30 seconds each |
| An answer after the submit | 10 seconds, then the history |
| A person's task | 15 minutes |
| An approval grant | 5 minutes, single use |
| Frames per run | 60 |

### A.5 The allowlist

One file per job in `packages/guardrails/allowlists/`, in the product's words; each bank's profile
supplies its own ("Log In" counts as "Sign In"). Widening a list is a reviewed code change.

| Job | Screen | Allowed |
|---|---|---|
| every job | sign-in | type Operator ID and Password (secret typing), press Sign In |
| | staff code | choose a channel once, ask for a code, type the code a person gave, press Verify |
| | notice, promotion, session warning | the non-committal choice, or Acknowledge |
| | member search | type the member number, press Search, open the one result |
| | any screen | open Member Search; dismiss a notice drawn over the page |
| check balance | member summary | read |
| statements | summary, statements, statement viewer | open Statements, choose the account, show more, press Statement per requested month, Download |
| transfer | summary | open Transfer Funds, and Activity to confirm |
| | transfer form | choose From and To, type Amount and Memo, press Continue |
| | review | press Submit transfer **only with a matching, unused grant** |
| | supervisor approval | type the supervisor code a person gave, press Approve |

Never on any list, whatever a bank calls them: Pay now, Add payee, Change address, Waive fee,
Enroll in eStatements, Close account, Admin, Reports.

### A.6 Memory

| Rule | |
|---|---|
| A fact | needs a promoted run as proof; nobody types one in |
| A proposed lesson | served labeled "verify before relying"; a near duplicate (0.95 similarity, same scope) merges its evidence |
| Confirm | a promotion whose probation runs relied on or proposed it |
| Dispute, retire | one contradiction disputes; two runs' contradictions retire; a demotion disputes what its promotion confirmed |
| Narrow, widen | wrong at one bank retires it there only; proven at two banks of a product widens to the product; across three products it becomes a pattern candidate, which a person approves |
| Return | a retired lesson comes back when a later promoted run relied on it |

**Roles:** the Scout and Supervisor record episodes and hypotheses; the Supervisor proposes and
challenges lessons; the app box adds episodes and forwards lessons; only the Memory service writes
confirmations and facts; a person curates. The knowledge pack fills tiers in order within a size
budget; `memory_query` answers with at most eight items and three facts.

**Endpoints:** `episodes/runs`, `episodes/attempts`, `episodes/search|recent|recurring`, `facts`,
`facts/search`, `facts/invalidate`, `lessons/proposals`, `lessons/relied-on`, `lessons/confirm`,
`lessons/retire`, `curated`, `curated/approve`, the catalogs (`scenarios`, `approaches`, `rules`,
`checks`, `lessons`), `knowledge/pack`, `history`, `history/verify`. Errors: `401`, `403
role_forbidden`, `409` (a fact without a successful run), `422` (the privacy screen refused),
`503`. A change log that fails verification puts memory into read-only mode.

### A.7 OAuth2

| Scope | Allows |
|---|---|
| `tasks:read` | `GET /banks`, `/tasks`, `/tools`, `/tasks/:id` |
| `tasks:balance`, `tasks:statements`, `tasks:transfer` | each task (a transfer still needs a person) |
| `bank:<id>` | limits the client to named banks |

Tokens are opaque and stored only as keyed hashes; the client secret and starting code are shown
once. A spent refresh token revokes its family and flags possible theft. Token requests are
rate-limited per client and audited. Errors follow the OAuth2 rules (`invalid_grant`,
`invalid_client`, `unsupported_grant_type`).

## Appendix B. Running and building it

To run it: [README.md](../../README.md). Every address and sign-in, and the Task API with curl and
Swagger UI: [ACCESS.md](../../ACCESS.md). A full walkthrough: `docs/plan/end-to-end-test.md`. Each
milestone's pull requests: [the build sheets](../build/). The brief point by point:
[REQUIREMENTS.md](REQUIREMENTS.md).

### B.1 Layout

| Folder | Holds |
|---|---|
| `apps/` | bank (all four banks), api, console, runner, memory, factory |
| `packages/` | contracts, screen, drivers, guardrails, evidence, runs, oauth, config, db |
| `seeds/` | memory's starting knowledge |
| `tests/` | browser, runs, outcomes, escalation, pii |
| `infra/` | compose, Dockerfiles, scripts, the secrets spec |
| `docs/` | the plan, the build sheets, the API document |

npm workspaces with TypeScript project references, ESM, Node 26. `dependency-cruiser` enforces the
boundaries: nothing imports `apps/bank` (the bank is reached only over HTTP); `guardrails` and
`evidence` never import the Runner, drivers or factory; drivers import only `screen` and
`contracts`.

### B.2 Secrets and configuration

`config/app.env` is committed and holds nothing secret, models included. SOPS with age encrypts the
secrets files that `just setup` generates; neither they nor the key are committed. Each service
receives only its own secrets. The factory's model key starts blank (mock mode); `just secret-set
factory OPENROUTER_API_KEY` sets it. Settings fail
closed: every required value present, secrets at
least 32 characters, no two alike.

### B.3 Memory budget

Docker gets 5.25 GB on an 8 GB Mac; every container has a limit.

| Service | Box | Limit |
|---|---|---|
| `postgres`, `minio`, `memory` | data | 384, 128, 512 MB |
| `api`, `console` | app | 192, 256 MB |
| `runner` (two Chromium at a time) | app | 1536 MB |
| four banks, `bank-inbox`, `bank-db` | world | 128 MB each, 96 MB, 128 MB |
| `factory` (the gateway) | factory | 256 MB |
| **Everything `just up` starts** | | **about 3.9 GB** |
| `factory-run`, during a factory run | factory | 768 MB, **about 4.7 GB in all** |

### B.4 Tests and CI

| Suite | Proves |
|---|---|
| `packages/*/test`, `apps/*/test` | recognition, targeting, masking, guards, grants, caps, memory rules, OAuth2, the Console's pages |
| `apps/bank/test` | the ledger, every forced hazard on its page, all four banks by hand through the redesign |
| `tests/runs` | a balance and statements end to end, a transfer approved and posted once, a swallowed submit found in the history, the recorder |
| `tests/outcomes`, `tests/escalation` | a business outcome, a recoverable condition and a hard failure; an escalation resumed by a person through the API |
| `tests/browser` | bank 2 in Chromium; the factory's repair of bank 1 |
| `tests/pii` | no seeded value in any row, object or log line |

One test per thing that ships, nothing twice; fakes never return the answer under test; the bank's
ledger is the judge. CI asks GitHub which files a pull request changed: docs alone run nothing.
Otherwise typecheck, lint and boundaries; the tests the change touches (all of them on master),
stopping at the first failure; the factory's repair on its own machine when the factory, drivers or
screen code change; a fresh clone running `just setup` and `just up` with nothing cached; and
`gitleaks` over the history.

## Appendix C. Part 2

### C.1 Production ground

The same containers, run the way a bank expects. Hetzner, provisioned with Terraform and Atmos, the
factory box created per session; no public SSH, Tailscale only; people sign in with Google, Console
roles from groups, four-eyes approvals; the API behind Cloudflare; Vault for staff credentials,
read at the moment of typing, short-lived and rotated; encryption at rest and in flight, banks 2 to
4 on real HTTPS; Temporal behind the workflow interface; UUIDs for every id; OCR as a second masking
check; frames in color; real Chrome on real Macs; health checks from outside and a status page;
Falco, CrowdSec, Wazuh and Vector with alerts to a phone; drilled backups; `just export` and
`just import`; OpenTelemetry traces with Tempo, Loki and Grafana; signed, scanned images pinned by
digest.

### C.2 Memory on a graph

Memory is about connections (a bank runs a product, the product has screens, a sign-in is gated by
a code, a lesson is evidence for a scenario), and a graph makes those the data. **Neo4j** holds every
node, relationship and version, written in Cypher by code. **Graphiti** handles facts only, as
bi-temporal edges (`Example Credit Union GATED_BY staff code by email`, with `valid_at`,
`invalid_at`, `expired_at`), after the Zep paper's temporal knowledge graph (arXiv:2501.13956).
Facts are still built by code from a run's records; Graphiti's one model question is whether two
entities or facts are the same thing. Search is BM25 plus local embeddings, fused by rank. The
roles, signed writes, privacy screen, rules, knowledge pack and API don't change, so the factory
and Console don't notice. The tables map one to one onto the graph, and the importer replays the
change log, checking every hash.

| | Part 1 | Part 2 |
|---|---|---|
| Episodes, hypotheses | Postgres tables | Neo4j nodes |
| Facts | rows with `valid_at`, `invalid_at` | Graphiti bi-temporal edges |
| Lessons | one row per version | one node per version |
| Search | full-text plus pgvector | BM25 plus vectors |
| Change log | hash-chained table | hash-chained nodes |

### C.3 The remaining guardrails

Each page classified as read-only, money-moving, account-change or unknown, and on a money page the
session reads and leaves; an outcome watch that trips on confirmation wording that shouldn't appear;
member scope on every screen; state-changing requests after sign-in refused unless listed; a
sign-in ledger that caps and paces; a customer-safe message filter; the trap matrix, running every
money trap and injected instruction on banks 1 and 2 with each guard layer removed in turn.

### C.4 Evals and prompts

| Rung | Proves | Part |
|---|---|---|
| E0 lint | no selectors, no injected script, no non-GET requests, guard errors propagate | 2 |
| E1 contract | one typed result per request, against recorded screens | 2 |
| E2 hazard check | the profile gives the outcome table's result under each forced hazard | 1 |
| E3 replay | behavior matches recorded trails | 2 |
| E4 live verify | one fresh sign-in and one trusted workstation, hazards on | 2 |
| E5 probation | two clean real runs in a row | 1 |

A rung passes only if every check passed and it actually ran. The prompt library moves the prompts
from beside their code into reviewed files with frontmatter, includes, JSON-schema answers and
eval cases, checked by `check-prompts`, edited as drafts in the Console and activated only when their
evals pass.

### C.5 Scaling and more

Runner workers per bank behind the one API; a concurrency limit per bank and a shared sign-in
ledger; several factory boxes at once. A second, unrelated vendor product; desktop and terminal
capture behind the same screen model; an MCP adapter on the REST API; models through OpenRouter
behind the same meter; factory output as pull requests; data retention with legal hold.
