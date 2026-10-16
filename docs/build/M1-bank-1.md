# M1: Bank 1

Generic Bank becomes a working staff console: a ledger, staff sign-in with codes, member
lookup, balances, activity, statements, and transfers with supervisor approval. The markup is
old-fashioned on purpose, and the tests can force hazards. The plan's
[Appendix C](../plan/GENERIC_BANK_PLAN.md#appendix-c-generic-bank-the-target-product) is the
specification.

It lands as a series of small pull requests. Each stands alone, has its own tests and leaves
`just check` green.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **Tenant config and the bank's database** | Every difference between the four banks in one config; the bank's schema; Postgres in the containers, PGlite in tests | the schema migrates twice without change |
| 2 | **The seed** | Staff accounts, 25 fictional members with one for every case the brief names, twelve months of history | the seed is identical on every run and runs only once |
| 3 | **The ledger and transfer rules** | Balances computed from the double-entry ledger; the bank's checks in its own words; posting a transfer atomically | the ledger always sums to zero; every refusal has a test |
| 4 | **Statements** | One PDF per month, built from the ledger on request | twelve months listed; the PDF opens |
| 5 | **Runtime hazards** | Ambient hazards at the plan's rates in three profiles; forced hazards by a signed header | the same seed gives the same hazards; an unsigned header is refused |
| 6 | **Markup dialects** | Nested tables, four submit dialects, split labels, hashed class names, field names random per session | no ids, no `data-*`, no `<label for>`; the same tenant renders the same markup |
| 7 | **Staff sign-in** | Passwords, lockout, codes by text or email, trusted workstations, idle and early expiry | lockout after five failures; code expiry and tries |
| 8 | **Sign-in pages and the hand-off** | The loading shell, both sign-in layouts, the code chooser, the hand-off page | a full sign-in through the pages |
| 9 | **The console** | The frameset, banner and nav, member search, the member summary, activity, and the decoys in plain view | lookup answers for every member case; tiles drawn by script; pressing a decoy is a visible state change |
| 10 | **Statements pages** | The account picker, the statement table, the PDF window | the button's URL returns the PDF |
| 11 | **Transfers** | The form, the review page, supervisor approval over the threshold | a transfer posts end to end |
| 12 | **Hazards in the pages** | Every hazard wired into the pages that show it | one test per forced hazard |
| 13 | **The inbox and ground truth** | The fake inbox for codes; the bank-admin API the tests read | codes arrive; tests read the ledger, not the page |
| 14 | **Running it** | Compose wiring, the operator passwords as secrets, the inbox service | `just up`; the bank fits its memory limit |
