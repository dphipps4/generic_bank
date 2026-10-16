# M5: Guardrails

Every action the crawler takes passes the guards before it reaches the browser. The allowlist
names what each job may do, as *screen, verb, control*, and anything else is refused, recorded
with its rule and layer, and trips the guard: the bank is frozen and the run ends
`escalated: guard_tripped`. The guard judges the control on screen (and, in Part 2, the page, the member on screen and the
request on the wire), never what the page's text asks for. Everything personal is masked before
it's written, and the caller only ever reads our own fixed sentences. The plan's
[§9](../plan/GENERIC_BANK_PLAN.md#9-safety) and
[§9](../plan/GENERIC_BANK_PLAN.md#9-safety) are the specification, with
[§9](../plan/GENERIC_BANK_PLAN.md#9-safety) and
[§9](../plan/GENERIC_BANK_PLAN.md#9-safety) for masking,
[§A.1](../plan/GENERIC_BANK_PLAN.md#a1-results-and-http) for the messages and
[§B.4](../plan/GENERIC_BANK_PLAN.md#b4-tests-and-ci) for the two suites.

The allowlist files, the approval grant and the freeze are in `packages/guardrails`; masking and
withheld frames are in `packages/evidence`; the PII scan is `tests/pii`; the factory's Scout
carries its own refusals ([§7](../plan/GENERIC_BANK_PLAN.md#7-the-factory)). This sheet puts the
guard in front of every action the Runner takes; the remaining layers are Part 2.

The bank is the judge throughout. A trap counts as refused when the bank's state-change counter
doesn't move, and a value counts as masked when nothing the runs wrote contains it.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **This sheet, and the plan** | The layers still to build, in order; traces, `just trace` and `just observe` in Part 2, and the Justfile saying so | the plan, this sheet and the Justfile agree |
| 2 | **The guard on every action** | Every click, key press and choice the Runner makes is decided against the job's allowlist, from the recognized screen and the control's visible name, before the browser; a refusal trips the guard; plain typing of any text that holds the stored password is refused; a lint rule forbids catching a guard error | each job's allowed actions pass, and any other is refused with its rule and layer (`packages/guardrails/test/decide.test.ts`); a guard trip freezes the bank (`packages/guardrails/test/grants.test.ts`); a `catch` around a guard error fails lint (`packages/guardrails/test/catch.test.ts`) |
| 3 | **The page and the outcome** (Part 2) | Every page classified as read-only, money-moving, account-change or unknown from what it shows; on a money or account-change page the session reads and leaves, and types or clicks only as the allowlist and a grant permit; confirmation wording after a click that should not cause it trips the guard | on a decoy page ("Waive fee", "Add payee", "Close account") every action but leaving is refused; a confirmation after a read's click trips the guard |
| 4 | **Member scope** (Part 2) | Every screen the Runner acts on must show the member number the task named; a different member, or none where one is expected, is refused and trips the guard | a screen showing another member trips the guard before any action, and nothing is read from it |
| 5 | **The network after sign-in** (Part 2) | After sign-in, a state-changing request is refused before it is sent unless the allowlist names it (the transfer form's "Continue", the granted submit); a page's own background requests are refused quietly and logged, never a trip | a decoy form's request never reaches the bank and its counter does not move; a keep-alive is refused and logged, with no trip |
| 6 | **Sign-in pacing** (Part 2) | The sign-in ledger: every attempt written, a cap on a day's sign-ins and a pause between them; a ledger that cannot be read means no sign-in | at the cap, and with the ledger unreadable, the run ends before the bank sees a sign-in |
| 7 | **Customer-safe messages** (Part 2) | Every result and problem the API sends passes the filter; a message it replaces is logged, masked | in the outcome suite every result carries its code's fixed sentence; page text, a stack trace or an internal host put into a result reaches the caller as a canned sentence |
| 8 | **The trap matrix** (Part 2) | `tests/guards` and `just test-guards`: every money trap and the injected instruction on banks 1 and 2, with each guard layer removed in turn; every verdict judged with and without injected text; clean Check Balance and Download Statements runs | with any one layer removed another still refuses, and the bank's state-change counter never moves; no verdict changes with injected text; a clean read leaves the counter at zero; the suite is green and CI fails if it is skipped |
| 9 | **PII under every hazard** (Part 2) | `tests/pii` also runs Check Balance under every forced hazard and scans what it wrote | no seeded value in any row, object or log line; the suite is green and CI fails if it is skipped |
