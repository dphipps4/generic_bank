# A walk through the code

Generic Bank gives an AI agent an API for checking a balance or moving money at banks that have no API of their own. Behind the API, a crawler drives each bank's staff console through its web UI, the way a teller would.

One idea runs through the whole codebase. A bank's crawler is data, called a route. The route lists the bank's screens, the words that recognize each one, and the steps a person takes on it. One loop of ordinary code replays any route, and no model takes part. Bank 1's route was written by hand from recorded evidence. Bank 2's route is produced by the factory, where two agents explore the live bank and write the route as they go. The agents produce data, and code replays it with no model.

This page walks the code in reading order. Each part gives what the part does, its key files, the one decision behind it and the alternative that was not chosen, and the prompt that built it. The prompts are numbered as in the condensed prompt list.

## The banks: `apps/bank`

**What it does.** This is the target system: CoreLink, a bank staff console in the style of 2003. It has framesets, nested tables, no element ids, and a different submit style on each page. A teller signs in with a staff ID and a password, then types a code sent to a simulated phone or email inbox. The teller can search for a member, open the member's summary of accounts, see an account's activity, and fill in a transfer that stops on a review page. A transfer over a threshold needs a supervisor's code. The bank also misbehaves on purpose: slow pages, script errors, 503s, a surprise confirmation dialog, a record in use, and the other kinds of trouble the brief names.

**Key files.** `tenants.ts` holds every difference between the two banks: brand, labels, theme, layout, thresholds, code channels, and the redesign that `BANK_REDESIGN` switches on. `routes/signin.ts`, `routes/console.ts` and `routes/transfer.ts` draw the pages. `markup/dialect.ts` gives each page its own markup style, fixed by a seed, and `markup/pixels.ts` draws some labels as images, from a small pixel font, so they exist nowhere as text. `hazards.ts` holds the ambient and forced hazards. A forced hazard arrives in a signed header, and `HAZARD_RUN_RATE_PCT` sets how often ambient hazards happen. `botscreen.ts` turns away any request not shaped like Chrome on a Mac. `inbox.ts` is the staff inbox that people read, and `admin.ts` serves the ledger to tests on its own port.

**The decision.** There is one product and two tenants, configured in one file, rather than two separate sites. Real credit unions run the same vendor product with different settings, so a crawler that carries over to a new tenant is the brief's real test. A vendor upgrade then becomes a switch, `BANK_REDESIGN`, instead of a rewrite. Two hand-written sites would differ in ways no vendor would ever ship, and would prove nothing about carrying over.

**Built by prompt 3.**

## The runtime: `packages/runtime`

**What it does.** This is the one small layer on Playwright that every crawler and the factory share. It sees a page first and acts on it second.

- *Readiness* is in `see` in `see.ts`. A page is ready when its picture holds still from one look to the next, leaving out small regions that keep flashing. Nothing on the page may say it is loading, and there must be something to act on. A blank page that holds still is not ready. A page that never becomes ready raises `NotReady`.
- *Evidence* is the `Frame` that `see` returns. It holds the masked picture, the visible accessibility tree, the visible controls (each with a role, a name and a box), the masked address, and any JavaScript dialogs the page showed. The browser dismisses those dialogs itself, in `newPage` in `browser.ts`.
- *Masking* follows one rule, written in `rule.ts` with no browser in it, so that every view applies the same rule. A long number keeps its last four digits. Money is hidden whole. Any name or secret the run knows is hidden whole. What the bank already hides stays as the bank drew it. Each hidden character becomes `█`. `mask.ts` paints exactly those characters out of the picture, using the browser's own text layout read over DevTools.
- *Knowing the screen* is `knows` in `see.ts`. A page matches an expected screen when it shows all of that screen's words, none of its never-words, and every one of its pictures. Exactly one screen must match. Otherwise the result is `UnknownPage`, which names the closest screens.
- *Acting by words* is in `act.ts`. `field` finds a field by its label's drawn text and then the box beside it. `control` finds a button or link by its drawn name, and `near` breaks a tie between two of the same name. `press`, `type` and `choose` act with Playwright's real mouse and keyboard. Exactly one target must match, or the result is a `TargetError` that says what was found.
- *Acting by sight* is in `hands.ts` and `match.ts`. `whatIsAt` asks the browser, over DevTools, what kind of control is at a point. `clickAt`, `typeAt` and `chooseAt` act at a point. `findCrop` finds a small cut-out of the screen again in a fresh screenshot, by normalized cross-correlation. A match counts only when it scores at least `MATCH.min` and leads the next-best place by `MATCH.lead`. An unclear match is no match, never a guess.
- *Identity* is set in `newPage` in `browser.ts`. It sets the user agent and the client hints of standard Chrome on an Apple-silicon Mac, from outside the page, and nothing more.

**The decision.** A crawler acts by what is drawn: a visible name, or a picture of a label plus an offset. It never uses CSS selectors or DOM paths. Selectors break with any markup change, and they cannot see a label that exists only as pixels. Acting by what is drawn is how a person works, and it survives the bank's own dialect changes from page to page.

**Built by prompt 4.**

## The route and the loop: `packages/crawler`

**What it does.** `table.ts` defines the route format. The code type is named `Table`, and this page calls it a route. A route has these parts:

- `rows`, one per screen. Each row holds the words the screen `shows`, the words it is `never` shown with, any `looks` (cut-outs of words drawn as pictures), its `screen` (its kind, in the allowlist's words), its steps per goal under `do`, and the `frame` it was read from.
- `ends`, which names the screen where each goal ends.
- `answers`, the bank's own refusals, each with its result code.
- `trouble`, a page that gets in the way, which earns a restart from home a bounded number of times.
- `reads`, patterns of visible lines with `{placeholders}`, applied by `readOf`.
- `submit`, the one press that moves money, which never appears in a row.
- `names`, the bank's own words for the controls the allowlists name.

A step types a value, presses a control, or chooses an account. Values are tokens such as `$operator`, `$member` and `$amount`, filled in at run time. A step learned by sight also carries an `At`: an anchor cut-out, an offset, and the kind of control that must be there.

`crawl.ts` holds the loop. `crawl` opens the console's home and then looks at the page, up to a bounded number of looks. If the page shows one of the bank's answers, the loop returns that answer. If it shows trouble, the loop starts again from home. If the page is one the route does not know, the loop starts again once and then stops with `unknown_screen`. Otherwise it does the steps of the one row the page matches, for the current goal, falling back to the row's `any` steps and then to its balance steps. The same page three times running is `stuck`. A `TargetError` does not end the run: the loop looks again, and whatever page shows gets its row. On top of `crawl` sit `checkBalance`, `prepareTransfer`, `readReview`, `submitTransfer` and `inHistory`. `submitTransfer` presses Submit once, after a person's approval has been consumed. It then confirms the transfer by finding exactly one row in the account's activity that holds the run's memo token. A Submit that hangs is never pressed again. An account matches by its last four digits or its name, however the bank words it, through `isAccount`.

`bank1.ts` is bank 1's route. `index.ts` exports `TABLES`, the routes written by hand, keyed by bank id.

**The decision.** A crawler is data plus one loop that goes by what is on the screen. It is not a scripted sequence of the form "step one, then step two". A script breaks when a page shows up early, late or twice, as it does after a session timeout or a promotion. A loop that asks "which page is this?" signs in again after an ended session simply because the sign-in page has a row. Data is also something an agent can produce safely, and a person can read it and approve it.

**Built by prompt 5.**

## Bank 1's route, row by row

Every row of bank 1's route cites a frame in `docs/evidence/bank-1`, named `<walk>/<frame>`. Nothing in the route was read from the bank's code.

- **sign-in** (happy/01) shows "Operator ID:" and "Password:", and is never shown with "Welcome back". For any goal, the crawler types the operator ID and the password, then presses "Sign In".
- **welcome back** (trusted/09) shows "Welcome back" and "Password:". The bank remembers this workstation, so the crawler types only the password and presses "Sign In", and no code is asked for.
- **code chooser** (happy/04) shows "Where should we send your code?". The crawler presses "Send code".
- **code** (happy/05) shows "Enter the 6-digit code we sent", and is never shown with "That code has expired.". The crawler types the code a person gives, then presses "Verify".
- **code expired** (code-expired/01) shows "That code has expired.". The crawler presses "Send a new code", and the code page runs again.
- **home** (happy/07) shows "Use Member Search to begin.". The crawler presses "Member Search".
- **promo** (hazard-promo/07) shows "New in CoreLink". The crawler presses "Member Search", which takes it past the promotion.
- **member search** (happy/08) shows "Member number:", and is never shown with "Status". The crawler types the member's number, then presses "Search".
- **member found** (happy/10) shows "Member number:" and "Status". The crawler presses "Open". The allowlist calls this control "Matching member", and `names` records that bank 1 draws it as "Open".
- **summary** (happy/11) shows "Member Summary" and "Available balance:". It is where the balance goal ends. For a transfer, the crawler presses the "Transfer Funds" nearest "Member Summary", because the navigation has one too. For the activity, it presses the "Activity" nearest the from-account.
- **transfer form** (transfer/12) shows "From:", "Amount:" and "Continue", and is never shown with "Review transfer" or "Transfer posted". The crawler chooses the from-account and the to-account, types the amount and the memo, then presses "Continue".
- **review** (transfer/17) shows "Review transfer". It is where the transfer goal ends, and it has no steps.
- **posted** (transfer/18) shows "Transfer posted".
- **activity** (transfer/20) shows "Activity:" and "Description". It is where the activity goal ends.

The route holds nine answers. Examples are "No member found with that number", which means `no_such_member`, "Member status: Closed", which means `member_closed`, and "record is in use by another operator", which means `record_in_use` and is retryable. It holds three kinds of trouble: a gateway's "temporarily unable to service your request", a fatal script error, and a balance widget that fails to load. Its reads are a summary tile for the balance, the review's cells, the posted page's confirmation line, and two places the member's name shows. The name is learned from those places and masked from then on. Submit is "Submit transfer", cited at transfer/17.

## Guardrails: `packages/guardrails`

**What it does.** Every action passes the guard before it reaches the browser. `decide` in `allowlist.ts` judges four things: the job, the kind of screen the route gives the page, the verb, and the control's name, read through the route's `names` when the bank draws it with other words. It never reads anything a page says, so an instruction written on a page has no way in. The lists are the JSON files in `allowlists/`: `every-job.json`, `check-balance.json` and `transfer.json`. The guard enforces these files, and the Console shows the same files, so what a person reads is what runs. `NEVER` names controls that are refused on every screen. `MONEY_WORDS` and `MONEY_SCREENS` treat a money-moving control that no list allows as an element refusal. A field the list marks secret may be typed only from a stored secret, and plain text that holds the password is refused. `grants.ts` holds the approval grant. `issueGrant` binds the run, the masked accounts, the amount and the memo token, for a short lifetime. `consumeGrant` spends the grant only when the review page shows exactly what the person approved. `trip.ts` freezes the bank when the guard refuses something.

**The decision.** The guard is an allowlist in files, judged on the screen, the verb and the control's name, and its first refusal ends the run and freezes the bank. The alternatives were a denylist, or a model that judges each action. A denylist misses whatever its author never imagined. A model can be talked into anything a page says.

**Built by prompt 6.**

## Contracts: `packages/contracts`

**What it does.** `index.ts` is the task contract, written in zod. It holds the inputs (`CheckBalanceInput`, `TransferInput`, and `TASKS`, which lists them), the result codes grouped by status (`CODES`), `TaskResult`, the kinds of question a person answers and the body of each of their actions (`HUMAN_BODIES`), `BankInfo`, the hazard names, and the outcome table that tests and the hazard lab share. `httpStatus` maps a result to its HTTP status. A run that is still going or waiting on a person is 202, and one that is done is 200. The bank's own answer is 422, and an escalation is 409. An expired or cancelled run is 410. A failure is 503 when it can be retried, and 502 when it cannot.

**The decision.** There is one zod source for the endpoints, the OpenAPI document, the tool definitions an agent loads, and the Console. The alternative was an OpenAPI file written by hand beside the code, which drifts from what the code does. A test holds the generated documents to the contract.

**Built by prompt 6.**

## Runs and the registry: `packages/runs`

**What it does.** `index.ts` holds what the API starts and the Runner carries out. `createRun` stores a run's inputs sealed with AES-GCM (`seal`), and what anyone else can read is masked (`maskInputs`). The same idempotency key returns the same run, and a second identical transfer is refused while the first is open (`DuplicateRun`). `newMemoToken` mints the run's memo token, such as `GBX 7Q4M`, once. `settleRun`, `resultOf` and `waitForResult` give each run exactly one result. `addStep` and `addFrame` keep the trail. `openHumanTask`, `awaitAnswer` and `awaitDecision` handle the questions a person answers: a sign-in code, an approval, or an escalation. `actOnHumanTask` checks each action of a person, writes it to the audit, and issues the grant when a person approves.

`registry.ts` decides which version of a bank's crawler serves each task. `serving` returns the active version, or nothing when the bank is frozen. `driverFault` demotes the version that ran into a fault, lets the previous version serve again if there is one, and opens or counts the bank's repair case. `promoteTable` turns an approved learned route into a new version for each task it covers. A balance alone covers check-balance, and a transfer also needs the activity goal. `tableOf` reads a version's route.

`store.ts` is the evidence store: frames as files under one folder (`fileStore`), written to a temporary name and then renamed, or kept in memory for tests. `hazards.ts` signs a forced hazard's header.

**The decision.** The durable workflow engine holds only the run's id. The inputs stay sealed in our own table, and the result is settled there too. The alternative was to pass the inputs as workflow arguments, which would put members' details into the engine's tables in the clear. In the registry, each approval adds a version and keeps the one before it as a fallback, so the first fault falls back instead of leaving the bank with nothing.

**Built by prompts 6 and 12, with the evidence store from prompt 4.**

## The API: `apps/api`

**What it does.** `server.ts` is the Task API, on Fastify. `POST /oauth/token` and `/oauth/revoke` handle OAuth2. `GET /banks` lists each bank and the tasks a promoted crawler serves on it, and marks a bank with no crawler as a stub. `GET /tools` gives the tool definitions an agent loads, and `GET /tasks` lists the tasks. `POST /tasks/check-balance` and `POST /tasks/transfer` start a run. They check the input, the caller's scope, and that a promoted crawler serves that task on that bank, and then they answer at once or within a short wait. `GET /tasks/:runId?wait=60` waits for the end of the run. The run is visible only to the client that started it. `catalog.ts` builds the bank list, the tools and the OpenAPI document from the contracts. `responses.ts` holds the Swagger UI's collapsed response examples. `lab.ts` starts runs with forced hazards for the hazard lab.

**The decision.** The HTTP status says what the caller should do next: wait, read the result, show the bank's answer, or hand off to a person. The task endpoints are the same for every bank, and the registry decides what each bank supports. The alternative was endpoints per bank, which would make an agent learn each bank's shape and would need a new release for each new bank.

**Built by prompt 6.**

## The Runner: `apps/runner`

**What it does.** The Runner takes runs from a DBOS queue and carries them out. `workflow.ts` registers the run as one durable step. `executeRun` in `execute.ts` finds the serving version and uses its learned route if it has one, and otherwise the bank's hand-written route from `TABLES`. It masks every known value, keeps a step and a masked frame for each page, asks a person for a code through the inbox, and keeps the bank's cookies between runs, so a code is entered once and the bank then remembers the workstation. It ends with exactly one result. A page the route does not know, met with no forced hazard, is a driver fault, and `driverFault` takes that version out of service. `runTransfer` in `transfer.ts` prepares a transfer up to the review page. It then parks the run, still holding its browser, until a person approves it in the Console. After that, it consumes the grant, writes the intent to press into the trail, presses Submit once, and confirms the transfer in the activity. A run that resumes and finds that intent already in its trail reads the activity and never touches the button. `guard.ts` wraps `decide` so that the first refusal trips the guard for the rest of the run. `forced.ts` adds a hazard lab run's signed header.

**The decision.** The crawl is one durable step, so a run that resumes after a crash starts a fresh browser and signs in again. The alternative was to checkpoint in the middle of a crawl, which cannot work, because a browser cannot be checkpointed. What makes a resume safe is the trail: the intent to press is written down before the press, so no resume can press twice.

**Built by prompts 5 and 6.**

## The Console: `apps/console`

**What it does.** The Console is where people work. It runs AdminJS over the control database behind a local sign-in, with two roles, viewer and admin (`main.ts`, `resources.ts`). `pages/inbox.ts` holds sign-in codes, transfer approvals and escalations. An approval shows the from-account, the to-account, the amount and the memo, masked, beside the review page's picture. An escalation can be resumed, finished by hand or cancelled, and a transfer awaiting approval can also be taken over. `pages/recommendations.ts` shows each learned route a factory run produced. Every screen appears as a row beside the frame it cites, followed by the reads, the answers, and what the gate's runs read. An admin approves or rejects it with a written reason, and approving calls `promoteTable`. `pages/runs.ts` shows every run step by step with its masked frames. `pages/freezes.ts` clears a freeze. `pages/lab.ts` is the hazard lab. `pages/dashboard.ts` links everything, and `api-clients.ts` creates the API's OAuth clients.

**The decision.** A person's every action goes through the same calls the pages make, and those calls are also an API. Tests therefore take the path a person takes. The alternative was to let people edit the database directly in AdminJS, which would skip the checks and the audit.

**Built by prompts 6 and 12.**

## OAuth, config and the database

`packages/oauth` gives OAuth2 client credentials with refresh tokens that rotate. It stores only keyed hashes of secrets and tokens, and it defines the scopes `tasks:balance`, `tasks:transfer` and `tasks:read`, which `allows` checks. `packages/config` holds `loadConfig`, which fails closed: every required setting must be present, every secret must be long enough, and no two secrets may be equal. `packages/db` holds the Prisma schema and migrations for the control database, and the `sql` and `db` clients. These parts were built by prompts 2 and 6.

## The factory: `apps/factory`

**What it does.** The factory learns a bank no one wrote a crawler for, and leaves behind a route in the same format as bank 1's.

- `cli.ts` is the factory's one command. It refuses a bank that has a hand-written route. It repairs the bank if a repair case is open, and learns it otherwise. It then runs the gate, prints a report of cost, judgments, refusals and evidence, and writes the run's lessons last.
- `run.ts` holds `factoryRun`. It loads memory's knowledge pack, works the three goals in order (each from the site's start page, on its own clock), and returns the route when the balance goal at least was reached. The run has 60 minutes of the agents' own time (`FACTORY_RUN_LIMIT_MINUTES`), and `runBudget` moves its end out by every wait for a person. `GOALS` and `SCOUT` are its prompts.
- `scout.ts` holds the Scout's tools. They act on the live page through the runtime, and they write the route as the Scout goes.
- `supervisor.ts` holds the Supervisor. `judge` judges every action from a fresh packet, `diagnose` explains a goal not reached, and `goalClock` keeps the goal's time. `openFrameTool` reopens frames.
- `agent.ts` holds `turn`, the one place a model is called, through pi. `tools.ts` is the closed list of each role's tools.
- `models.ts` reads each role's provider, model and effort from config. OpenRouter is the default, and OpenAI also works.
- `gateway.ts`, `caps.ts`, `ledger.ts`, `upstream.ts`, `server.ts` and `main.ts` form the metered gateway. Every model call goes through it, and none goes straight to a provider. Before each request it checks the run's and the week's spend against `CAPS` at the request's worst case, and it fails closed.
- `guard.ts` gives a learned route the guard's words. It offers the allowlists' kinds of screen to `name_page` (`SCREEN_KINDS`), names each typed value's field as the allowlists do (`LISTED`), judges one step under a goal's job (`judge`), and lists every step of a route the guard would refuse (`refusals`), with no browser.
- `gate.ts` replays a learned route before any person sees it. `memory.ts` is the memory client and the lessons step. `trail.ts` keeps the run's frames, views and judgment packets. `person.ts` asks a person for a sign-in code through the Console's inbox. `frame.ts` is the one-frame experiment behind `just frame`.

The texts the agents read are listed, in the order a run uses them, in [Where the factory's prompts live](agent-prompts.md).

**The decision.** The agents produce data, and code replays it with no model. The alternative was an agent that drives the bank on every task in service. Such an agent would cost money on every call and behave differently each time. It could not be checked before it ran, and a person could not approve it. A route can be replayed, gated, read screen by screen, and approved once.

**Built by prompts 8, 9, 10, 12 and 13.**

## How the factory produces the same thing

A factory run ends with the same kind of route that bank 1 has, and the Runner replays it with the same loop. It gets there in five stages.

**The Scout names each screen.** Each goal starts from the site's start page, and the Scout sees the page before it does anything. When it arrives on a screen, it calls `name_page` with a name and the words that tell this screen apart. Code then checks that name. Every word must show on the page as text. A word drawn as a picture goes in as a cut-out with its box, and must be found again on the picture. No word may hold the task's own member, accounts or memo, because another task's page would show different ones. The tool adds never-words itself. When an earlier screen's words all show on the new one, `neverRepairs` gives the earlier screen a never-word, so the two never match the same page. Finally `knows` must pick out exactly this screen, the same check the crawler makes in service. The Scout also gives the screen its `kind`, one of the allowlists' kinds of screen, because the guard judges every step by it.

**The Scout's steps are filed under the screen.** Each action becomes a step, with the task's values replaced by tokens such as `$operator` or `$amount`, so the step fits any member. A step found by its label's words is kept by those words. A step taken by position keeps an anchor: a cut-out of the label beside the field, never the field itself, because what a field holds changes. The steps of a visit are filed under the screen they were taken on when the page changes, through `fileVisit`. On a screen whose kind is in `EVERY_GOAL` (a sign-in, its code, a notice), the steps are filed under `any`, since which of those a task meets depends on the browser's state, not the task. Before any step is taken, `allow` has the guard judge it as it will in service, by the screen's kind and the control's name in the allowlist's words. A typed field is named for the guard by the value it holds, and a press says with `as` which allowed control it is when the bank draws it with other words. The route keeps each of those in its `names`, so the guard knows them in service. A goal's last screen holds no steps for that goal.

**The Scout notes reads and answers.** `note_read` lets the Scout point at the label before each value. `pointed` writes the pattern from the page's own lines, and the tool reads the live page with the crawler's own functions (`accountsIn` and `readOf`). It keeps the read only if it finds the task's accounts. `note_answer` records the bank's own refusal and the result code it means. `note_trouble` records a page that gets in the way. For the transfer goal, `goal_reached` records the control that would send the money as the route's `submit`. That control is named and never pressed.

**The Supervisor judges every action.** After each action, and at once after any refusal, the Supervisor sees the new picture, the page's words and controls, every call since its last judgment, a close-up of what was acted on, the route so far and its own last judgments. Code enforces its verdict. Stop refuses any further action. Wait makes the Scout look again first. End stops the goal at once. When the Scout says a goal is reached, code first checks the route's steps for that goal with `refusals`, with no browser, and refuses the goal if the guard would refuse a step. Then the Supervisor checks the route against the frames, and a wait sends the Scout back to fix it.

**The gate and a person's approval.** `gate` in `gate.ts` first runs `refusals` over the whole route, and a route the guard would refuse is not run at all. Then it replays live exactly what an approval would promote (`covered`): `checkBalance` if the route covers the balance, and, if it covers the transfer, `prepareTransfer` and then `crawl` to the activity, never pressing Submit, from a browser that has never signed in, as the service's first run will, with the guard judging every step. It runs once plainly and saves the browser's cookies. Then it runs each task from those cookies in a browser of its own, as the runner keeps them between runs, so the route meets the sign-in that welcomes a trusted browser back. Then it runs again with the confirmation dialog forced. A route that fails the plain run is recorded as failed and never reaches a person. One that breaks under the hazard is recorded as broken and opens a repair case. One that passes all three waits in the Console's recommendations. Only a person's approval promotes it, through `promoteTable`, and then `GET /banks` lists the tasks it serves. From then on, `executeRun` loads that route with `tableOf` and hands it to `crawl`, the same loop that runs bank 1.

A repair is the same crawl. It starts from the broken route, the bank's lessons, and the failing run's frames with the Supervisor's diagnosis, and it changes only what moved.

## Memory: `apps/memory`

**What it does.** Memory is one service on its own Postgres, behind one door. It starts with thirteen base lessons, written by a migration in `apps/memory/prisma/migrations` and served from the very first start, with no run: six for the Scout, five for the Supervisor and two for both, all confirmed patterns. A run can dispute a base lesson but never retire it; only a person can. Each lesson belongs to an agent, and memory serves each agent its own lessons and those for both. `door.ts` gives each role a token and lists the writes each role may make (`WRITES`). Every write must also carry an HMAC signature made with a key that only deterministic code holds, so a model that learns a token still cannot forge a write. `screen.ts` is the privacy screen on every write. It refuses passwords, codes, tokens, account-like numbers, page data, pictures and anything about a person. `episodes.ts` records a run, a proposed lesson, which lessons a run relied on, a contradiction, and a retirement. A proposal nearly identical to a lesson already held, at `SAME_LESSON`, adds its evidence to that lesson instead of making a new one. `rules.ts` holds the fixed rules: one run's contradiction disputes a lesson, and two runs' contradictions retire it. A curator can also retire a lesson by hand. `versions.ts` changes a lesson only by adding a version. `knowledge.ts` serves each agent its knowledge pack in tiers and labels every lesson that is not yet borne out. It also answers `memory_query`. `search.ts` ranks lessons by full-text search and by pgvector similarity, fused by reciprocal rank, and `embed.ts` makes the vectors in this process with a small local model, so no text leaves the service.

**The decision.** Fixed rules decide what becomes of a lesson, and no model judges its own lessons. A lesson must cite the frames it came from, and only a run that reached a goal writes lessons. At the end of such a run, the Scout and the Supervisor each write their own lessons, kept for themselves. The alternative was to let the Supervisor score and promote lessons, so that a run that failed for one reason could teach its wrong guess as the reason. A lesson says how a site works, never what the site calls things, so memory holds no glossary of labels.

**Built by prompt 11.**

## Tests and infrastructure

**Tests.** Each package has unit tests in its own `test/` folder. The cross-cutting tests live in `tests/`.

- `tests/crawler/bank1.test.ts` runs bank 1's route against bank 1 in a browser, with forced hazards, and checks the ledger.
- `tests/outcomes` proves one result of each kind from the outcome table.
- `tests/runs` carries transfers end to end through the Runner and the Console's API.
- `tests/escalation` takes an escalation through the API: 409, then resume, then 200.
- `tests/pii` runs both tasks, then searches every database row, stored file and log line for every seeded value.
- `tests/factory` proves the factory's mechanics with no model. A script stands where the model would, so these tests prove the tools, the judging and the gate, never an agent's reasoning.

Tests read the ledger and the staff codes through the bank's admin API. The import boundaries in `.dependency-cruiser.cjs` forbid any crawler, runner or factory code from importing the bank. These tests were built by prompts 1, 5 and 13.

**Infrastructure.** `infra/compose/compose.yaml` runs the stack as one compose project sized for a small Mac: the control and memory databases, the API, the Console, the Runner, the two banks and their inbox, and the factory behind its own profile. Bank 2 runs with no ambient hazards, so that the factory learns it inside its clock, while forced hazards still fire. `infra/docker` holds the node, runner and tools images. The Mac needs only Docker and `just`, and every other tool runs in the tools image. The `Justfile` holds every recipe. The README lists first the ones a reviewer runs: `setup`, `up`, `show`, `reset` and `down`. The developer recipes come after them. Among them are `factory`, whose hard stop from outside allows the agents' 60 minutes plus 9 for a person's codes, `redesign`, which turns bank 2's vendor redesign on or off, and `frame`. Secrets are kept with SOPS and age, in encrypted files under `config/` that `just setup` creates with random values. A key from outside, such as the model provider's, is set unseen with `just secret-set`.

**CI.** `.github/workflows/ci.yml` decides what a pull request changed. A change to the docs alone runs nothing. A change to code runs gitleaks, Prisma validation, typecheck, lint, the import boundaries, and the unit tests of the packages it touches. A merge to master runs the whole suite in four parallel shards, and checks that the images build. These parts were built by prompts 2 and 7.
