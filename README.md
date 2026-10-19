# Generic Bank

Banks run a lot of back-office screens with no API at all. This gives an AI agent one: it calls with typed inputs to check a balance or move money, and gets a typed result back. Behind it, a crawler works the bank's staff console the way a teller does, looking at each page before it clicks. A person approves every transfer. Anything the system can't finish safely goes to a person, with the pictures of what happened.

The target app is two local banks, both deliberately unfriendly: 2003-style consoles, server-rendered, framesets, nested tables, no test IDs. A crawler is two things: shared code that every bank uses, and a **route**, which is plain data listing one bank's screens, how to recognize each one, and the steps a teller takes there. No AI runs while a task runs; the code just replays the route.

- **Bank 1's route was built ahead of time.** AI wrote it from a recorded walk through the bank's pages, and a person reviewed it. This is the system the brief asks for.
- **Bank 2's route is built by a factory,** the one extension. Two AI agents learn the live site and produce the route, and a person approves it before it's used.

## Gotchas

The demo assumes you're running on a Mac with Chrome installed, and has not yet been tested on Windows. Necessary browser pages are brought up when you run `just show`: they include ACCESS.md, with URLs and credentials. When you log into Bank 1, you'll be asked to enter a PIN code; this code is shown in the 'Simulated phone and email inbox', one of those browser pages. 

To run the factory, you'll need an OpenRouter API key to run the factory; you'll get a reminder during `just setup`. Bank 2 login also requires a PIN. Dependencies are installed via `just setup`; most are contained in docker; you can bypass bootstrap if you have `brew` installed and run `brew install just`.

You'll need to log into `adminJS` to view runs, check the inbox, and approve transfers. Approving a transfer requires you to enter a note, which can be random as long as it is ten characters or more.

## Run it

You need macOS 14 or newer, [Docker Desktop](https://www.docker.com/products/docker-desktop/) and git. An 8 GB Mac is enough.

```sh
infra/scripts/bootstrap.sh      # installs just, checksum verified
just setup                      # once: checks the Mac, creates every secret, builds the images
just up                         # both banks, the API, the Console, the runner, memory, the factory
just show                       # Swagger UI, the Console, both banks and the simulated inbox
```

`just up` writes ACCESS.md, the one place with every page, login and member number. Then follow the demos: [Demo 1](docs/demo-1.md) runs both tasks on bank 1 and throws trouble at it, and [Demo 2](docs/demo-2.md) has the factory build bank 2's crawler from nothing.

| Recipe | What it does |
|---|---|
| `just setup` | Once, after cloning: checks the Mac, creates the secrets, builds the images |
| `just up` | Starts everything; data is kept |
| `just show` | Opens ACCESS, Swagger UI, the Console, both banks and the inbox |
| `just reset` | Empties the data and keeps the images and memory's models; asks first |
| `just down` | Stops everything, or only some groups, as in `just down console bank`; data is kept |

The other recipes are listed [at the end](#other-recipes).

---

## 1. How the system fits together

![The system: boundaries, data, and where the risky parts live](docs/diagrams/system.svg)

An agent calls the **API** with a typed task, such as "check the balance of this member's checking account". The API starts a **run**. The run opens a browser and hands it to the bank's **crawler**, which works the bank's website the way a teller would.

The crawler never touches the browser directly. It acts through the **runtime**, and before every action the **guard** checks that the action is allowed.

Sometimes only a person can answer: a sign-in code, a transfer to approve, a page nobody has seen before. Then the run waits in the **Console** until someone does.

**The key decisions, and what each one costs:**

- **A typed contract, not a chat.** Each task has one schema. The API's input checks, its OpenAPI page and the agent's tool definitions are all generated from it, so they can't disagree ([`packages/contracts`](packages/contracts/src/index.ts), [`apps/api`](apps/api/src/server.ts)). A task call waits up to 60 seconds for its answer. When a person is needed, such as for a sign-in code, it answers 202 at once, and the agent asks again with `GET /tasks/{runId}`.
- **Look at the page the way a person does.** The runtime reads what the browser renders: a picture of the page, the words and controls a person can see, and where they sit. It never reads the bank's source code or relies on how its HTML is built ([`packages/runtime`](packages/runtime/README.md)). That's slower, because it waits for each page to stop changing. In return, framesets, nested tables and buttons made of styled text don't trip it up.
- **The crawler's knowledge is data, and nothing improvises during a task.** The shared code looks at the page in front of it, works out which screen it is, and does that screen's steps ([`packages/crawler/src/crawl.ts`](packages/crawler/src/crawl.ts)). The route is the only part written for each bank ([bank 1's](packages/crawler/src/bank1.ts)). The same page always gets the same steps, so runs are cheap, repeatable and easy to audit. If a page isn't in the route, the run stops and asks a person instead of guessing.
- **A new bank is a new route, not new code.** Banks running the same vendor product share the code, the runtime, the guard and the API; only the route differs. The cost: a crawler can only do what its route describes, so when a bank changes its pages, its route has to change too. A different kind of app, such as a desktop program, would need a new runtime; the routes and the code that replays them don't depend on the browser.

**Why the boundaries are where they are.** The agent only ever sees tasks, never pages. Only the runner holds a browser, so a bank that hangs can't take the API down with it ([`apps/runner`](apps/runner/src/execute.ts)). The guard sits on the one path every action has to take. It judges the kind of screen the route says the page is and the control's name in the allowlist's words, and ignores anything the page's text says, so a page can't talk it into anything ([`packages/guardrails`](packages/guardrails/src/allowlist.ts)). And no AI model ever sits between an agent's request and a bank's Submit button.

The risky parts are the Submit press, the passwords typed at sign-in, and the pictures kept as evidence. [The architecture](docs/architecture.md) shows the data models and how each risky part is handled.

## 2. How it meets the task and minimum scope

Both tasks run end to end through bank 1's web UI, each with typed inputs and one structured result ([`tests/runs`](tests/runs/execute.test.ts)). The bank's own answers, recovered trouble, hard failures and hand-offs to a person each reach the caller differently ([`outcomes.test.ts`](tests/outcomes/outcomes.test.ts)). When a run gets stuck, it stops and hands a person every masked page it saw ([`escalations.test.ts`](tests/escalation/escalations.test.ts)). Every action passes an allowlist first ([`packages/guardrails`](packages/guardrails/allowlists)), and nothing personal is kept unmasked ([`pii.test.ts`](tests/pii/pii.test.ts)). [How it meets the task](docs/scope.md) goes through the brief point by point, and [Appendix A](docs/brief.md) names the code behind each point.

## 3. From 80% to 100%

AI wrote nearly all of this code, and a person set the requirements, reviewed the work and pulled it back when it drifted. The first crawler was thrown away and rebuilt from a recorded walk through the bank's pages ([the evidence](docs/evidence/bank-1/README.md)), and Submit is never pressed twice ([`transfer.ts`](apps/runner/src/transfer.ts)). To run unattended, it still needs a home in the cloud with more than one runner and Vault for secrets, the rest of the guardrails, and every hazard forced against a deployed stack on a schedule. [From 80% to 100%](docs/80-to-100.md) has the whole account: what we changed, what we threw away or left out, and the full list of what is still needed.

---

## All the docs

- [Demo 1](docs/demo-1.md): bank 1, both tasks, three kinds of trouble and the guard.
- [Demo 2](docs/demo-2.md): bank 2, from a stub to a route the factory builds, and a repair.
- [The architecture](docs/architecture.md): boundaries, data, and where the risky parts live.
- [The factory](docs/factory.md): how the agents learn a bank and what they produce.
- [How it meets the task](docs/scope.md): the task and the minimum scope, point by point.
- [From 80% to 100%](docs/80-to-100.md): what AI wrote, what we changed, threw away and left out, and what is still needed.
- [Appendix A: the brief, point by point](docs/brief.md), with the code that meets each point.
- [Appendix B: results](docs/results.md): every status and code a caller can get.
- [Appendix C: technology](docs/techstack.md).
- [Bank 1's evidence](docs/evidence/bank-1/README.md): the recorded walk its route was written from.
- [The runtime](packages/runtime/README.md): its files, one line each.
- [A walk through the code](docs/code.md), part by part.
- [Where the factory's prompts live](docs/agent-prompts.md): every text the agents read.
- [The prompts that build Generic Bank](docs/prompts.md): the condensed prompts behind the whole system.

## Other recipes

`just` alone lists every recipe.

| Recipe | What it does |
|---|---|
| `just help` | Lists every recipe (the same as `just`) |
| `just doctor` | Checks that this Mac can build and run the stack (also `just requirements`) |
| `just access` | Writes ACCESS.md afresh |
| `just all` | Starts again from nothing: deletes every volume and rebuilds the images; asks first |
| `just secret-set <file> <key>` | Sets one secret unseen, for example `just secret-set factory OPENROUTER_API_KEY` |
| `just factory <bank> <member> <from> <to>` | The factory learns a bank, or repairs its route, then the gate, for example `just factory example 40017732 8176 9433` |
| `just redesign on\|off` | Turns bank 2's vendor redesign on or off, which breaks its learned route on purpose |
| `just frame <run> <frame> <role> <samples> <variant>` | Gives one kept frame to the real Scout or Supervisor, to test a change to its instructions |
| `just dev` | To develop: Node, the dependencies, Chromium and every CI check |
| `just check` | The quick checks: types, lint, tests, import rules, secrets |
| `just test` | The whole suite, as CI runs it on master |
