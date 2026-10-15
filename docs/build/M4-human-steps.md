# M4: Human steps

Everything a person does for the crawler, and the one thing the crawler never does without a
person: move money. Staff codes are answered in the Console instead of by a script. A transfer
is prepared by the crawler, parked on the bank's review page, approved by a person, and
submitted once under a single-use grant; if the result is unclear, the crawler reads the
account's history and never presses the button again. Statements come back as stored
documents, the demo agent holds a whole conversation through the API's own tools, and every
error path is one click away in the hazard lab. The plan's
[Appendix F](../plan/GENERIC_BANK_PLAN.md#appendix-f-transfers-a-human-approved-activity),
[§D.5](../plan/GENERIC_BANK_PLAN.md#d5-tools-for-agents-and-the-demo-agent),
[§D.8](../plan/GENERIC_BANK_PLAN.md#d8-escalate-resolve-retry) and
[§S.2](../plan/GENERIC_BANK_PLAN.md#s2-the-hazard-lab) are the specification.

The bank's own ledger is the judge throughout. A test never takes the crawler's word that a
transfer happened once: it counts the bank's postings and its state-change counter.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **Human steps, in types** | The kinds of human task (staff code, approval, supervisor code, escalation), each action and the states it is allowed from, the pending kind in a `202` body; the columns a resolution needs | an action from the wrong state is refused; the migration applies on top of the last one |
| 2 | **The inbox** | A Console page of open human tasks, oldest deadline first, with how long the agent has waited; a staff code answered there and typed key by key; `POST /human-tasks/:id/answer` for tests; a banner for anything waiting over five minutes | the scripted answer in the run tests is gone: tests answer through the Console API, and the stored answer is `****` |
| 3 | **The journal** | Every intended and performed state-changing action, hash-chained per run; the Journal page with Verify | changing any row breaks verification at that row |
| 4 | **The payment guard** | `packages/guardrails` begins: the transfer allowlist as a file, money-moving controls refused, and approval grants (bound to the run, the masked accounts, the amount, the memo token and a nonce; five minutes; single use) | with no grant, a used one, an expired one or a different amount on screen, the click is refused and the bank's counter does not move |
| 5 | **Preparing a transfer** | The CoreLink driver's Transfer up to the review page: both accounts by identity, the memo token typed, the review page recognized and read back; refusals in the bank's words | each refusal ends in its business code with nothing submitted |
| 6 | **Approval** | The run parks `awaiting_approval` holding its browser; the approval page with the masked review screenshot and the values as read; Approve (with the supervisor code over the threshold), Reject, Take over, Cancel | each action ends the run in the result the plan gives it |
| 7 | **Submit and verify** | The journaled intent, the one click under the grant, the confirmation number, and the transfer found in the activity by its memo token | `succeeded` carries the confirmation and `seenInHistory`; the grant cannot be used twice |
| 8 | **The swallowed-submit protocol** | An unclear result reads the history and never clicks again: found once, `succeeded`; twice or not at all, `ambiguous_outcome`. A crash after the intent goes straight to the history. A parked run whose browser is lost signs in fresh after approval and checks the screen against the grant | under a forced swallowed submit and a killed browser, the bank never posts two transfers for one grant |
| 9 | **Transfers through the API** | `POST /tasks/transfer`; the idempotency key returns the same run; a second request for the same transfer while one is escalated is a `409` pointing to it; the driver promoted for Generic Bank | the same key twice is one run and one posting |
| 10 | **Escalations** | Resume, Finish by hand and Cancel from the inbox; the escalation id and `resolvable` in the problem details; a guard trip freezes the bank until a person clears it on the Freezes page | the agent sees `409`, then `200` after Resume, `200 handed_off` after Finish by hand, `410` after Cancel |
| 11 | **Download Statements** | The driver for Generic Bank, each requested month stored as a document, "not available" in the bank's words, `POST /tasks/download-statements`, and the statement fetched by its reference with `tasks:statements` | the stored PDF is the bank's own for that month; a month the bank does not have is "not available" |
| 12 | **The tools, complete** | Every task as a tool, each description saying what it never does; tool results carry an error flag for every status but success, hand-off and waiting | the tools, the endpoints and the OpenAPI document never disagree |
| 13 | **The demo agent** | `apps/agent` and `make agent`: a member assistant on Claude in a pi session, whose only tools are the ones `GET /tools` returns; without a key, a scripted mock makes the same calls | the mock conversation runs end to end against the real API, and its transfer waits for a person |
| 14 | **The hazard lab** | A Console page for admins when hazards are forceable: bank, member, task and hazards, with the expected result beside each; `make try` from the command line | the lab and the outcome table read the same list of hazards and results |
| 15 | **The escalation suite** | `tests/escalation`: staff code, approval, supervisor code, reject, take over, cancel and expiry, all driven through the Console API | the suite is green and CI fails if it is skipped |
| 16 | **The transfer-safety suite** | `tests/transfer`: swallowed submit, lost session while parked, the amount changed on screen, grant replay, duplicate detection | never two postings for one grant, by the bank's ledger |
