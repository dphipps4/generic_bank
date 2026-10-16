# M1: Bank 1

Generic Bank becomes a working staff console: a ledger, staff sign-in with codes, member
lookup, balances, activity, statements, and transfers with supervisor approval. The markup is
old-fashioned on purpose, and the tests can force hazards. The plan's
[§4](../plan/GENERIC_BANK_PLAN.md#4-the-four-banks) is the
specification.

It lands as a series of small pull requests. Each stands alone, has its own tests and leaves
`just check` green.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **Tenant config and the bank's database** | Every difference between the four banks in one config; the bank's schema; Postgres in the containers, PGlite in tests | every bank test starts a bank on this schema (`apps/bank/test/ledger.test.ts`) |
| 2 | **The seed** | Staff accounts, 25 fictional members with one for every case the brief names, twelve months of history | every bank test starts from it; the ledger test reads its members and balances (`apps/bank/test/ledger.test.ts`) |
| 3 | **The ledger and transfer rules** | Balances computed from the double-entry ledger; the bank's checks in its own words; posting a transfer atomically | the ledger always sums to zero; every refusal has a test |
| 4 | **Statements** | One PDF per month, built from the ledger on request | each requested month is stored as the bank serves it, or "not available" in its words (`tests/runs/execute.test.ts`) |
| 5 | **Runtime hazards** | Ambient hazards at the plan's rates, per page and never on the transfer pages, in three profiles; forced hazards by a signed header | each forced hazard shows where the operator would see it (`apps/bank/test/hazard-matrix.test.ts`); a header signed with another key is refused (`tests/outcomes/one-source.test.ts`) |
| 6 | **Markup dialects** | Nested tables, four submit dialects, split labels, hashed class names, field names random per session | the driver finds every control by label and geometry on every run (`tests/runs/execute.test.ts`); the markup rules have no test of their own |
| 7 | **Staff sign-in** | Passwords, lockout, codes by text or email, trusted workstations, idle and early expiry | every end-to-end run signs in with a person's code (`tests/runs/execute.test.ts`); lockout and code expiry have no test |
| 8 | **Sign-in pages and the hand-off** | The loading shell, both sign-in layouts, the code chooser, the hand-off page | a full sign-in through the pages |
| 9 | **The console** | The frameset, banner and nav, member search, the member summary, activity, and the decoys in plain view | on every bank, member search finds the member and the tiles match the ledger (`apps/bank/test/redesign.test.ts`) |
| 10 | **Statements pages** | The account picker, the statement table, the PDF window | the driver presses the button and stores the PDF it returns (`tests/runs/execute.test.ts`) |
| 11 | **Transfers** | The form, the review page, supervisor approval over the threshold | a transfer posts end to end |
| 12 | **Hazards in the pages** | Every hazard wired into the pages that show it | one test per forced hazard |
| 13 | **The inbox and ground truth** | The fake inbox for codes; the bank-admin API the tests read | codes arrive; tests read the ledger, not the page |
| 14 | **Running it** | Compose wiring, the operator passwords as secrets, the inbox service | `just up`, in the fresh-clone check; the bank's memory is not measured |
