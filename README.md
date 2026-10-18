# Generic Bank

Banks run a lot of back-office screens with no API at all. This gives an AI agent one: it calls with typed inputs to check a balance or move money, and gets a typed result back. Behind it, a crawler works the bank's staff console the way a teller does, looking at each page before it clicks. A person approves every transfer. Anything the system can't finish safely goes to a person, with the pictures of what happened.

The target app is two local banks, both deliberately unfriendly: 2003-style consoles, server-rendered, framesets, nested tables, no test IDs. Each bank's crawler is written ahead of time, and runs without AI. For bank 1, AI wrote it from a recorded walk through the site, and a person reviewed it. For bank 2, an agentic software factory writes it on its own: two agents, a Scout and a Supervisor, work out the live site, and a person approves the result before it's used.

## Run it

You need macOS 14 or newer, [Docker Desktop](https://www.docker.com/products/docker-desktop/) and git. An 8 GB Mac is enough.

```sh
infra/scripts/bootstrap.sh      # installs just, checksum verified
just setup                      # once: checks the Mac, creates every secret, builds the images
just up                         # both banks, the API, the Console, the runner, memory, the factory
just show                       # Swagger UI, the Console, both banks and the simulated inbox
```

`just up` writes ACCESS.md, the one place with every page, login and member number. Then follow the two demos: [Demo 1](docs/demo-1.md) runs both tasks on bank 1, whose crawler AI wrote ahead of time, and [Demo 2](docs/demo-2.md) has the factory write bank 2's. The factory needs one key you bring: `just secret-set factory OPENROUTER_API_KEY`.

---

## 1. How the system fits together

![The system: boundaries, data, and where the risky parts live](docs/diagrams/system.svg)

An agent calls the **API** with a typed task, such as "check the balance of this member's checking account". The API starts a **run**. The run opens a browser and hands it to that bank's **crawler**, which works the bank's website the way a teller would.

The crawler never touches the browser directly. It acts through the **runtime**, and before every action the **guard** checks that the action is allowed.

Sometimes only a person can answer: a sign-in code, a transfer to approve, a page nobody has seen before. Then the run waits in the **Console** until someone does.

The **factory** works on its own, never during a task. It writes the crawler for a new bank, and a person approves it before any run uses it.

**The key decisions, and what each one costs:**
- **A typed contract, not a chat.** Each task has one schema. The API's input checks, its OpenAPI page and the agent's tool definitions are all generated from that schema, so they can never disagree. A balance comes back in a single call, which waits up to 60 seconds. The cost: if a run takes longer, the agent has to poll `GET /tasks/{runId}`.
- **Look at the page the way a person does.** The runtime reads what the browser renders: a picture of the page, the text and controls a person can see, and where they sit. It never reads the bank's source code or relies on how its HTML is structured. This is slower, because it waits for each page to stop changing. In return, framesets, nested tables and buttons made of styled text don't trip it up.
- **AI writes the crawler ahead of time, and nothing improvises during a task.** A crawler has two parts. The engine is shared code that every bank uses: it looks at the page in front of it, works out which page it is, and carries out the steps for that page. The table is the only part written for each bank: a list of the bank's pages, the words that identify each one, and the exact steps a teller takes there. Once the table is written, the crawler is deterministic, so the same page always gets the same steps. That makes runs cheap, repeatable and easy to audit. If a page isn't in the table, the run stops and asks a person instead of guessing.
- **A new bank is a new table, not new code.** Banks running the same vendor product share the engine, the runtime, the guard and the API. Only the table differs. Bank 1's table was written by AI from a recorded walk through the site, and reviewed by a person. Bank 2's is written by the factory on its own. A person only enters the bank's sign-in code and, at the end, approves the table. The cost: a crawler can only do what its table describes, so when a bank changes its pages, its table has to change too. A different kind of app, such as a desktop program, would need a new runtime.

**Why the boundaries are where they are.** The agent only ever sees tasks, never pages. Only the runner holds a browser, so a bank that hangs can't take the API down with it. The guard sits on the one path every action has to take. It judges the name of the page and the name drawn on the control, and ignores anything the page's text says, so a page can't talk it into anything. And no AI model ever sits between an agent's request and a bank's Submit button.

The risky parts are the Submit press, the passwords typed at sign-in, and the pictures kept as evidence. [The architecture](docs/architecture.md) shows the data models and how each risky part is handled.

## 2. How it meets the task and minimum scope

**Two typed tasks, end to end.** `POST /tasks/check-balance` and `POST /tasks/transfer` each take typed inputs and return one structured result. An agent can discover them with `GET /banks` and `GET /tools`. Both tasks run all the way through bank 1's web UI.

**Driving the messy legacy UI.** The target app is built to look like a staff console from 2003. It uses framesets and nested tables, has no test IDs, puts each label in a table cell of its own, and draws some buttons as styled `<font>` text. The runtime copes with this the way a person would:
- It waits until the page is ready: two pictures taken 700 ms apart match, and nothing says "loading".
- It finds a field by the label drawn next to it.
- It finds a button by the name drawn on it. If two buttons share a name, it takes the one closest to the section it means.
- It clicks with the real mouse, and refuses if something is covering the control.

Bank 1's table was written from [a recorded walk through its pages](docs/evidence/bank-1/README.md), and every row points to the picture it came from. Walking the real pages turned up seven problems the synthetic tests had missed, and each one became a rule in the runtime.

**Keeping outcomes apart.** Different kinds of outcome reach the caller in different ways:

| Kind | Example | The caller gets |
|---|---|---|
| The bank's own answer | "No member found with that number." | 422, `no_such_member` |
| Recovered inside the run | a dialog, a promo, a swallowed click, a session that ended early | 200; the run's steps show what happened |
| Hard failure | the bank is down, or shows an error page | 503 with `retryable: true`, or 502 |
| Handed to a person | an unknown page, stuck, an unclear transfer | 409 `escalated` |

On every page, the crawler first checks for the bank's own answers, by their exact words. If something goes wrong, it goes back to the home page and starts again, at most twice, and never after pressing Submit. If that doesn't work, the run fails. The outcome tests prove one of each kind, and `just hazards all` forces all 18 kinds of trouble the banks can throw.

**Escalating when stuck.** A run stops and hands off to a person when:
- it reaches a page no row recognizes;
- it sees the same page three times in a row;
- after a transfer, the account's history doesn't show it exactly once;
- the guard refuses an action;
- bank 1 asks for a supervisor's approval, which happens for transfers over $2,500.

The API answers 409 with an `escalationId`. The escalation shows up in the Console's Inbox, linked to the run, where a person can see every step and a masked picture of every page, up to the one where it stopped. From there they can resume the run, finish it by hand and record the result, take it over, or cancel it. The escalation test goes through it via the API: 409, then Resume, then 200.

**Safety with regulated data.**
- **An allowlist.** Each task has a short list of allowed actions. Each entry names a page, a verb and a control. Every action is checked against the list before it happens. Some controls are refused everywhere, whatever a list says: Pay now, Add payee, Change address, Waive fee and Close account. Anything that moves money needs a person's approval. The first time the guard refuses something, it freezes that bank until an admin clears it.
- **Actions that can't be undone.** A transfer stops on the bank's review page and waits. When a person approves it, they issue a grant that works once, lasts five minutes, and only matches what the review page shows. Submit is pressed once. If the bank's answer is unclear, the crawler looks for the transfer in the account's history instead of pressing again. And sending the same `idempotencyKey` twice returns the same run rather than making a second transfer.
- **Nothing sensitive is kept.** Before anything is stored, money amounts, account and member numbers, and names are painted out of every picture and masked in the page text and addresses. A run's inputs and the sign-in codes are stored sealed. The bank password is only ever typed from a stored secret. The PII suite runs both tasks, then searches every database row, stored file and log line for every seeded value.

**Evidence.** Every page a run sees becomes a step, saved with its masked picture and its visible text. The Console shows each run step by step, with its pictures, so you can see exactly what happened.

**Scale.** A bank is a table, and each run is durable and stands on its own, so the design can grow. But there's no scaling machinery here: one runner, on one laptop, handling two runs at a time.

**The extension: reuse across tenants.** Bank 2 runs the same vendor product as bank 1, configured and branded differently. Until it's learned, `GET /banks` marks it `"stub": true`. The factory's Scout explores it and writes its table, while a Supervisor checks every action the Scout takes, from a picture of the page. The table is then tested on the live bank, once as normal and once with a surprise dialog forced, and a person approves it before it serves anyone. [The factory](docs/factory.md) explains how.

## 3. From 80% to 100%

AI wrote nearly all of this code. The author set the requirements, reviewed the work, cut what was overbuilt, and pulled it back whenever it drifted. [The full account](docs/80-to-100.md) has more.

**What we threw away.** The first crawler passed its tests, but it was wrong in a way the tests couldn't show. It found pages by reading a JSON model of the HTML, and the AI that wrote it had read the bank's source code, so it relied on things no teller could ever see. We rebuilt it from evidence instead: walk the real pages, keep a picture of each one, and write the table from those pictures. The first factory had a similar problem: its Supervisor told the Scout every step and then guessed at the bank's wording. We rebuilt that too, so the Scout acts, the Supervisor checks, and a person approves.

**What we hardened:**
- **Submit is never pressed twice.** If a bank hangs after Submit, pressing again could move the money twice. Now, when the result is unclear, the crawler waits ten seconds and reads the account's history instead. If the transfer is there exactly once, it's done. Anything else goes to a person.
- **The guard froze the bank by mistake.** The guard refuses to type a stored secret into the wrong field, and the teller's username counted as a secret. So a sign-in code that happened to contain the username froze the bank. Now only the password is checked, and usernames are at least 8 characters.
- **Docs claimed safety the code didn't have.** A line-by-line review of the docs against the code found confident claims nothing implemented. Each doc now says what the code really does.
- **Bank 2 turned the crawler away as a bot, but only inside Docker.** There the banks are plain HTTP, and Chrome leaves out headers every real browser sends. Chrome now treats the banks as secure sites, as it would over HTTPS.
- **Trouble was too frequent.** The banks' random hazards fired on every page, so about a third of runs needed a person. Now about 3% of runs meet one, and none fires on the transfer pages.

**What we cut:**
- Transfers over a bank's manager threshold. The run stops, and a person finishes it.
- The factory for bank 1. Its table was written from the recorded walk, and it's updated by hand when the bank changes.
- Desktop apps. The runtime drives a browser. The engine and the tables don't depend on it, so a desktop runtime could take its place.
- Vault. Encrypted files already hold every secret.

**What it still needs before running unattended:**
- more than one runner, in the cloud, behind a WAF;
- the bank's manager-approval page as a row of its own;
- escalations that show a person the run's real inputs (today they're masked, so taking over a transfer means asking the caller for the member and amount);
- the full hazard matrix, run every night;
- a step that scrolls until an item is drawn, for the long virtualized lists single-page apps use, where only the visible rows exist;
- the factory learning more banks of the same vendor.
