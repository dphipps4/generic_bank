# Prompts, part 1: bank 1, the arrow

These prompts build the brief's system: two banks on one product, a small runtime that sees first and then clicks, bank 1's crawler written from captured evidence, the Task API, and safety. The arrow only goes one way: evidence, then prompts, then deterministic code. When it's wrong, a person corrects it. The factory is separate code, in [part 2](factory.md).

## 1. How we work

> Build from the attached brief. It asks for a small, coherent and honest system that survives runtime errors and carries over to other tenants, in about a day. If the brief doesn't need it and I didn't ask for it, don't build it.
>
> Plan first, and write code only after I approve. Use one worktree per branch and never edit the main checkout. Keep pull requests small; squash them, then delete the branch and the worktree.
>
> **Tests:** only what proves something the brief needs.
> - **A pull request runs two jobs side by side, in about a minute:**
>   - typecheck, lint and gitleaks on the diff;
>   - the unit tests of the packages it touches.
>
>   A browser test runs only when the runtime, a crawler or the bank changed, and then just one: a balance, plus one business outcome. Images are built on master, not on pull requests. No pull request replays a recorded run.
> - **A docs-only change runs nothing.**
> - **Master runs the rest in parallel, in under 15 minutes.** Long waits and the fresh-clone check run only when asked for.
> - A newer push cancels the older run, and nothing runs twice.
>
> **Code you can walk through:** keep each file short and single-purpose. Next to the code, keep a walkthrough: each file, what it does, and the decision behind it in one line, with the alternative we didn't choose. Every design decision must be one you can defend to a reviewer with the code open.
>
> **Say what's true.** Whatever is written by hand says so. Never present scripted output as a model's. A test fake never reads the bank's source. Ask before anything that costs real money or hours. When you're stuck, stop and show the evidence.

## 2. The plan

> Write one plan. A person reads ten pages at most, and the detail goes in appendices. Use one confident voice, with no history; the reviewer wrote the brief.
>
> It covers:
> - the problem;
> - one architecture diagram;
> - the task contract;
> - how the UI is seen and driven;
> - the error taxonomy, escalation and safety;
> - what we cut.
>
> Write "a person approves". Use American spelling. Run /humanize on it.

## 3. Stack and setup

> - **Language and libraries:** TypeScript on Node, ESM, npm workspaces. Fastify, zod, Prisma on Postgres 16, DBOS for durable runs, AdminJS for the Console, and Playwright driving Chrome.
> - **Compose:** one docker-compose that fits in Docker's 5.25 GB on an 8 GB Mac, with pictures on a shared volume.
> - **The Mac needs only Docker and `just`;** every other tool runs in a Debian tools image.
> - **Recipes:** `requirements`, `setup` (it asks for each secret through sops), `up`, `down`, `all`, `open`, `try`, `test`, `check` and `help`.
> - **Secrets:** SOPS and age. No Vault and no 1Password.

## 4. The target: two banks on one product

> Build CoreLink Branch Console, a staff app from about 2003: framesets, nested tables, no ids, a different way to submit on each page, and content drawn by its own script.
>
> - **Sign-in:** staff sign in with an ID and a password, then a code sent to a simulated phone inbox. The inbox is one clearly labeled page, and each person has one name everywhere.
> - **Pages:** member search; the member summary with account tiles; a transfer form that stops on a review page. A supervisor approves anything over a limit.
>
> Put in the runtime trouble the brief names:
> - slow pages (250 ms to 1.8 s), script errors and 503s;
> - record not found, a closed member, insufficient funds, permission denied;
> - session timeout, a surprise confirmation dialog, an interstitial, a record in use.
>
> 3% of runs meet a hazard that would stop a naive crawler (HAZARD_RUN_RATE_PCT=3), never on a transfer page. Tests can force any single hazard.
>
> **Two tenants, from config:**
> - bank 1, Generic Bank;
> - bank 2, Example Credit Union: its own words, a tab strip from a second origin, labels and its Confirm button drawn as pictures, and it turns away anything not shaped like Chrome on a Mac.
>
> A switch (BANK_REDESIGN) renames and moves things the way a vendor upgrade would. An admin port gives tests the ledger and the current code; no crawler or agent ever sees it.

## 5. The runtime: see first, then click

> Write one small runtime on Playwright that every crawler uses, and keep it small.
>
> **First, a one-hour spike, thrown away.** Report each of these with a picture before committing to Playwright:
> - the frameset and the submit styles;
> - the accessibility snapshot leaving out hidden controls;
> - a covered control being refused;
> - masking;
> - dialogs;
> - bank 2's second origin, its pictures of text, and its bot screen.
>
> - **See:** wait until two screenshots match and nothing says "Loading". Save the masked picture and the rendered accessibility tree (role, visible name, box). Nothing hidden, virtual or `isVisible=false`.
> - **Know where you are:** a page is named by the words visible on it. Exactly one must match; otherwise escalate with the picture.
> - **Click:** find the control by role and visible name, or by a fingerprint of drawn text. Act only when it's visible, stable, enabled and on top at the point clicked. Use the real mouse, save the target's box with the picture, then read again to confirm.
> - **Resilience, in code, with no model:**
>   - bounded retries with backoff on reads;
>   - waiting out a slow page;
>   - dismissing a known dialog or interstitial;
>   - signing in again after an ended session;
>   - retrying a record that's in use;
>   - matching the bank's own words with patterns.
>
>   Each is recorded in the run.
> - **Outcomes:** a business answer, a recoverable condition, a hard failure and an escalation each get their own code.
>
> A crawler is a list of steps for each part of a task (sign in, find the member, read the balance, fill a transfer). Each step names its control and the words of its page.

## 6. Bank 1, by the arrow

> 1. **Evidence.** Walk bank 1 as a teller would, seeing first and then clicking. Keep every page, as a picture and its rendered tree:
>    - sign-in, the code, home, search, the summary;
>    - the transfer form and the review page;
>    - each refusal, and each hazard we keep.
>
>    Index each frame: the page, and what was done. Never open the bank's source.
> 2. **Claims.** From the frames alone, write what each page is, the words that show it, and what each control used does, each citing its frame.
> 3. **Code.** From the claims alone, write bank 1's crawler as steps:
>    - check balance;
>    - transfer to the review page, then the granted Submit, pressed once, then a check of the history.
>
>    Each step cites its frame.
> 4. **Proof.** Against the ledger, run:
>    - the outcome table;
>    - each kept hazard, forced alone;
>    - the member's own cases;
>    - the transfer through approval.
>
>    On a failure, go back for evidence, never to the source.
>
> A test fails if a word in the crawler isn't in a cited frame, or if the crawler imports the bank's code. Register bank 1's two tasks, marked "written by hand from captured evidence".

## 7. The Task API

> One REST API for every bank:
>
> - **Endpoints:** `GET /banks`, `POST /tasks/check-balance`, `POST /tasks/transfer`, and `GET /tasks/:id?wait=`.
> - **Types:** typed with zod.
> - **Status codes:** 202 queued, 200 done, 422 a business answer, 409 needs a person, 503 retry.
> - **Auth:** OAuth2 client credentials with 8-hour tokens, and a client made at setup.
> - **Docs and tools:** Swagger UI with one Authorize form, and `GET /tools` built from the same contracts.
>
> The agent knows nothing about screens.

## 8. People, money and safety

> Sign-in codes, approvals and stuck runs all go to the Console's inbox, each with its frames.
>
> - **Transfers:** a transfer parks at the review page. A person approves it, and a single-use grant lets the run press Submit once. The run then confirms the transfer in the history. A swallowed submit is never pressed twice.
> - **The allowlist:** permitted actions live in files, and every click passes through it.
> - **Data:** mask before anything is stored. A test searches everything a run wrote for the seeded values.

## 9. The README and the guide

> **README, two pages:**
> - what it is;
> - how to run it: `just setup`, `just up`, then curl or Swagger;
> - the architecture diagram;
> - how the UI is driven, the outcomes, escalation and safety;
> - the arrow;
> - 80 to 100, honestly.
>
> **The guide:** steps a person can follow one at a time, each with a small picture.
>
> **The walkthrough:** part 1's code, file by file, in the order a reviewer should read it. Start at the API, then the run, then the runtime, then bank 1's crawler. Each file gets its line count, what it does, and the decision behind it.
>
> **ACCESS.md:** every URL and login.
>
> Run /humanize on each.
