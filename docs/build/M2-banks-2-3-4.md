# M2: Banks 2, 3 and 4

One product, four banks. Bank 1 comes from M1, and this milestone builds the other three. Each
varies the way one vendor's product does from one institution to the next: brand and labels,
layout, URL shape, account wording, thresholds, the code step, text drawn as images, and failure
modes of its own. All four run the same code, each started with its own tenant config. The plan's
[Appendix C](../plan/GENERIC_BANK_PLAN.md#appendix-c-generic-bank-the-target-product) is the
specification.

Banks 1 and 2 get working drivers in the submission. Banks 3 and 4 are left for the factory to
crawl, so they carry trouble that banks 1 and 2 never show.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **Every label from the tenant** | Each page's words come from the tenant config, nothing hard-coded to Generic Bank; the four themes | every bank's pages use only its own labels |
| 2 | **Layout variants** | The console layout as a tenant setting: Bank 1's nav frame, Bank 2's tab strip across the top, Bank 3's extra notices frame, Bank 4's menu bar with no frameset | each bank's console has its own shape |
| 3 | **A second origin** | Bank 2's tab strip and Bank 4's sign-in form served from another origin, so they are cross-origin frames | the frame's origin differs from the page's |
| 4 | **Text drawn as images** | Bank 2's labels and its Confirm button, Bank 3's section headings, as pixels only | the words are absent from the markup |
| 5 | **Bank 2, Example Credit Union** | Email-only codes, "Find Member", "Move Money", the Confirm image, $1,000 approval | a full sign-in and transfer through Bank 2's pages |
| 6 | **Bank 3, Sample Savings Bank** | Member Inquiry by number or last name, the "Terms updated: Acknowledge" page after sign-in, $500 approval, and its trouble: a hidden copy of the password field, a key-press-only field, notices and tax forms among statements, "View more statements", a menu drawn away from its row, a notice bar over the submit control | one test per trouble |
| 7 | **Bank 4, Placeholder Federal Credit Union** | An authenticator-style code, search results in a popup window, a transfer split over Amount, Accounts and Authorize, approval always for transfers between members, and its trouble: a hand-off that bounces back, a code field cleared without a message, an HTML statement viewer, per-window statement tokens, tiles in a new order on every load, a false "Bill pay unavailable" | one test per trouble |
| 8 | **Running all four** | `just bank-more`, the inbox showing all four, each bank's memory measured | all four banks seeded and browsable |
