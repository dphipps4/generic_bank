# Bank 1: the evidence, and the crawler written from it

Bank 1's crawler comes out of the arrow: first the evidence, then plain deterministic code written from it. A person walked Generic Bank's staff console through its web UI, looking at each page before clicking anything, and every page they saw is kept here: the masked picture, and the rendered page as text. None of it came from the bank's code.

The second half is the crawler itself: the words that give each page away, what the crawler does there, and what the bank's answers mean. Every one of those points back at the frame it was read from.

## How it was made

| Piece | Where | What it does |
|---|---|---|
| The steps | [`tests/evidence/bank1.json`](../../../tests/evidence/bank1.json) | What the teller did, one scenario at a time, each step written after looking at the page before it |
| The walk | [`tests/evidence/bank1.walk.ts`](../../../tests/evidence/bank1.walk.ts#L79) | Runs a scenario's steps against bank 1 and keeps a frame after every step |
| What a teller is given | [`value()`](../../../tests/evidence/bank1.walk.ts#L52) | The sign-in, the code from their phone, the member's number: never read off a page |
| What is never kept | [`known()`](../../../tests/evidence/bank1.walk.ts#L62) | Every seeded name and secret, handed to the masking |
| A failed step | [the walk's `catch`](../../../tests/evidence/bank1.walk.ts#L126) | Where a step couldn't be done is evidence too: the page shown instead is kept |

Each walk is one file, `<walk>.json`, with every frame's steps, page text, controls and dialogs; its pictures are in the folder of the same name. A frame the happy walk already kept word for word is a pointer to it.

To walk a scenario again: `WALK=happy npx vitest run -c vitest.evidence.config.ts`. It needs a Chrome (`just browser`). Bank 1 runs in-process, so no Docker stack is needed.

## How a page is seen, then acted on

The walk uses the same runtime the crawler will: [`packages/runtime`](../../../packages/runtime/README.md).

**Seeing a page,** in [`see()`](../../../packages/runtime/src/see.ts#L136):
- **Ready** when two pictures 700 ms apart are alike, nothing says loading, and there's something to act on, or words that have held still for three looks ([L164](../../../packages/runtime/src/see.ts#L164)).
- **Things that move forever** are left out. A marquee, and the console's "NEW!" badge, which a script recolors forever: a small region that changes again in the same place counts as animated ([L159](../../../packages/runtime/src/see.ts#L159)).
- **A navigation mid-look** just means look again ([L148](../../../packages/runtime/src/see.ts#L148)).
- **A page that never becomes ready** stops the run, saying what it showed ([L170](../../../packages/runtime/src/see.ts#L170)).
- **Then it keeps:** the masked picture ([L177](../../../packages/runtime/src/see.ts#L177)), each frame's rendered accessibility tree, which holds only what's visible ([L184](../../../packages/runtime/src/see.ts#L184)), and the visible controls by role, read with Playwright's own selectors, so no script of ours runs in the bank's page ([L189](../../../packages/runtime/src/see.ts#L189)).
- **Knowing a page** by the words visible on it ([`knows()`](../../../packages/runtime/src/see.ts#L240)).

**Acting,** in [`act.ts`](../../../packages/runtime/src/act.ts):
- [`field()`](../../../packages/runtime/src/act.ts#L27): a field by its drawn label, then the box beside it. Bank 1's labels sit in a table cell of their own, with nothing linking them to the box.
- [`control()`](../../../packages/runtime/src/act.ts#L53): a button by its drawn name, whatever the page built it from. Bank 1's "Search" is a styled `<font>` ([L64](../../../packages/runtime/src/act.ts#L64)). Where two share a name, as "Transfer Funds" does in the nav and in the member summary, it picks the one nearest the section a person means ([L68](../../../packages/runtime/src/act.ts#L68)).
- [`press()`](../../../packages/runtime/src/act.ts#L92): Playwright's click with the real mouse, refused if anything covers the control.
- [`choose()`](../../../packages/runtime/src/act.ts#L112): an account by its name, among options like "Everyday Checking, Account ending in …".

**Masking,** in [`mask.ts`](../../../packages/runtime/src/mask.ts), before anything is kept:
- Money, long numbers, and every seeded name and secret, painted out of the picture character by character, from the browser's own layout ([L91](../../../packages/runtime/src/mask.ts#L91), [L99](../../../packages/runtime/src/mask.ts#L99)).
- Frames from other origins are read through their own sessions ([L118](../../../packages/runtime/src/mask.ts#L118)).
- A field is covered only when its value is one to mask, so radio buttons still show which choice was made ([L83](../../../packages/runtime/src/mask.ts#L83)).
- The same values are masked in the page text and the address.

**The browser,** in [`browser.ts`](../../../packages/runtime/src/browser.ts): Chrome without the automation switches ([L43](../../../packages/runtime/src/browser.ts#L43)), presenting as Chrome on a Mac ([L96](../../../packages/runtime/src/browser.ts#L96)). Surprise dialogs are dismissed and recorded ([L116](../../../packages/runtime/src/browser.ts#L116)).

## Check balance, page by page

Frame NN is the page as it stood after step NN.

| Frame | The page | Known by | The crawler does |
|---|---|---|---|
| [01](happy/01.png) | Sign-in | "Operator ID:" and "Password:" | Types the operator's ID and password into the boxes beside those labels, then presses "Sign In" |
| [04](happy/04.png) | Where to send the code | "Where should we send your code?" | "Text message" is already chosen; presses "Send code" |
| [05](happy/05.png) | The code | "Enter the 6-digit code we sent" | Asks a person for the code the staff phone received, types it beside "Code", presses "Verify" (a link) |
| [07](happy/07.png) | Home | "Use Member Search to begin." | Presses "Member Search" in the nav |
| [08](happy/08.png) | Member search | "Member number:", and no "Open" | Types the member's number, presses "Search" (styled text, not a button) |
| [10](happy/10.png) | A member found | "Member number:" and an "Open" link | Presses "Open" |
| [11](happy/11.png) | Member summary | "Member Summary" and "Available balance:" | Reads the tile holding the account's name, or "Account ending in" and its last four: "Available balance:" and "Current balance:" |

## Transfer, page by page

Up to the summary it's the same walk; after that:

| Frame | The page | Known by | The crawler does |
|---|---|---|---|
| [11](happy/11.png) | Member summary | as above | Presses the "Transfer Funds" nearest "Member Summary"; the nav has one too |
| [12](transfer/12.png) | Transfer form | "From:", "Amount:" and "Continue" | In "From" and "To", chooses the option holding the account's name or last four (options read "Everyday Checking, Account ending in …, available …"); types the amount and the memo; presses "Continue" (styled text) |
| [17](transfer/17.png) | Review | "Review transfer" | Reads From, To, Amount and Memo, and hands them to a person to approve with the member |
| [18](transfer/18.png) | Posted | "Transfer posted" | Reads the confirmation number |
| [20](transfer/20.png) | Activity | "Activity:" and "Description" | Reached from home again, by the same rows to the summary, then the "Activity" nearest the from-account. Finds the transfer by its memo token |

"Submit transfer" is pressed only after a person approves, and only once. This is a test bank, so the walk went on past Submit to show the pages after it.

The summary also offers "Waive fee", "Change address", "Close account" and others ([happy/11](happy/11.png)). The crawler never presses them: it presses only the names in these tables.

## The memo

The transfer form has a "Memo:" box ([transfer/12](transfer/12.png)). The API takes an optional memo, the member's own words, and the crawler types it after a short token minted for the run: `GBX 7K2Q rent`, say.

The bank shows the memo on the review page ([transfer/17](transfer/17.png)), on the posted page ([transfer/18](transfer/18.png)), and in the account's activity, beside "TRANSFER OUT" ([transfer/20](transfer/20.png)). That last one is what matters. If Submit hangs, pressing it again could move the money twice. So the crawler doesn't; it opens the from-account's activity and looks for the token: one row means the transfer went through, none means it didn't, and either way Submit is never pressed again.

## The bank's answers

These are checked on every page, before anything else. Each is a business outcome, and the API returns it as one. It isn't a failure.

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
| "This member's record is in use by another operator." | `record_in_use`, worth retrying later | [hazard-record-in-use/11](hazard-record-in-use/11.png) |

## Trouble, and what the crawler does

Each hazard was forced on the whole walk, so it shows wherever the bank fires it. None of this needs an agent. It's a few words to match and one fixed thing to do.

| Hazard | What the page showed | The crawler does |
|---|---|---|
| `confirm-dialog` | "This member has 2 unread alerts. View them now?" ([11](hazard-confirm-dialog/11.png)) | The runtime dismisses it and records it; nothing is committed |
| (none) | A code typed after its five minutes: "That code has expired." ([01](code-expired/01.png), from a live run in Docker) | Presses "Send a new code"; the code page then asks a person for the new one |
| `promo` | "New in CoreLink" in place of home ([07](hazard-promo/07.png)) | Treats it as home: presses "Member Search" in the nav |
| `service-unavailable` | "The server is temporarily unable to service your request." ([02](hazard-service-unavailable/02.png)) | Starts again from home, at most twice, never after Submit; then `unavailable` |
| `js-error-fatal` | "An unexpected error has occurred. Reference ERR-…" ([09](hazard-js-error-fatal/09.png)) | The same; then `app_error` |
| `js-error-widget` | A tile reads "Available balance: --" ([11](hazard-js-error-widget/11.png)) | Starts again from home, once; then `app_error` |
| `swallowed-click` | Search's first click did nothing ([11](hazard-swallowed-click/11.png)) | The same page comes back, so its row runs again |
| `swallowed-submit` | After Submit, "Processing your request… please wait." forever ([16](hazard-swallowed-submit/16.png)) | Never presses again: looks for the memo token in the activity |
| `unknown-screen` | "System maintenance: please verify your mailing address to continue." ([09](hazard-unknown-screen/09.png)) | No row matches: stops with `unknown_screen` and hands the picture to a person |
| `injected-instruction` | A notice addressed to automated assistants on every page ([11](hazard-injected-instruction/11.png)) | Nothing: page text only ever picks a row, never an action |
| `record-not-found` | "No member found with that number." ([11](hazard-record-not-found/11.png)) | `no_such_member` |
| `latency`, `slow-handoff`, `late-rows` | Nothing visible: waiting for the page to be ready was enough | Nothing more |
| `js-error-harmless`, `validation-error` | Nothing visible on this walk | Nothing more |

## The crawler

It's a table and a loop. That's all of it.

**The table** ([`bank1.ts`](../../../packages/crawler/src/bank1.ts#L8), its shape in [`table.ts`](../../../packages/crawler/src/table.ts)) is the page-by-page rows above, written as data: each row has the words that show a page and the steps to take there, in the same step language the walk uses (type, choose, press, read). Values such as the member's number and the amount come from the task; the code comes from a person. Every row cites its frame.

**The loop** ([`crawl()`](../../../packages/crawler/src/crawl.ts#L117)) runs any table:
1. Look at the page, which the runtime keeps as a masked frame ([`see()`](../../../packages/runtime/src/see.ts#L136)).
2. If it says one of the bank's answers, return that outcome ([L149](../../../packages/crawler/src/crawl.ts#L149)).
3. If it shows trouble, start again from home, a few times at most, and never after Submit ([L151](../../../packages/crawler/src/crawl.ts#L151)).
4. Otherwise find the one row whose words it shows ([`knows()`](../../../packages/runtime/src/see.ts#L240)), and do that row's steps for the goal ([L171](../../../packages/crawler/src/crawl.ts#L171)). The goal's own page ends the crawl ([L166](../../../packages/crawler/src/crawl.ts#L166)).
5. No row matches: stop with `unknown_screen`.

The loop goes by what's on screen, not by the order it expects. A promo where home should be, a click the bank swallowed, a reload that lands somewhere odd: none of it needs special code, because whatever page shows up gets its row. If the same page comes back three times running, the crawler is stuck, and it tells a person ([L169](../../../packages/crawler/src/crawl.ts#L169)). Starting again means opening the console's home: a fresh request, never a reload, so nothing is ever sent twice ([L129](../../../packages/crawler/src/crawl.ts#L129)).

Values are read with [`read()`](../../../packages/runtime/src/see.ts#L258), which returns the page's visible text unmasked and keeps nothing; only `see()` keeps evidence.

**Submit is outside the table.** [`prepareTransfer()`](../../../packages/crawler/src/crawl.ts#L236) stops at review and hands From, To, Amount and Memo to a person. Once they approve, [`submitTransfer()`](../../../packages/crawler/src/crawl.ts#L252) presses "Submit transfer" once and reads the confirmation if the posted page comes. Then, hung or not, it crawls to the from-account's activity ([L268](../../../packages/crawler/src/crawl.ts#L268)). Exactly one row with the memo is success; none or two, and a person checks ([L271](../../../packages/crawler/src/crawl.ts#L271)).

**Its tests.** [`table.test.ts`](../../../packages/crawler/test/table.test.ts) holds the table against this evidence, with no browser: every row knows its own frame as its page and no other, and every answer and trouble is in the frame it cites. [`tests/crawler/bank1.test.ts`](../../../tests/crawler/bank1.test.ts) runs the crawler against bank 1 in a browser and checks it against the bank's ledger: a balance by name and by last four, a transfer through review to the activity, three of the bank's answers, a promo with a dialog and a swallowed click, an error page, an outage, an unknown page, and a hung Submit. Each test gets a bank of its own, because every run signs in as the same teller and a new code replaces the last. `CRAWL_FRAMES=<file>` writes every page a test's crawler saw.

When the bank changes its pages, repair means editing rows, not code. And the factory's Scout writes the same kind of table for a bank it's learning, which is the point.

## The runner

The runner carries out each task run with this crawler ([`executeRun()`](../../../apps/runner/src/execute.ts#L49)):
- **Every page the crawler sees** becomes a step and a stored frame: the masked picture, and the visible tree and controls ([L90](../../../apps/runner/src/execute.ts#L90)).
- **The code** for the staff phone comes from a person, through the Console ([L142](../../../apps/runner/src/execute.ts#L142)).
- **Every action** passes the job's allowlist first ([L146](../../../apps/runner/src/execute.ts#L146), [`runGuard()`](../../../apps/runner/src/guard.ts#L19)). Each row names the allowlist's screen it stands for, and [`table.test.ts`](../../../packages/crawler/test/table.test.ts) checks every step of the table against the allowlist, with no browser. The first refusal trips the guard and freezes the bank.
- **A transfer** ([`runTransfer()`](../../../apps/runner/src/transfer.ts#L87)) parks at review for a person's approval. Just before the one press, the grant is consumed against what the review page shows, and the intent is written to the trail ([L153](../../../apps/runner/src/transfer.ts#L153)). A run that resumes after that point reads the history and never presses again ([L169](../../../apps/runner/src/transfer.ts#L169)).
- **A page the crawler doesn't know** takes its version out of service and opens a repair case, unless a hazard was forced in the lab.

## What the walk changed

Walking the real pages turned up things the synthetic tests never had. Each one became a runtime rule, with its own test:
- a badge recolored by a script;
- radio buttons hidden by masking;
- a digit leaking at a mask's edge;
- two links with one name;
- an error page with nothing to act on;
- a navigation during a look;
- "please wait" in the middle of a sentence.

## Not seen

`early-expiry`, a session that ends early, never appeared in a walk: it fires on time, not on a page.

A refused sign-in or a wrong code never appeared either. The crawler would see the sign-in or the code page come back, and after three times it stops as stuck, for a person to look at.
