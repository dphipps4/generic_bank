# M4: Human steps

First comes the browser's fingerprint: the Runner passes as Chrome on a Mac, and banks 2 to 4
turn away anything that isn't a browser. Then comes everything a person does for the crawler,
and the one thing the crawler never does without a person: move money. A person answers staff
codes in the Console, not a script. The crawler prepares a transfer and parks it on the bank's
review page, a person approves it, and it's submitted once under a single-use grant. If the
result is unclear, the crawler reads the account's history and never presses the button again.
Statements come back as stored documents, and every error path is one click away in the hazard
lab. The plan's
[§6](../plan/GENERIC_BANK_PLAN.md#6-transfers),
[§3](../plan/GENERIC_BANK_PLAN.md#3-the-api),
[§3](../plan/GENERIC_BANK_PLAN.md#3-the-api) and
[§A.3](../plan/GENERIC_BANK_PLAN.md#a3-hazards) are the specification, with
[§5](../plan/GENERIC_BANK_PLAN.md#5-the-crawler) and
[§5](../plan/GENERIC_BANK_PLAN.md#5-the-crawler) for the fingerprint.

The bank's own ledger is the judge throughout. A test never takes the crawler's word that a
transfer happened once: it counts the bank's postings and its state-change counter.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **Human steps, in types** | The kinds of human task (staff code, approval, supervisor code, escalation), each action and the states it is allowed from, the pending kind in a `202` body; the columns a resolution needs | an action from the wrong state is refused; the migration applies on top of the last one |
| 2 | **The inbox** | A Console page of open human tasks, oldest deadline first, with how long the agent has waited; a staff code answered there and typed key by key; `POST /human-tasks/:id/answer` for tests; a banner for anything waiting over five minutes | the scripted answer in the run tests is gone: tests answer through the Console API, and the stored answer is `****` |
| 3 | **Chrome on a Mac** | The Runner's browser is given the Mac identity of §5 at launch (user agent and client hints, headers, screen, cores, memory, language, timezone); a reference capture from a real Mac as a fixture; inside Docker the banks count as secure origins, so Chrome sends every header a real browser does | Bank 2's bot screen lets the Runner's Chrome in (`tests/browser/corelink-banks.test.ts`); the fixture is no longer compared field by field |
| 4 | **Banks 2 to 4 refuse anything not a browser** | A bot screen before every page: curl, a request without browser headers, a headless user agent, client hints that contradict the user agent; a 403 "Access denied" page and a hazard-log entry; the README's curl example | the Runner's Chrome passes Bank 2's screen (`tests/browser/corelink-banks.test.ts`); a refusal has no test |
| 5 | **The journal** | Every intended and performed state-changing action, hash-chained per run; the Journal page with Verify | changing any row breaks verification at that row |
| 6 | **The payment guard** | `packages/guardrails` begins: the transfer allowlist as a file, money-moving controls refused, and approval grants (bound to the run, the masked accounts, the amount, the memo token and a nonce; five minutes; single use) | with no grant, a used one, an expired one or a different amount on screen, the submit is refused (`packages/guardrails/test/grants.test.ts`) |
| 7 | **Preparing a transfer** | The CoreLink driver's Transfer up to the review page: both accounts by identity, the memo token typed, the review page recognized and read back; refusals in the bank's words | the bank refuses in its own words (`apps/bank/test/ledger.test.ts`); the driver's code for each refusal has no test of its own |
| 8 | **Approval** | The run parks `awaiting_approval` holding its browser; the approval page with the masked review screenshot and the values as read; Approve (with the supervisor code over the threshold), Reject, Take over, Cancel | the approval page shows the review as read, and every action needs a written reason (`apps/console/test/inbox-pages.test.ts`); an approved transfer posts once (`tests/runs/transfer.test.ts`) |
| 9 | **Submit and verify** | The journaled intent, the one click under the grant, the confirmation number, and the transfer found in the activity by its memo token, read up to three times if the bank gets in the way | `succeeded` carries the confirmation and `seenInHistory`; the grant cannot be used twice |
| 10 | **The swallowed-submit protocol** | An unclear result waits 10 seconds, reads the history and never clicks again: found once, `succeeded`; twice or not at all, `ambiguous_outcome`. A crash after the intent goes straight to the history. A parked run whose browser is lost signs in fresh after approval and checks the screen against the grant | under a forced swallowed submit, one press and one posting by the bank's ledger (`tests/runs/transfer.test.ts`); a killed browser is in the transfer-safety suite, Part 2 |
| 11 | **Transfers through the API** | `POST /tasks/transfer`; the idempotency key returns the same run; a second request for the same transfer while one is escalated is a `409` pointing to it; the driver promoted for Generic Bank | the same key twice is one run (`apps/api/test/transfer.test.ts`) |
| 12 | **Escalations** | Resume, Finish by hand and Cancel from the inbox; the escalation id and `resolvable` in the problem details; a guard trip freezes the bank until a person clears it on the Freezes page | the agent sees `409`, then `202` after Resume and `200` once the Runner is done (`tests/escalation/escalations.test.ts`); every other ending has its own status code (`apps/api/test/runs.test.ts`) |
| 13 | **Download Statements** | The driver for Generic Bank, each requested month stored as a document, "not available" in the bank's words, `POST /tasks/download-statements`, and the statement fetched by its reference with `tasks:statements` | the stored PDF is the bank's own for that month; a month the bank does not have is "not available" |
| 14 | **The tools, complete** | Every task as a tool, each description saying what it never does; tool results carry an error flag for every status but success, hand-off and waiting | the tools, the endpoints and the OpenAPI document never disagree |
| 15 | **The hazard lab** | A Console page for admins when hazards are forceable: bank, member, task and hazards, with the expected result beside each; `just try` from the command line | the lab and the outcome table read the same list of hazards and results |
| 16 | **The escalation suite** | `tests/escalation`: an unknown screen escalates; a person resumes it through the Console API, and the run finishes | an unknown screen escalates, and Resume finishes the run (`tests/escalation/escalations.test.ts`) |
| 17 | **The transfer-safety suite** (Part 2) | Swallowed submit, lost session while parked, the amount changed on screen, grant replay, duplicate detection | never two postings for one grant, by the bank's ledger |
