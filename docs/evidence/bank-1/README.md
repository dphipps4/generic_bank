# Bank 1: the evidence, and the crawler written from it

Generic Bank's staff console was walked through its web UI, one step at a time, looking at each page before touching anything. Every page the walk saw is kept here: the masked picture, plus the page as text. None of it came from the bank's code. Bank 1's route, the data its crawler replays, was written from these pages, and every row of it points back at the frame it came from.

**How it was made.** The frames were captured once, by a browser walk of bank 1. It went one scenario at a time, each step written after looking at the page before it, and kept a frame after every step. A teller's sign-in, code and member number were handed to the walk and never read off a page, and every seeded name and secret was masked. A step that failed is evidence too: the page shown instead is kept. Each walk is a file, `<walk>.json`, with its pictures in the folder of the same name.

**How a page is seen and acted on** is the runtime's job. It waits until the page holds still, masks money, long numbers and every seeded name, finds a field by its drawn label and a button by its drawn name, and clicks with the real mouse.

Frame NN is the page as it stood after step NN.

## Check balance, page by page

| Frame | The page | Known by | The crawler does |
|---|---|---|---|
| [01](happy/01.png) | Sign-in | "Operator ID:" and "Password:" | Types the operator's ID and password, presses "Sign In" |
| [trusted/09](trusted/09.png) | Sign-in, workstation remembered | "Welcome back" and "Password:" | Types the password, presses "Sign In": no code needed for 30 days |
| [04](happy/04.png) | Where to send the code | "Where should we send your code?" | Presses "Send code" ("Text message" is already chosen) |
| [05](happy/05.png) | The code | "Enter the 6-digit code we sent" | Asks a person for the code the staff phone got, types it, presses "Verify" |
| [07](happy/07.png) | Home | "Use Member Search to begin." | Presses "Member Search" |
| [08](happy/08.png) | Member search | "Member number:", and no "Status" | Types the member's number, presses "Search" (styled text, not a button) |
| [10](happy/10.png) | A member found | "Member number:" and "Status" | Presses "Open" |
| [11](happy/11.png) | Member summary | "Member Summary" and "Available balance:" | Reads the account's tile: "Available balance:" and "Current balance:" |

The runner keeps each bank's cookies between runs, so a person enters a code once, and the bank remembers the workstation for 30 days.

## Transfer, page by page

The same pages up to the summary, then:

| Frame | The page | Known by | The crawler does |
|---|---|---|---|
| [11](happy/11.png) | Member summary | as above | Presses the "Transfer Funds" nearest "Member Summary" (the nav has one too) |
| [12](transfer/12.png) | Transfer form | "From:", "Amount:" and "Continue" | Chooses From and To by the account's name or last four, types the amount and memo, presses "Continue" |
| [17](transfer/17.png) | Review | "Review transfer" | Reads From, To, Amount and Memo, and hands them to a person to approve |
| [18](transfer/18.png) | Posted | "Transfer posted" | Reads the confirmation number |
| [20](transfer/20.png) | Activity | "Activity:" and "Description" | Finds the transfer by its memo token |

"Submit transfer" is pressed only after a person approves, and only once. The summary also offers "Close account" ([happy/11](happy/11.png)); the crawler never presses it, because it presses only the names in its route, and the allowlist would refuse it anyway.

**The memo.** The crawler types the member's memo after a short token minted for the run: `GBX 7K2Q rent`. The bank shows it on review, on the posted page and in the activity, beside "TRANSFER OUT" ([transfer/20](transfer/20.png)). That's what makes a hung Submit safe. Pressing again could move the money twice, so the crawler never does: it opens the activity and looks for the token. One row means it went through, none means it didn't, two means a person checks.

## The bank's answers

Checked on every page, before anything else. Each is a business outcome, not a failure.

| The page says | The API's outcome | Frame |
|---|---|---|
| "No member found with that number." | `no_such_member` | [no-such-member/10](no-such-member/10.png) |
| "Member status: Closed." (and no Open link) | `member_closed` | [closed-member/11](closed-member/11.png) |
| "The amount is more than the available balance." | `insufficient_funds` | [insufficient-funds/16](insufficient-funds/16.png) |
| "Enter an amount between … and …." | `invalid_amount` | [invalid-amount/16](invalid-amount/16.png) |
| "Transfers from this account type are not permitted." | `permission_denied` | [not-permitted/16](not-permitted/16.png) |
| "This account is restricted. Refer the member to a branch." | `account_restricted` | [restricted/16](restricted/16.png) |
| "Your operator role cannot transfer more than … per day." | `limit_exceeded` | [over-limit/16](over-limit/16.png) |
| "You do not have permission to view this member." | `permission_denied` | [hazard-permission-denial/11](hazard-permission-denial/11.png) |
| "This member's record is in use by another operator." | `record_in_use`, worth retrying | [hazard-record-in-use/11](hazard-record-in-use/11.png) |

## Trouble, and what the crawler does

Each hazard was forced on the whole walk. None of this needs an agent: a few words to match, one fixed thing to do.

| Hazard | What the page showed | The crawler does |
|---|---|---|
| `confirm-dialog` | "This member has 2 unread alerts. View them now?" ([11](hazard-confirm-dialog/11.png)) | The runtime dismisses it and records it |
| (none) | A code typed after it expired: "That code has expired." ([01](code-expired/01.png), from a live run) | Presses "Send a new code", then asks a person for the new one |
| `promo` | "New in CoreLink" in place of home ([07](hazard-promo/07.png)) | Treats it as home: presses "Member Search" |
| `service-unavailable` | "The server is temporarily unable to service your request." ([02](hazard-service-unavailable/02.png)) | Starts again from home, at most twice, never after Submit; then `unavailable` |
| `js-error-fatal` | "An unexpected error has occurred. Reference ERR-…" ([09](hazard-js-error-fatal/09.png)) | The same; then `app_error` |
| `js-error-widget` | A tile reads "Available balance: --" ([11](hazard-js-error-widget/11.png)) | Starts again from home, once; then `app_error` |
| `swallowed-click` | Search's first click did nothing ([11](hazard-swallowed-click/11.png)) | The same page comes back, so its row runs again |
| `swallowed-submit` | "Processing your request… please wait." forever ([16](hazard-swallowed-submit/16.png)) | Never presses again: looks for the memo token |
| `unknown-screen` | "System maintenance: please verify your mailing address to continue." ([09](hazard-unknown-screen/09.png)) | No row matches: stops with `unknown_screen`, for a person |
| `injected-instruction` | A notice addressed to automated assistants ([11](hazard-injected-instruction/11.png)) | Nothing: page text only picks a row, never an action |
| `record-not-found` | "No member found with that number." ([11](hazard-record-not-found/11.png)) | `no_such_member` |
| `latency`, `slow-handoff`, `late-rows` | Nothing visible: waiting for the page was enough | Nothing more |
| `js-error-harmless`, `validation-error` | Nothing visible on this walk | Nothing more |
| `early-expiry` | Never seen on a walk: it fires on time, not on a page | Not shown here |

## The crawler: a route and a loop

**The route** is the rows above as data: the words that identify each page, and the steps to take there (type, choose, press, read). The task supplies the member and the amount; a person supplies the code.

**The loop** replays any route. It looks at the page, returns the bank's answer if there is one, starts again from home on trouble, and otherwise does the steps of the one row whose words show. No row matches: `unknown_screen`. The same page three times: stuck, for a person. It goes by what's on screen, not by the order it expects, so a promo or a swallowed click needs no special code. Starting again opens home afresh, never a reload, so nothing is sent twice.

**Submit is outside the route.** The crawler stops at review. Once a person approves, it presses once, then reads the activity.

**The runner** turns every page into a step and a stored frame, gets the code from a person through the Console, and passes every action through the job's allowlist first: the first refusal freezes the bank. A transfer spends its grant against what the review page shows, just before the one press.

**Its tests** check every row against the words of its frame and every step against the allowlist, with no browser, then run the crawler in a browser against bank 1's ledger.

When bank 1 changes a page, its route is fixed by hand, one row at a time. The factory writes the same kind of route for a bank it learns. [The code walkthrough](../../code.md) shows where each part lives.
