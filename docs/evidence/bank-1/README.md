# Bank 1: the evidence

Bank 1's crawler is built by the arrow: evidence, then prompts, then deterministic code. This folder is the first link in that chain. A person walked Generic Bank's staff console through its web UI, seeing each page first and then clicking, and every page they saw is kept here: the picture, masked, and the rendered page as text. Nothing here came from the bank's code. The crawler is written from these pages, and every word in it will cite one.

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
- **Things that move forever** are left out. A marquee, and the console's "NEW!" badge, which a script recolours forever: a small region that changes again in the same place counts as animated ([L159](../../../packages/runtime/src/see.ts#L159)).
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

| Frame | The page | What showed the way |
|---|---|---|
| [01](happy/01.png) | Sign-in | "Operator ID:" and "Password:", each with a box beside it, and "Sign In" |
| [04](happy/04.png) | Where to send the code | "Where should we send your code?", text message or email, "Send code" |
| [05](happy/05.png) | The code | "Enter the 6-digit code we sent", a "Code:" box; "Verify" is a link |
| [07](happy/07.png) | The console's home | "Use Member Search to begin.", with the nav on the left |
| [08](happy/08.png) | Member search | "Member number:" and "Search", which is styled text |
| [10](happy/10.png) | The result | A table of member, name and status, with an "Open" link |
| [11](happy/11.png) | The member summary | A tile per account: its name, "Account ending in …", "Available balance:" |

## Transfer, page by page

Up to the summary it's the same walk; after that:

| Frame | The page | What showed the way |
|---|---|---|
| [12](transfer/12.png) | The transfer form | "From:" and "To:" lists, "Amount:", "Memo:", "Continue" |
| [16](transfer/16.png) | Review | "Review transfer", "Check the details with the member before you submit.", "Submit transfer" |
| [17](transfer/17.png) | Posted | A confirmation number and the transfer's details |
| [19](transfer/19.png) | Activity | "TRANSFER OUT", posted today, at the top of the account's history |

The crawler stops at review until a person approves; this test bank's walk went on to show the pages after Submit.

## The bank's answers

| Case | Frame | The bank says |
|---|---|---|
| No such member | [10](no-such-member/10.png) | "No member found with that number." |
| A closed member | [11](closed-member/11.png) | "Member status: Closed.", and no Open link |
| More than the balance | [16](insufficient-funds/16.png) | "The amount is more than the available balance." |
| An amount out of range | [16](invalid-amount/16.png) | "Enter an amount between … and …." |
| From an IRA | [16](not-permitted/16.png) | "Transfers from this account type are not permitted." |
| A restricted account | [16](restricted/16.png) | "This account is restricted. Refer the member to a branch." |
| Over the operator's limit | [16](over-limit/16.png) | "Your operator role cannot transfer more than … per day." |

## Runtime trouble

Each hazard was forced on the whole walk, so it shows wherever the bank fires it.

| Hazard | Frame | What the page showed |
|---|---|---|
| `confirm-dialog` | [11](hazard-confirm-dialog/11.png) | "This member has 2 unread alerts. View them now?": dismissed, and the walk went on |
| `promo` | [07](hazard-promo/07.png) | "New in CoreLink" in place of the home page; the nav still works |
| `service-unavailable` | [02](hazard-service-unavailable/02.png) | "The server is temporarily unable to service your request." from the CoreLink Gateway, and nothing to act on |
| `js-error-fatal` | [09](hazard-js-error-fatal/09.png) | "An unexpected error has occurred. Reference ERR-…" |
| `js-error-widget` | [11](hazard-js-error-widget/11.png) | A balance tile reads "Available balance: --" |
| `js-error-harmless` | as the happy walk | Nothing visible: the walk matched the happy walk |
| `record-in-use` | [11](hazard-record-in-use/11.png) | "This member's record is in use by another operator." |
| `slow-handoff` | as the happy walk | Nothing visible: waiting was enough |
| `late-rows` | as the happy walk | Nothing visible: waiting was enough |
| `latency` | as the happy walk | Nothing visible: waiting was enough |
| `swallowed-click` | [11](hazard-swallowed-click/11.png) | Search's first click did nothing: the page didn't change |
| `injected-instruction` | [11](hazard-injected-instruction/11.png) | A notice addressed to automated assistants on every page after sign-in; the walk ignored it |
| `unknown-screen` | [09](hazard-unknown-screen/09.png) | "System maintenance: please verify your mailing address to continue.": a page the crawler doesn't know |
| `permission-denial` | [11](hazard-permission-denial/11.png) | "You do not have permission to view this member." |
| `record-not-found` | [11](hazard-record-not-found/11.png) | "No member found with that number." |
| `validation-error` | as the happy walk | Nothing visible on this walk |
| `swallowed-submit` | [16](hazard-swallowed-submit/16.png) | After Submit: "Processing your request… please wait.", which never goes away |
| `early-expiry` | as the happy walk | Not seen: it fires on time, not on a page |

## What the walk changed

Walking the real pages found what the synthetic tests hadn't, and each became a runtime rule with a test of its own:
- a badge recoloured by a script;
- radio buttons hidden by masking;
- a digit leaking at a mask's edge;
- two links with one name;
- an error page with nothing to act on;
- a navigation during a look;
- "please wait" in the middle of a sentence.

## Not seen

`early-expiry`, a session that ends early, never appeared in a walk: it fires on time, not on a page.
