# Generic Bank

Banks run a lot of back-office screens with no API at all. This gives an AI agent one: it calls with typed inputs to check a balance or move money, and gets a typed result back. Behind it, a crawler works the bank's staff console the way a teller does, looking at each page before it clicks. A person approves every transfer. Anything the system can't finish safely goes to a person, with the pictures of what happened.

The target app is two local banks, both deliberately unfriendly: 2003-style consoles, server-rendered, framesets, nested tables, no test IDs. Bank 1's crawler was written by hand, from evidence. Bank 2's is learned by a software factory. Two agents, a Scout and a Supervisor, work it out on the live site, and a person approves what they wrote before it's used.

## Run it

You need macOS 14 or newer, [Docker Desktop](https://www.docker.com/products/docker-desktop/) and git. An 8 GB Mac is enough.

```sh
infra/scripts/bootstrap.sh      # installs just, checksum verified
just setup                      # once: checks the Mac, creates every secret, builds the images
just up                         # both banks, the API, the Console, the runner, memory, the factory
just show                       # Swagger UI, the Console, both banks and the simulated inbox
```

`just up` writes ACCESS.md, the one place with every page, login and member number. [The demo](docs/demo.md) walks both tasks, three hazards and bank 2 in about fifteen minutes. The factory needs one key you bring: `just secret-set factory OPENROUTER_API_KEY`.

---

## 1. How the system fits together

![The system: boundaries, data, and where the risky parts live](docs/diagrams/system.svg)

An agent calls the **API** ([`apps/api`](apps/api/src/server.ts)) with a typed task. The API starts a durable **run** ([`apps/runner`](apps/runner/src/execute.ts)), which opens a browser and runs that bank's **crawler** ([`packages/crawler`](packages/crawler/src/crawl.ts)). The crawler only ever acts through the **runtime** ([`packages/runtime`](packages/runtime/README.md)), and the **guard** ([`packages/guardrails`](packages/guardrails/src/allowlist.ts)) checks every action before it happens. When only a person can answer (a code, an approval, a page nobody knows), the run waits in the **Console** ([`apps/console`](apps/console/src/main.ts)). The **factory** ([`apps/factory`](apps/factory/src/run.ts)) works offline. It learns a new bank, and a person approves what it learned.

**The decisions that matter, and what they cost:**
- **A typed contract, not chat.** Each task has one schema ([`contracts`](packages/contracts/src/index.ts)), and the API's validation, its OpenAPI page and the agent's tools all come from it, so they can't drift apart. A balance comes back in one call, which waits up to 60 seconds. The price: a slower run means polling `GET /tasks/{runId}`.
- **Look at the page the way a person does.** The runtime reads what's rendered: the picture, the visible accessibility tree, the controls. Never the bank's source, never the shape of its DOM. It's slower, since it waits for the page to hold still, but that's why framesets and styled-text buttons don't break it.
- **No model at run time.** A crawler is a table and one loop. The table is plain data: each page, the words that give it away, what a teller does there. Runs are cheap, repeatable and auditable, and an unseen page stops the run instead of inviting a guess. The catch is that a new bank needs a table. The factory writes it.
- **A bank is data.** Banks running the same vendor product share everything but their table. That's the whole story of reuse across tenants.

**Why the boundaries sit where they do.** The agent sees tasks, never pages. Only the runner holds a browser, so a hung bank never reaches the API. The guard sits on the one path every action takes, and it judges page names and the names drawn on controls, never what the page text says. And no model ever sits between an agent's request and a Submit button. The risky parts are three: the Submit press, the secrets typed at sign-in, and the pictures kept as evidence. [The architecture](docs/architecture.md) shows the data models and where each of those lives.

## 2. How it meets the task and minimum scope

**Two typed tasks, end to end.** `POST /tasks/check-balance` and `POST /tasks/transfer` each return one structured result, and `GET /banks` and `GET /tools` let an agent find them. Both run all the way through bank 1's UI ([`execute.test.ts`](tests/runs/execute.test.ts), [`transfer.test.ts`](tests/runs/transfer.test.ts)).

**Driving the messy legacy UI.** The target ([`apps/bank`](apps/bank/src)) is a console straight out of 2003: framesets, nested tables, no test IDs, buttons built from styled `<font>`. The runtime ([`see()`](packages/runtime/src/see.ts), [`act.ts`](packages/runtime/src/act.ts)) waits until two pictures 700 ms apart match and nothing says loading. It finds a field by the label drawn next to it, and a button by its drawn name, taking the one nearest the section it means. Clicks use the real mouse, and are refused if anything covers the control. Bank 1's table came from [a walk through its pages](docs/evidence/bank-1/README.md), every row citing its picture; the walk found seven problems the synthetic tests had missed.

**Outcomes kept apart.** Each kind reaches the caller its own way ([every response, with examples](apps/api/src/responses.ts)):

| Kind | Example | The caller gets |
|---|---|---|
| The bank's own answer | "No member found with that number." | 422, `no_such_member` |
| Recovered inside the run | a dialog, a promo, a swallowed click, a session that ended early | 200; the steps show it |
| Hard failure | the bank is down, an error page | 503 `retryable: true`, or 502 |
| A person has it | an unknown page, stuck, an unclear transfer | 409 `escalated` |

On every page, the bank's answers are checked first, by its own words. Trouble means going back to home and starting again, at most twice and never after Submit. [The outcome tests](tests/outcomes/outcomes.test.ts) prove one of each, and `just hazards all` forces all 18 hazards.

**Escalating when stuck.** A run stops and hands off to a person when it hits:
- a page no row knows;
- the same page three times;
- a transfer the history doesn't show exactly once;
- a guard refusal;
- bank 1's supervisor page, for anything over $2,500.

The API answers 409 with an `escalationId`. In the Console's Inbox, the escalation links to the run: every step, every masked picture, right up to where it stopped. A person resumes it, finishes it by hand, takes it over, or cancels it. [The escalation test](tests/escalation/escalations.test.ts) goes 409, then Resume, then 200.

**Safety with regulated data.**
- **An allowlist.** Each job has a short list of page, verb and control ([`allowlists/`](packages/guardrails/allowlists)), checked before every action. Pay now, Add payee, Change address, Waive fee and Close account are refused everywhere, and words that move money need a grant. The first refusal freezes the bank until an admin clears it.
- **Irreversible actions.** A transfer stops on the review page. A person's approval issues a grant: single use, five minutes, checked against what the page shows. Submit gets pressed once. If the result is unclear, the crawler reads the history for the run's memo token and doesn't press again. Sending the same `idempotencyKey` returns the same run.
- **Nothing sensitive kept.** Money, numbers and names are painted out of every picture, and masked in text and addresses, before anything is stored ([`mask.ts`](packages/runtime/src/mask.ts)). Inputs and codes are sealed. The password is only ever typed from a stored secret. [The PII suite](tests/pii/pii.test.ts) searches every row, object and log line for every seeded value.

**Evidence, and scale.** Every page becomes a step with its masked picture and visible tree, shown in the Console. A bank is a table and a run is durable, but there's no machinery: one runner, two runs at a time.

**The extension: reuse across tenants.** Bank 2 is the same vendor product, configured and branded differently. Until it's learned, `GET /banks` marks it `"stub": true`. The factory's Scout explores it and writes its table, and a Supervisor judges every action from its picture. The table is checked live, healthy and with a forced dialog, then a person approves it. [The factory](docs/factory.md) has the detail.

## 3. From 80% to 100%

AI wrote nearly all of this; the author set the requirements, reviewed everything, and cut what was overbuilt. [The full account](docs/80-to-100.md) has the detail.

- **Thrown away: the first crawler.** It passed its tests and was still wrong, in a way the tests couldn't show. It read a JSON model of the DOM, written by an AI that had read the bank's source. So we rebuilt it from evidence: walk the rendered pages, keep the pictures, write a table from them. The first factory, where a Supervisor dictated steps and guessed at the bank's words, got the same treatment.
- **Hardened:** Submit pressed once, ever. A guard that froze the bank whenever a code contained the username. Docs claiming safety the code never had. A browser turned away as a bot, only inside Docker. Hazards so frequent that a third of runs needed a person.
- **Cut:** transfers over the manager threshold (a person finishes them); the factory for bank 1; desktop apps (the runtime is a browser, though the table and loop don't care); Vault.
- **Before trusting this unattended:**
  - more than one runner, in the cloud, behind a WAF;
  - the manager-approval page as a row of its own;
  - escalations that show a person the run's real inputs (today they're masked);
  - the full hazard matrix, nightly;
  - the factory on more banks of the same vendor.
