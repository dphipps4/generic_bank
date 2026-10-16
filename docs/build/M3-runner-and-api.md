# M3: The crawler and the Task API

The first time an agent gets a real answer from a bank. The Task API takes a call authenticated
with OAuth2, a durable run drives a real browser through Bank 1's console the way a person
would, and the result comes back typed, with a masked trail anyone can review. The
plan's [Appendix D](../plan/GENERIC_BANK_PLAN.md#appendix-d-task-api) and
[Appendix E](../plan/GENERIC_BANK_PLAN.md#appendix-e-the-runner-driving-a-messy-ui) are the
specification.

A small client of our own drives the browser over the DevTools Protocol, instead of a browser
automation library. That way nothing of ours runs inside the bank's pages, every call has its own
timeout, and frames from another origin are read through their own sessions.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **The result, in types** | Every status and code of the result, problem details, the bank list, as zod contracts | every code maps to exactly one HTTP status |
| 2 | **The control database grows** | API clients, tokens and token families, runs and their steps | the migration applies on top of the last one |
| 3 | **OAuth2** | The token endpoint (one-time code, rotating refresh tokens), revoke, bearer checks, scopes, a rate limit, audit entries | a spent refresh token revokes its family; a missing scope is a 403 |
| 4 | **API clients in the Console** | Create a client (its secret and code shown once), revoke it; `just api-token`, from the local client made at setup | the secret is never stored, only its hash |
| 5 | **The API describes itself** | OpenAPI from the contracts, Swagger UI at `/docs`, `GET /tools`, `GET /banks` | the tools, the endpoints and the document never disagree |
| 6 | **A browser, from outside** | A DevTools client with a timeout on every call; Chromium's headless shell in the Runner | a frozen call times out instead of hanging |
| 7 | **The screen model** | Layout, accessibility tree and screenshot from every frame, flattened into one picture; only what is visible and on top; stable references | the hidden twin of a button is not in the model |
| 8 | **Fully rendered** | Load events, two identical screenshots, no loading signals, something to act on | a page drawn late is not read early |
| 9 | **Recognizing screens** | Screen signatures; exactly one must match | an unknown screen is never guessed |
| 10 | **Targeting and acting** | Fields by label and geometry, buttons by name, tiles and rows by identity; the real mouse and keyboard; a re-read before every click | a control that moved is re-targeted |
| 11 | **Pictures of text** | Image fingerprints matched against names learned at factory time | Bank 2's sign-in and member-number pictures get their names on a balance run (`tests/browser/corelink-banks.test.ts`) |
| 12 | **Masking and the trail** | Values masked before anything is written; screenshots with white boxes; frames that cannot be proven clean are withheld | no seeded value appears in any stored frame |
| 13 | **The CoreLink driver** | Sign-in, member lookup and Check Balance for Bank 1, and the recoverable conditions | each recoverable condition is handled inside the run |
| 14 | **Runs** | The durable run, `POST /tasks/check-balance`, `GET /tasks/:id?wait=`, results as HTTP status codes | 202, then 200 with the balance |
| 15 | **Runs in the Console** | Each run with its steps and masked frames | a reviewer can follow a run screen by screen |
| 16 | **Outcomes** | Check Balance on Bank 1, and every forced hazard mapped to its result | one result per hazard (`tests/outcomes/one-source.test.ts`); a business outcome, a recoverable condition and a hard failure run end to end (`tests/outcomes/outcomes.test.ts`) |
