# Generic Bank: the plan

**[Part 1](#part-1-what-we-build)** is what we build. **[Part 2](#part-2-with-more-time)** is what more time would add. The
**appendices** hold the detail.

---

# Part 1: what we build

## 1. What we are building

1. **Four fake bank websites** on one made-up back-office product: the staff console a credit
   union employee uses to look up a member, check a balance, pull a statement or move money. Old
   and awkward on purpose (framesets, nested tables, no ids, content drawn by their own
   JavaScript), and they misbehave: slow pages, script errors, outages, timeouts, pop-ups.
2. **A crawler that does three jobs on them:** Check Balance, Transfer Funds and Download
   Statements. An AI agent asks for a job through a small typed REST API whose endpoints it loads
   as tools. The crawler reads the screen, then clicks and types like a person. It never
   uses a CSS selector. When it cannot go on safely, it hands the job to a person.
3. **A rule about money.** The crawler fills in a transfer and stops on the review page. Only
   after a person approves in our Console may it press the one button that moves money.
4. **A software factory** in which AI agents explore a new bank, write its crawler (usually a
   small profile, since the banks share a product), test it, and put it on probation until real
   runs prove it. The agents run on **pi** ([pi.dev](https://pi.dev)); every model call goes
   through our meter, and every limit lives in our code. *[The factory.](#7-the-software-factory)*
5. **A memory that learns.** Agents propose lessons; fixed rules keep or retire them by what
   really happened. *[How memory works.](#71-memory-how-the-factory-remembers)*
6. **An admin Console** showing every run, every masked screenshot, every agent decision, the
   approval inbox and each crawler's state.

All TypeScript on Node, run on a laptop with docker-compose and just.

**The demo:** an AI agent asks for balances, statements and transfers. Banks 1 and 2 work end to
end, transfers with a person's approval. The factory builds bank 2's crawler from what it learned
on bank 1. Banks 3 and 4 are left for the factory to learn.

---

## 2. How it fits together

![Generic Bank: the shape in one picture](diagrams/system.svg)

Three boxes ([§B.1](#b1-the-three-boxes)):

- **Box A, the app:** Task API, Console, task runner, crawler. Keeps nothing.
- **Box B, the data:** Postgres, object storage for masked screenshots, Memory. Reaches
  nothing. Staff passwords are SOPS secrets that only the Runner receives.
- **Box D, the factory:** the agents and their browser, created per factory session and thrown
  away after. Its sandbox, where untested crawlers run, has no route out.

The four banks stand in for the outside world; only the crawler talks to them.

Risk sits in four places: the money-moving click (behind a person's grant), typing passwords
(SOPS secrets only the Runner holds, never shown), masking (before anything is written), and
agent-written code (sandbox only, until a person approves it).

---

## 3. The agent's interface

**Three tasks:** `check_balance`, `transfer` and `download_statements`. Each takes typed inputs
(bank, member number, account, amount) and ends in exactly one typed result: `succeeded`, a
`business_outcome`, `needs_human` while a person approves or answers a code, `escalated`,
`failed` (saying whether a retry could help), `expired` or `cancelled`.

**One API for every bank.** `bank` is an input; the API finds that bank's promoted crawler for the
task in the registry and runs it. Every crawler implements the same three functions, enforced by the
factory's contract test, so a newly promoted bank simply appears: no new endpoint, no redeploy.

```text
 the agent ──▶ one API: check_balance · transfer · download_statements   (bank is an input)
                 │
                 ▼ the registry: which bank has a promoted crawler for which task
          Generic Bank      Example CU         Sample Savings     Placeholder FCU
          written by hand   built by factory   learned later      learned later
                 │
                 ▼ every crawler implements the same three functions
```

**REST, loaded as tools.** `GET /banks` says which banks support which tasks; `POST
/tasks/check-balance` and its siblings start a task; `GET /tasks/:id?wait=30` waits for it.
`GET /tools` returns tool definitions generated from the same types, so an agent calls the API
directly. OpenAPI and a Swagger page at `/docs` document it ([§D.1](#d1-tasks),
[§D.5](#d5-tools-for-agents)).

```json
{ "runId": "r_8f2c", "status": "succeeded",
  "data": { "account": "Checking ending in 7890", "availableCents": 123456,
            "currentCents": 130010, "asOf": "2026-10-14T18:02:11Z" } }

{ "runId": "r_91aa", "status": "needs_human", "code": "awaiting_approval",
  "message": "A person must approve this transfer before it is made." }
```

The agent never gets a screen, selector, screenshot, page text or password. `transfer` answers
`needs_human` until a person approves it. It also requires an idempotency key, so a retry never
makes a second transfer.

**OAuth2.** An admin creates an API client per agent in the Console. The agent trades a one-time
code for an access token (15 minutes) and a refresh token (30 days) and keeps refreshing.
Reusing a spent refresh token cancels all the client's tokens ([§D.6](#d6-oauth2-clients-tokens-and-refresh)).

**The HTTP status tells the agent what to do:**

| The task | HTTP | The agent |
|---|---|---|
| running, or waiting for a person | `202 Accepted` | asks again after `Retry-After` |
| succeeded | `200 OK` | uses the result |
| the bank said no for a business reason | `422 Unprocessable Content` | tells the member why |
| **stuck: a person must take over** | **`409 Conflict`** | tells the member a person is on it |
| expired or cancelled | `410 Gone` | starts again, or gives up |
| failed, a retry could help | `503 Service Unavailable` | retries after `Retry-After` |
| failed for good | `502 Bad Gateway` | gives up |

Error bodies are problem documents with the code, run id and retryability ([§D.7](#d7-http-status-codes)).
After a `409`, a person resumes, finishes by hand or cancels, and the agent just asks again; a
retry never starts a second run ([§D.8](#d8-escalate-resolve-retry)).

---

## 4. The banking sites

The product is **CoreLink Branch Console**, by a made-up vendor, Acme Core Systems. We use it
through one staff login per bank, never as a member.

| Bank | Address | Role in the demo |
|---|---|---|
| Generic Bank | `localhost:8081/corelink/` | crawler written by hand |
| Example Credit Union | `localhost:8082/` | crawler built by the factory |
| Sample Savings Bank | `localhost:8083/online/branch/` | for the factory, later |
| Placeholder Federal Credit Union | `127.0.0.1:8084/cu/ib/` | for the factory, later |

Nothing shows without their JavaScript. Nothing has an id. Some labels and buttons are pictures
of text, things go wrong at random, and each bank differs in labels, layout, account formats and
supervisor threshold. Generic Bank looks like 2003. Each bank keeps its own ledger and generates
statements from it. Details: [Appendix C](#appendix-c-generic-bank-the-target-product).

---

## 5. The crawler and its three jobs

- **Check Balance:** sign in, look up the member, find the account by its last four digits, read
  the available and current balance.
- **Download Statements:** sign in, look up the member, open the account's statements, press
  "Statement" for each month asked for, keep the PDF.
- **Transfer Funds:** sign in, look up the member, fill in the transfer, stop on the review page
  for a person (chapter 6); after approval, press once and confirm the transfer in the account's
  history.

It drives a real Chrome, lets the page's JavaScript run, and reads what was drawn from outside the
page. It finds controls by meaning (the box next to the word "Amount"), picks accounts by number,
and checks which screen it is on after every action; on an unknown screen it stops and asks a
person. A business no gets reported. A glitch it can recover from is handled quietly. A hard failure
is reported along with whether a retry could help, and anything unsafe goes to a person. No AI model runs inside
these jobs. Details: [Appendix D](#appendix-d-task-api), [Appendix E](#appendix-e-the-runner-driving-a-messy-ui), [§D.4](#d4-how-failures-are-handled).

### 5.1 The browser's fingerprint: Chrome on a Mac

The crawler shows one consistent identity, **Chrome on an Apple-silicon Mac**. It is set before
any page script runs and never changes within a session. The browser's own controls set most of
it; a small extension of ours, which never reads the page, sets the rest. A test compares the browser field by field with a capture from a real Mac. Banks 2, 3 and 4
answer anything not shaped like a browser with "403 Access denied"; bank 1 checks nothing.
Values: [§E.8](#e8-browser-identity-set-at-launch), [Appendix W](#appendix-w-browser-identity-reference).

---

## 6. Transfers need a person

![A transfer: prepared by automation, approved by a person, one click](diagrams/transfer.svg)

The crawler prepares the transfer and parks. A person sees the masked review page in the Console
and approves, rejects or takes over. Approval creates a single-use grant tied to that amount and
those accounts; the guard lets one click through with it, and only if the screen still matches. If
the result is unclear, the crawler never presses again: it looks for its memo code in the
account's history, then confirms or hands it to a person. Details: [Appendix F](#appendix-f-transfers-a-human-approved-activity).

---

## 7. The software factory

It teaches the crawler a new bank for the product's three goals: check a balance, prepare a
transfer up to the review page, and download statements where the bank offers them.

Two agents on pi. The **Scout** navigates: simple steps in a live browser toward the goal, each
page reported as a frame. The **Supervisor** looks at every frame (the masked screenshot and the
visible page as JSON), reasons about where the Scout is, and tells it the next step. Only the
Supervisor recommends: it drafts the bank's profile, and every claim in it cites the frames that
show it and says whether it was **seen** there or is a **guess**. A person approves it with those
frames in front of them; a guess is never approved by default.

The approved profile is then run against the bank with each hazard forced, and must give the
outcome table's result for each. Two clean real runs on probation earn promotion. Build sheet:
[M7](../build/M7-factory.md).

No agent tool moves money, runs script in a page or reaches an unknown site; agent code runs only
in the sandbox until approved. Without an API key the factory replays a recorded run (mock mode).
Only the factory spends money on models: **$25 per run and $150 per rolling week**, with turns,
sign-ins and hours capped too, all in code ([§M.5](#m5-caps-in-code)).

Details: [Appendix M](#appendix-m-the-software-factory), [Appendix N](#appendix-n-evaluations), [Appendix O](#appendix-o-the-prompt-library).

---

### 7.1 Memory: how the factory remembers

Without memory, every factory job starts from zero and rediscovers what the last one
learned. With memory, the factory learns from each job, from its successes and its mistakes,
and from every crawler it has shipped. The second CoreLink bank is cheaper than the first.

Memory keeps four kinds of thing:

- **Episodes:** what happened in each run. Always trusted, because they are records, not
  claims.
- **Hypotheses:** what an agent believes but has not proven. Never served as truth.
- **Facts:** claims about a bank, proven by a run that succeeded, such as "a fresh sign-in at
  Example Credit Union asks for a staff code by email".
- **Lessons:** advice for future jobs, such as "choose an account by its number, never by its
  position". Each lesson says what it rests on, and whether it holds for one bank, for every
  bank on the same product, or everywhere.

The agents may only propose. **Promotion is the proof:** when a crawler is promoted, memory
checks its own records and confirms the lessons those runs relied on. **Forgetting is by
evidence:** a contradiction disputes a lesson, two retire it, and a demotion undoes what its
promotion confirmed. Fixed rules do all of this; no model decides. A person approves anything
meant to hold everywhere. Nothing is ever overwritten, and every change is recorded with who
made it and why.

**Where it lives.** All of it is in one Postgres database on box B, behind one service, the
only thing allowed to open it. There is no graph database. Each kind of memory is a table:
episodes, hypotheses, facts, and the lessons with their versions. Every lesson and episode
also carries an embedding (a vector from a small local model, stored with pgvector), so the
service can find "things like this". Exact words go through Postgres's own full-text search. A last table, the change log, records every write.

**Why a model?** For a sample this size, Postgres alone would do. It can match lessons that
are worded almost the same, and find them by keyword. What it can't do is see the same idea put
differently, like "member search is behind a menu" and "the search sits under Menu". That's how
lessons from different banks tend to come out. Graphiti, in Part 2, searches by meaning too. All
this costs one package and a 130 MB model, downloaded once and run locally.

**How facts and decisions are written down.** A fact has a lifespan. It carries the moment it
became true (`valid_at`) and, once something contradicts it, the moment it stopped
(`invalid_at`). A fact is never deleted, only closed, so memory can always answer "what did we
believe when that run happened?" Decisions work the same way. When a rule confirms, disputes
or retires a lesson, nothing is edited in place: memory adds a new version of the lesson, plus
one row to the change log. That row says who decided (a rule, a role or a person), which run's
evidence it rested on, and what the lesson said before and after. It also carries a hash
chained to the row before it, so any tampering shows.

**Who writes and who reads.** Runs write episodes as they happen, by code. The Supervisor
writes proposed lessons at the end of a factory run. Memory itself writes confirmations and
facts, and only when a promotion checks out against its own records. A person writes only
approvals. As for reading: every factory run starts with a **knowledge pack** (the lessons and facts
that matter for this bank, best first). Agents may ask follow-up questions mid-run, and people
read everything in the Console. The crawler doing real jobs reads nothing from memory. It runs
as reviewed and only reports back what happened.

It starts with a cleaned set of rules, lessons and failure scenarios, so the first run is not
a blank slate. In Part 2, memory moves onto a graph, Neo4j with Graphiti for the facts. The
ideas stay the same. *[Read about memory on a graph.](#20-memory-on-a-graph-neo4j-and-graphiti)* Details: [Appendix K](#appendix-k-memory-how-the-agents-remember).

---

## 8. The Console: where people step in

Our operations website, on **AdminJS** over the shared Postgres. A person comes to it when:

- **a transfer needs approval** (large ones also need the bank's supervisor code)
- **the bank sent a staff code** (the crawler cannot read the inbox, by design)
- **the crawler is stuck** on an unknown screen or an unclear transfer: take over or cancel
- **the crawler generator is stuck:** a factory run hands back what it knows, what it does not,
  and what would settle it
- **a new crawler is ready for review:** approve for probation or reject

Every action is also an API call and needs a written reason. Nothing unmasked is shown. The
Console also shows the read-only allowlist, the prompts (edits are drafts until their evals
pass) and the memory. Details: [Appendix G](#appendix-g-the-console).

---

## 9. Reviewing the evidence

Every run leaves a trail: a frame for every page it acts on, grabbed as soon as the page is ready
(a masked screenshot and the visible page as JSON), with the screen, the action and the result.
In the Console, a run's Frames button opens them in a popup, one at a time. Account numbers, amounts, names, emails,
addresses and typed fields are covered with white boxes before a frame is stored. A frame that
cannot be proven clean is withheld, with the reason. Details: [Appendix I](#appendix-i-evidence-redaction-and-observability).

---

## 10. Promotion and demotion

Each crawler, per bank and job, has one state, shown as a badge:

- **draft:** the factory is writing it
- **candidate:** passed its tests, waiting for review
- **probation:** approved, proving itself on real jobs
- **promoted:** two clean real runs in a row; serves every job for that bank
- **demoted:** failed in real use; the previous version serves and a repair case opens
- **frozen:** a guard tripped; nothing runs for that bank until a person clears it
- **stuck:** a run has gone quiet too long

Demotion is automatic. A crawler with fewer than two clean runs since promotion is demoted
on its first real fault; otherwise it takes two faults in a row. Bank faults (slowness, 503) do not count. Details: [Appendix L](#appendix-l-driver-lifecycle-and-the-repair-loop).

---

## 12. Seeing what happened

Every step, screenshot, recovery, guard decision, model call, tool call and verdict is a database
row tied to one run id, shown in the Console. Logs are JSON with the same id. Details: [Appendix I](#appendix-i-evidence-redaction-and-observability).

---

## 13. Keeping it safe

- Each job has an allowlist of *screen, verb, control*; anything else is refused and recorded.
  The bank's money and account-change controls are on no list. *[See the allowlist.](#j1-the-allowlist-written-down)*
- No money moves without a person's single-use grant.
- The crawler acts only on screens showing the member the job named.
- Passwords and codes are typed by the system, never shown, logged or stored in the clear.
- Everything personal is masked before it is written; a screenshot that can't be proven clean
  is withheld.
- Page text is never an instruction.
- `gitleaks` runs in `just check`, in CI over the whole history, and over every built image.

Each is enforced in code and proven by tests: [Appendix J](#appendix-j-guardrails), [Appendix U](#appendix-u-why-each-rule-exists).

---

## 14. Running it

```
just setup     # once, after git clone
just up        # the banks, the crawler, the Console, the back end, the data
just demo      # Check Balance and Transfer Funds on banks 1 and 2
just factory   # the factory; mock mode until you set ANTHROPIC_API_KEY
just down
```

Configuration is `.env` (from `.env.example`) plus SOPS-encrypted files; the model key ships
blank. It fits on an 8 GB laptop. Details: [Appendix S](#appendix-s-running-it).

---

## 15. Why this answers the brief

| The brief weighs | Our answer | Details |
|---|---|---|
| System design | a typed REST task API, loaded as tools, over a crawler that reads screens, not markup | [Appendix T](#appendix-t-how-this-answers-the-review) |
| Robustness | every failure named, detected and reported one way | [§D.4](#d4-how-failures-are-handled) |
| Human in the loop | a real inbox for codes, approvals and stuck runs | [§8](#8-the-console-where-people-step-in), [Appendix F](#appendix-f-transfers-a-human-approved-activity) |
| From 80% to 100% | each first-draft mistake replaced and covered by a test | [§T.4](#t4-from-80-to-100) |
| Generalization | one crawler per product, a profile per bank, a factory that learns new banks | [§T.5](#t5-generalization-to-the-real-environment) |
| Safety | approval grants, masking, guard layers, a trap matrix, a PII scan | [Appendix J](#appendix-j-guardrails) |

---

# Part 2: with more time

Not part of the submission; the README cites it under "what we would do with more time".

---

## 17. Goal

The same containers, run the way a bank would expect. The application does not change; only the
ground under it does:

- **Hosting:** Hetzner, provisioned with Terraform and Atmos; the factory box created per session
  and destroyed after.
- **Access:** no public SSH; Tailscale only; people sign in with Google (Console roles from
  Google groups, four-eyes approvals).
- **Edge:** the Task API sits behind Cloudflare (a tunnel, a firewall, rate limits); nothing else
  is public.
- **Secrets:** Vault replaces SOPS for the staff credentials and the trusted-workstation
  cookies. They are read at the moment of typing, and they are dynamic, short-lived and rotated.
- **Encryption** at rest and in flight everywhere, keys in Vault; banks 2 to 4 on real HTTPS.
- **Workflows** move from DBOS to Temporal behind the same interface.
- **Ids:** every object in the model hierarchy has a UUID as its id (runs, steps, frames, human
  tasks, grants, drivers and their versions, clients), never a sequence or a short random string.
- **Memory** moves onto a graph ([chapter 20](#20-memory-on-a-graph-neo4j-and-graphiti)).
- **OCR** as a second masking check on every stored frame.
- **Frames in color** instead of gray.
- **Real Chrome on real Macs,** so every fingerprint field is genuine.
- **Health from outside:** each service keeps its bare `/healthz` for its own container, and
  adds a second endpoint that an outside monitor calls. It checks what the service needs to do
  its job (Postgres, MinIO, memory, each bank it drives), each check with a short
  timeout, and answers 503 naming every check that failed.
- **Uptime and a status page:** Better Stack checks every public URL every five minutes and
  publishes a status page. The list of monitors is a reviewed file in the repository, synced
  through Better Stack's API, not by clicking in its dashboard.
- **Detection and alerting:** Falco, CrowdSec, Wazuh, Vector, and ntfy to a phone.
- **Recovery:** encrypted, append-only backups, rebuild-and-restore, drilled.
- **Export and import:** `just export` and `just import` move the whole system's state to a
  fresh machine; `just memory-export` and `just memory-import` move Memory alone.
- **Traces:** every run is one OpenTelemetry trace, with a span per step or phase and model
  calls in the GenAI semantic conventions. `just trace …` reads one. `just observe` adds the
  Collector, Grafana Tempo, Loki and Grafana, with OpenTelemetry metrics beside the SQL views.
- **CI:** signed, scanned images pinned by digest; SonarQube quality gate.
- **Tests:** Part 2 adds the full hazard matrix, transfer safety under failure, every human path, a trap matrix, soak runs, and the factory and memory in depth.

---

## 20. Memory on a graph: Neo4j and Graphiti

Part 1 keeps memory in Postgres tables, because a laptop cannot spare much. The ideas are the
same in both parts: episodes, hypotheses, facts and lessons; proposals from the agents and
decisions by rules; nothing ever overwritten. Part 2 gives those ideas the store they want: a
graph.

**Why a graph.** Memory is about connections. A bank runs a product; the product has screens;
a screen has controls; a sign-in is gated by a code; a lesson is evidence for a scenario, which
is confused with another scenario, which an approach recovers from. In tables those are joins.
In a graph they are the data, and questions like "what do we know about every bank that shares
this sign-in screen?" become one short query.

**Neo4j is the store.** A graph database holds all of memory: every node, every relationship and
every version. It listens only inside box B, and only the Memory service opens it. Episodes,
hypotheses, lesson versions and the change log are written in plain Cypher by code, with no
model in the loop. It is backed up every night, encrypted, and a monthly drill restores the
backup and compares counts.

**Graphiti is the semantic layer, for facts only.** Each fact is a **bi-temporal edge** between
two entities, such as `Example Credit Union GATED_BY staff code by email`. The edge carries
`valid_at`, `invalid_at` and `expired_at`: when the fact became true in the world, when it
stopped being true, and when memory stopped believing it. A fact that stops being true is
closed, never deleted, so memory can say what was believed at the time of any past run. The
idea comes from the Zep paper's temporal knowledge graph for agent memory (arXiv:2501.13956).

- **Facts are built by code** from a run's records, in a fixed vocabulary, so no page text ever
  reaches a model through memory. Graphiti does ask a model one question: whether two entities
  or two facts are the same thing, and it asks only about the code-built triplet.
- **Retrieval is hybrid:** BM25 word matching and vector embeddings, fused by reciprocal rank.
  The embeddings come from a local model; no text goes to an outside API.
- **Graphiti's own episodes are not used.** Runs and attempts are written by our code, as they
  are in Part 1.

**How new data gets stored.** Every write goes through the Memory service, in this order:

1. **The run's episode.** When a run ends, code writes one run node and its attempt nodes,
   linked to the bank, the screens it reached and the outcome. No model is involved, and the
   write is signed with a key only code holds. A production task writes its episode through an
   outbox, so if memory is slow or down, the task doesn't wait.
2. **The screen.** Every incoming value passes the privacy screen. Anything shaped like a
   password, a code, an account number or a person is refused before it is stored.
3. **New lessons.** The Supervisor's proposals are embedded locally and compared with the
   lessons already held in the same scope. A near duplicate adds its evidence to the existing
   lesson; anything new becomes a lesson node with a first version, marked proposed. The
   served lessons the run relied on, and those it contradicted, are linked to it by edges.
4. **Hypotheses.** What the factory saw while exploring (screens, labels, transitions) is
   stored as hypothesis nodes. They are kept, never served as truth.
5. **On promotion, the facts.** Memory checks the promotion against its own records. If it
   holds, it adds a confirmed version to each lesson the probation runs relied on, and hands
   each verified fact to Graphiti. Graphiti finds or creates the two entities, looks for an
   existing edge that the new fact contradicts, closes that edge (`invalid_at`, `expired_at`),
   and adds the new edge with its `valid_at`. The hypotheses the fact came from are marked as
   proven.
6. **The change log.** Every one of these steps appends one node to the change log: who wrote
   (a role, a rule or a person), which run, what changed, and a hash chained to the node
   before. Each write and its log entry commit together, or not at all.

**The rest does not change.** The same roles and signed writes, the same privacy screen, the
same rules for confirming, disputing, retiring and widening lessons, the same knowledge pack,
and the same API, so the factory and the Console do not notice the move. Graphiti is a Python
library, so in Part 2 the Memory service gains a small Python companion for facts; the
service's API stays TypeScript.

**The move.** Part 1's tables map one to one onto the graph: episodes, hypotheses and lesson
versions become nodes, facts become Graphiti edges, and the change log keeps its hash chain.
`just memory-export` writes the bundle; the graph importer reads it, checks every hash, and
replays the change log in order, so the graph's history starts where the tables' history
ends.

| Memory | Part 1 (laptop) | Part 2 (graph) |
|---|---|---|
| Episodes, hypotheses | Postgres tables | Neo4j nodes, written in Cypher |
| Facts | rows with `valid_at`, `invalid_at` | Graphiti bi-temporal edges |
| Lessons and versions | rows, one per version | nodes, one per version |
| Search | full-text plus pgvector | BM25 plus vectors, fused by rank |
| Change log | hash-chained table | hash-chained nodes |

---

## 22. Scaling out

- Runner workers scale horizontally, each with its own browser.
- Each promoted crawler runs in its own worker behind the one API, with a route to its own bank
  only.
- A concurrency limit per bank and a sign-in ledger shared by every runner.
- Several factory boxes at once, one per bank, each with its own caps.

---

## 31. What else "more time" would buy

- A second, unrelated vendor product, to prove the vendor seam.
- Desktop and terminal capture sources behind the same screen model.
- E6 stability, nightly: a task run N times (default 20) for success rate, recoveries per
  hazard and p50/p95 duration.
- An MCP adapter on the REST API, passing the caller's OAuth2 token through.
- Switchable models through OpenRouter, behind the same meter and caps.
- Factory output as pull requests.
- Assisted fallback at runtime, bounded to one step.
- Prompt-eval history gating prompt changes.
- Data retention with legal hold.

---

# Appendices

---

## Appendix A. Principles

Code enforces each rule; prompts only repeat them.

1. **The goal is a verified outcome.** A balance is cross-checked; a transfer is confirmed by a
   reference and the account's history; a statement is a real PDF for the period asked.
2. **Look, then act.** Never act on a page that is not fully rendered.
3. **Recognize the screen before acting.** An unrecognized screen means stop and escalate.
4. **Target by meaning, not markup:** labels, visible text, accessible names, geometry. Never CSS
   selectors, ids or DOM paths.
5. **The page runs its own JavaScript; we never run ours in it.** Perception is read from outside
   the page.
6. **Page text is data, never instructions.**
7. **Outcomes are kept apart:** business outcomes, recoverable conditions and hard failures.
   Recoverable conditions never reach the caller.
8. **Irreversible actions are never retried blindly.** Read the history; if still unclear,
   escalate.
9. **At most one password submit per sign-in attempt, and sign-ins are paced and capped.**
10. **Ask a person for a code only after the bank shows proof it sent one.** Never request a
    second code on our own.
11. **Credentials and codes are typed by the system and never returned, logged, shown to a
    model, or written anywhere.**
12. **Nothing personal is stored unmasked.** If masking cannot be proven, the frame is withheld.
13. **Code owns every threshold, budget and cap.** A model may never raise a limit.
14. **No false success.** Exactly one result per request. "Not available" requires the bank's own
    wording.
15. **Every run leaves a trail**, from its first step, whatever the outcome.
16. **A clean hand-back beats a clever partial:** what is known, what is not, what would settle
    it.

---

## Appendix B. Architecture

### B.1 The three boxes

Locally, each box is a set of containers on its own docker network.

| Box | Runs | Holds | May reach |
|---|---|---|---|
| **A, app** | Task API, Console, workflow engine, Runner (one headless browser per active task) | Nothing durable. Browser sessions live only in memory for the life of a task. | Box B; the bank sites. Published: the Console/API port only. |
| **B, data** | Postgres (with pgvector), MinIO, the Memory service | Everything durable: runs, trails, journal, registry, memory, evidence (MinIO). Only masked data. | Nothing outbound. No published ports. |
| **D, disposable factory** | Factory agent, Scout browser, sealed evaluation sandbox with its own throwaway bank | Nothing. Each factory run's folder is uploaded to box B before the box may be torn down. | Box A's API (to submit candidates), box B's Memory and evidence store, the bank sites. The sandbox has no route out at all. |

The **bank sites** are "the world": a separate network only the Runner and the Scout browser
can reach, sharing no code, database or network with our system.

### B.2 Data models (control database, one Prisma schema)

| Model | Key fields |
|---|---|
| `task_run` | id, task, tenant, inputs (masked), idempotency key, status, result (typed), driver version, started, settled |
| `step` | run, seq, name, screen recognized, action, outcome, started, ms |
| `trail_frame` | run, seq, step, screenshot key or withheld reason, screen model key, host, path, at |
| `human_task` | run, kind (staff code, approval, take-over), status, context (masked), opened, answered, by, deadline |
| `api_client` | client id, secret hash, name, scopes, created by, revoked at |
| `oauth_token` | client, kind (code, access, refresh), token hash, family, scopes, expires, used or revoked at |
| `prompt_version` | prompt id, version, body, status (draft, active, retired), eval results, author, reason |
| `approval_grant` | human task, run, from ref, to ref, amount, memo token, nonce, expires, used at |
| `journal_entry` | run, seq, intent, action, result, prev hash, row hash (append-only, hash-chained) |
| `driver` / `driver_version` | tenant × task, version, sha256, kind (profile or code), state, source run |
| `registry_event` | driver, from state, to state, by, reason, at |
| `factory_run` | id, tenant, task, mode (build or repair), phase, status, spend, turns, stalls, started, last activity |
| `model_call` | factory run, role, model, prompt id and version, tokens in/out/cache, cost |
| `eval_result` | factory run or driver version, rung, passed, details |
| `repair_case`, `freeze`, `sign_in_attempt`, `audit_entry` | see [Appendix L](#appendix-l-driver-lifecycle-and-the-repair-loop) |

---

## Appendix C. Generic Bank: the target product

### C.1 One product, four banks

One fictional vendor product, **CoreLink Branch Console** by **Acme Core Systems**, the staff
console member-services employees use (the brief's "a legacy member-servicing console"). Our
system acts as an employee, through one staff service account per institution, never as the
member. Banks 1 and 2 have working drivers in the submission; banks 3 and 4 are variants kept for
the factory to crawl later.

| | Bank 1 | Bank 2 | Bank 3 (later) | Bank 4 (later) |
|---|---|---|---|---|
| Brand | **Generic Bank** | **Example Credit Union** | **Sample Savings Bank** | **Placeholder Federal Credit Union** |
| Product version | CoreLink 4.2 | CoreLink 4.3 | CoreLink 4.3, locally customized | CoreLink 4.4, the next vendor release |
| URL | `http://localhost:8081/corelink/` | `http://localhost:8082/` | `http://localhost:8083/online/branch/` | `http://127.0.0.1:8084/cu/ib/` |
| Driver in the submission | yes, written by hand | yes, written by the factory as a profile | no: crawled later | no: crawled later |
| Layout | banner, nav frame on the left, main frame | banner, tab strip frame across the top (from another origin), main frame | as bank 2, with an extra "notices" frame on the right | no frameset on the console: a drop-down menu bar, with the sign-in form inside an iframe from another origin |
| Styling | **2003, and proud of it:** gray beveled buttons, Verdana at 10px, blue underlined links, a scrolling marquee of notices, an animated "NEW!" GIF, spacer GIFs, outset table borders, and "Best viewed in Internet Explorer at 800×600" in the footer | teal and beige, sans-serif, larger type | maroon and cream, small dense type | flat gray, a "modernized" skin over the same tables |
| Sign-in labels | "Operator ID", "Password", "Sign In" | "Username", "Passcode", "Log In" | "Staff number", "PIN", "Enter" | "User", "Password", "Continue" |
| Member lookup | "Member Search" by member number | "Find Member" by member number | "Member Inquiry", by number or last name | "Search", one box, results in a popup window |
| Account wording | "Account ending in 7890" | "Share ****3456-S01" | "Acct 1234-5678-90" | "··· 7890 (Checking)" |
| Transfer wording | "Transfer Funds", "Submit transfer" | "Move Money", "Confirm" (an image) | "Internal Transfer", "Post" | split over two pages: "Amount", then "Accounts", then "Authorize" |
| Staff code | text or email, chooser page | email only | text only, and a "Terms updated: Acknowledge" page after sign-in | authenticator-style 6-digit code, no chooser |
| Supervisor approval over | $2,500 | $1,000 | $500 | $2,000 |
| Text drawn as images | none | several labels and the "Confirm" button | the section headings on the summary | none |

All four are the same code (`apps/bank`: Fastify, server-rendered templates, ES5 in the pages,
`pdf-lib`, no client framework) started with a different tenant config: labels, theme, layout
variant, URL base path, account format, thresholds, code style, and each page's markup dialect.
Banks 3 and 4 differ in ways a profile alone may not cover (an extra frame, a split transfer, a
popup result list). Where that happens, the tenant escalates until the driver learns the screen.

### C.2 The operator's journey

1. **Entry.** The base URL shows a blank "Loading…" shell. A script sends the browser on to the
   sign-in page after a delay.
2. **Staff sign-in.** Operator ID and password in nested tables, labels as plain text in a
   neighboring cell. The form arrives disabled and script enables it after a short delay
   ("hydration"). A **trusted workstation** (a 30-day cookie) gets a different "Welcome back"
   layout. Possible answers:
   - "The Operator ID and password do not match." (bad credentials)
   - "This operator is locked. Contact your administrator." (locked)
   - Too many attempts in 15 minutes lock the Operator ID for 30 minutes.
3. **Staff code.** "Where should we send your code?" (text or email), then "Enter the 6-digit
   code we sent." Codes go to the operator's fake phone or email ([§C.6](#c6-the-fake-message-inbox)). A code lives 5
   minutes and allows 3 tries. "That code is not correct." and "That code has expired." are
   separate messages. "Trust this workstation" skips the step for 30 days.
4. **Hand-off.** A blank `/auth/callback?code=…` page that holds for a moment before the console
   loads. It is mid-sign-in, not signed in.
5. **The console.** A frameset: the banner (branch name, "Good morning, Operator 0412"), the nav
   frame (Member Search, Transfers, Statements, plus decoys: Reports, Admin, Fee Waivers, Address
   Change), and the main frame.
6. **Member lookup.** "Member number" and "Search". Answers: a one-row result with the member's
   number, masked name and status; "No member found with that number." (no such member); "This
   member's record is in use by another operator." (a classic back-office runtime error);
   "Member status: Closed." (closed member).
7. **Member summary.** The main frame's banner now reads "Member 40017732 · A. Sample", which the
   member-scope guard checks on every screen ([Appendix J](#appendix-j-guardrails)). Below it, the view staff consoles
   share with consumer portals: one tile per account with nickname, "Account ending in NNNN",
   available balance, current balance, and "Activity" and "Statements" buttons. The tile table
   re-renders once shortly after it first appears.
8. **Activity.** A transaction table with a date-range control. Rows arrive by a late request
   after the page has drawn.
9. **Statements.** An account picker and a table: Statement Date, Statement Balance, Document
   Type, and a "Statement" button per row. The button opens a new window that receives the PDF
   by a plain GET. An "Enroll in eStatements" button sits on the same page.
10. **Transfer between the member's accounts.** From, To (each option shows nickname, ending
    digits and available balance), Amount, Memo, "Continue". Then a **review page** that repeats
    the transfer with "Submit transfer", "Edit" and "Cancel". Over the bank's threshold, a
    **"Supervisor approval required"** page asks for a supervisor ID and approval code; the
    person's approval in our Console lands here ([Appendix F](#appendix-f-transfers-a-human-approved-activity)). Then "Transfer posted.
    Confirmation number GB-48213-K." Possible answers:
    - "The amount is more than the available balance." (insufficient funds)
    - "Transfers from this account type are not permitted." (permission: IRA and CD accounts)
    - "Your operator role cannot transfer more than $10,000 per day." (limit)
    - "Enter an amount between $0.01 and $25,000.00." (validation)
    - "This account is restricted. Refer the member to a branch." (restricted)
11. **Sign out**, and a session that ends on its own after 10 idle minutes, with a one-minute
    warning dialog first.

Decoys that move money or change a member's record sit in plain view: "Waive fee", "Add payee",
"Change address", "Enroll in eStatements", "Pay now", "Close account". They are the money and
account-change traps the guardrails must never press.

### C.3 Deliberately legacy surfaces

The markup generator (`apps/bank/src/markup/`) turns a page description into a tenant's
dialect:

- **Framesets** after sign-in; some dialogs open as popup windows.
- **Nested tables** (four to seven levels) for all layout; `<font>`, `<center>`, spacer images,
  uppercase tags, inline `onclick`.
- **No ids**, no `data-*` hooks, no `<label for>`. Labels are text in a sibling cell, sometimes
  split across two cells, sometimes bold inside a font tag.
- **Markup that varies page to page:** a submit is an `<input type="image">`, a `<button>`, an
  `<a href="javascript:…">` or a clickable table cell.
- **Obfuscated names:** class names hashed per tenant and page; form field names randomized per
  session and mapped back by the server.
- **Text drawn as images** on bank 2 (labels and "Confirm") and bank 3 (section headings).
- **Content drawn by script** (`document.write` on older pages, JSON and `innerHTML` on newer
  ones). Member search results, account tiles, balances, activity rows, statement rows and the
  transfer form's account options exist only after script runs; the sign-in form is enabled
  only then.
- **Two sign-in pages:** a trusted workstation's "Welcome back" layout and a fresh browser's.
- **Frames from another origin:** bank 2's tab strip and bank 4's sign-in form come from the same
  host on another port (8092 and 8094), read through their own browser sessions. (It's a port and not a
  `*.localhost` name because, inside the Runner's container, such a name resolves to the Runner
  itself.)
- **Different URLs:** each bank has its own port, base path and host form; drivers take every URL
  from the tenant profile or a link on screen.
- **Stable over time:** markup comes from a build seed. A `BANK_UI_VERSION` knob simulates a
  vendor upgrade (relabeled fields, moved buttons) to exercise the repair loop.

### C.4 Runtime hazards

The brief wants "stable UIs, but real runtime errors". Two modes:

**Ambient mode** (default). Every response draws from a seeded random source (`HAZARD_SEED`),
logged to the bank's hazard log:

| Hazard | Default | Effect |
|---|---|---|
| Latency | every response | uniform 0 to 150 ms before the server answers; frames load independently, so the main frame may arrive last |
| Injected JavaScript error, harmless | 10% of pages | uncaught `TypeError` in the console; page still works |
| Injected JavaScript error, widget | 5% | one widget fails to draw (a balance shows "--", a dropdown stays empty) |
| Injected JavaScript error, fatal | 2% | the main frame shows "An unexpected error has occurred. Reference ERR-…" |
| Service unavailable | 3% | HTTP 503 page from the "gateway" |
| Confirmation dialog | 10% of member summaries | `window.confirm("This member has 2 unread alerts. View them now?")` |
| Promotional interstitial | 10% of first loads after sign-in | full-page "New in CoreLink" notice with "Not now" and "Learn more" |
| Record in use | 3% of member lookups | "This member's record is in use by another operator." (retry later) |
| Session warning and expiry | idle 10 min, plus 2% random early expiry | warning modal, then the sign-in page appears inside the main frame |
| Slow hand-off | 5% of sign-ins | the callback page holds for 2 to 3 seconds |

**Profiles:** `HAZARDS=default` (the rates above), `HAZARDS=gentle` (a quarter of every rate,
fixed seed; used by `just demo`), `HAZARDS=harsh` (double).

**Forced mode** (tests and evals). A request with a signed `X-Hazards` header gets exactly the
named hazards. It needs `HAZARDS_FORCEABLE=true` on the bank and a valid HMAC. Forced-only
hazards:

- **Swallowed submit:** the server commits the transfer, then the response is lost (the page
  hangs on a spinner, or returns a gateway error).
- **Swallowed click:** script cancels the first click on a chosen button.
- **Late rows:** activity or statement rows arrive a second after load.
- **Injected instruction:** text on the page addressed to "automated assistants" asking for a
  payment or a new payee.
- **Unknown screen:** a page the product has never shown ("System maintenance: please verify
  your mailing address to continue").
- **Permission denial**, **record not found**, **validation errors**: forced on demand for any
  member.

**Banks 3 and 4 carry their own trouble:**

| Bank 3, Sample Savings Bank | Bank 4, Placeholder Federal Credit Union |
|---|---|
| a hidden copy of the password field and Sign In button earlier in the page | a hand-off that briefly draws the console, then returns to the sign-in page |
| a field whose script reads its value only from key presses, so a value set any other way is lost | an expired code clears the field with no message |
| privacy notices and tax forms listed in the statements table beside statements | the Statement button replaces the main frame with an HTML viewer that has its own Download button |
| twelve statement rows, then "View more statements" | statement links carry a per-window token, so a request made outside the opened window is refused |
| a per-row Options menu whose items are drawn at the end of the page, away from the row | account tiles drawn in a different order on every load |
| a fixed notice bar over the bottom of the main frame that covers the submit control | a "Bill pay is temporarily unavailable" notice on a summary that works |

**Banks 2, 3 and 4 answer "403 Access denied" to anything not a browser:**

- curl, recognized by its user agent (`curl/<version>`) or by its whole request being `Host`,
  `User-Agent` and `Accept: */*` and nothing else ([§W.5](#w5-what-curl-sends))
- a page request without what every browser sends: `Accept-Language`, `Sec-Fetch-Mode` and
  `Sec-Fetch-Dest`
- a headless user agent (`HeadlessChrome`)
- client hints that contradict the user agent: a Mac user agent with `sec-ch-ua-platform:
  "Linux"`, or a desktop one with `sec-ch-ua-mobile: ?1`

Each refusal is logged with its reason. Health checks and the bank-admin API are not screened.
Bank 1 screens nothing.

**Ground truth.** A state-change counter and a transfer ledger, read by tests through a
bank-admin API on a port only the test harness reaches. Tests never take the automation's word for
it.

### C.5 Data: where balances and statements come from

Each bank has its own Postgres database (`bank_generic`, `bank_example`, `bank_sample`,
`bank_placeholder`) in a small `bank-db` container on the world network:

- `operators` (staff, with roles: teller, senior teller, supervisor), `credentials` (argon2
  hashes), `workstations` (trusted-workstation cookies)
- `members` (number, masked-friendly name, status), `accounts` (type, nickname, number, owner,
  restrictions such as IRA, CD or "refer to branch")
- `ledger_entries` (double-entry; balances are always computed from the ledger)
- `transfers` (with memo, confirmation number, status)
- `one_time_codes`, `sessions`, `hazard_events`

`npm run seed` builds each bank from a fixed seed: one staff service account (a senior teller),
a supervisor, about 25 members with two to four accounts each, twelve months of history. The
members cover an IRA that cannot transfer, a near-zero balance, a restricted account, a closed
member, and member numbers that do not exist. Names are obviously fictional.

Statements are generated on request from the ledger with `pdf-lib`, and cached; golden PDFs exist
only as test fixtures.

### C.6 The fake message inbox

Staff and supervisor codes go to a fake phone and email inbox at `http://localhost:8089`, one
mailbox per bank, reachable by people and the test harness but **not by the Runner or the
factory**. A code is always a human step; tests answer codes through the same Console API a
person uses.

---

## Appendix D. Task API

### D.1 Tasks

| Task | Input | Success result |
|---|---|---|
| `POST /tasks/check-balance` | `tenant`, `memberId`, `account` (last four digits or nickname) | available and current balance in cents, as-of time, masked account label |
| `POST /tasks/transfer` | `tenant`, `memberId`, `from`, `to`, `amountCents`, `memo?`, `idempotencyKey` | confirmation number, transfer as read back from the account's history |
| `POST /tasks/download-statements` | `tenant`, `memberId`, `account`, `months[]` | one entry per month: a stored statement reference, or "not available" with the bank's wording |

`memberId` is the bank's member number. The system signs in as the bank's **staff service
account** (its credentials are SOPS secrets); no member credentials exist anywhere. A task call returns `202`
with a run id; `GET /tasks/:id?wait=30` long-polls. Every call carries an OAuth2 access token
([§D.6](#d6-oauth2-clients-tokens-and-refresh)). `bank` is checked against the registry on every
call. `GET /banks` returns each bank's id, brand and product version, plus its supported tasks and the
crawler version serving each. `GET /tasks` lists the tasks with their input schemas.

Inputs and results are zod schemas in `packages/contracts`. The OpenAPI document
(`GET /openapi.json`, with examples for every status code of [§D.7](#d7-http-status-codes)) and
the tool definitions are generated from them. `/docs` serves Swagger UI with bearer authorization; `just
docs` publishes a static reference. A test fails if the OpenAPI document, the tool definitions and
the endpoints disagree.

### D.2 The result

Every run ends in exactly one of these:

| Status | Meaning | Examples | Caller does |
|---|---|---|---|
| `succeeded` | Done and verified | balance read; transfer confirmed and seen in history | uses it |
| `business_outcome` | The bank said no, for a business reason | `no_such_member`, `member_closed`, `no_such_account`, `insufficient_funds`, `permission_denied`, `account_restricted`, `limit_exceeded`, `invalid_amount`, `approval_rejected` | tells the member |
| `needs_human` | Parked, waiting for a person | `awaiting_staff_code`, `awaiting_approval` | waits (long-poll) |
| `handed_off` | A person took over and finished or abandoned by hand | `taken_over` | reads the person's note |
| `escalated` | The system stopped because it could not safely proceed | `unknown_screen`, `stuck`, `ambiguous_outcome`, `guard_tripped` | waits for a person |
| `failed` | Hard failure | `app_error`, `unavailable`, `record_in_use`, `operator_locked`, `bad_credentials`, `step_timeout`, `no_driver` | retries later only if `retryable` is true |
| `expired` | Nobody answered in time | | asks again or gives up |
| `cancelled` | Stopped by a person or the caller | | nothing |

Each non-success result carries a `code`, a `retryable` flag, a fixed customer-safe `message`
and a `runId`. A filter replaces any message carrying raw page text, selectors, stack traces or
internal hosts with one of three canned sentences, and logs the original.

### D.3 Recoverable conditions

Handled inside the run, bounded, recorded in the trail, never shown to the caller:

- dismiss a known dialog or interstitial with the non-committal answer ("Not now", "Cancel",
  "Stay signed in")
- sign in again once after a session expiry, and return to the same screen
- retry a 503, a fatal-script error page or a slow load, at most twice with backoff, **for reads
  only**
- reload once when a needed widget failed to draw

When a bound runs out, the run becomes a hard failure or an escalation.

### D.4 How failures are handled

| Kind | Rule | The caller sees |
|---|---|---|
| **Business outcome** | the bank said no for a reason a member would understand; stop, report it | `business_outcome` with a code |
| **Recoverable condition** | handle it inside the run, bounded, recorded; never let it reach the caller | nothing, unless the bound is used up |
| **Hard failure** | stop cleanly, leave a final frame, say whether a retry could help | `failed` with `retryable` |
| **Escalation** | stop where it is safe, keep the context, hand it to a person | `escalated` or `needs_human` |

Only reads are retried, at most twice; anything that could change state is checked, never
retried. Every bad ending leaves a final masked frame. Infrastructure fails closed: if a guard,
the secret store or the spend meter cannot be consulted, the action does not happen.

#### Failures in the bank

| Failure | Detected by | The system | The caller sees | Recorded |
|---|---|---|---|---|
| Wrong password | sign-in error screen | stops; never submits again | `failed: bad_credentials`, not retryable | step, frame, sign-in ledger |
| Operator locked or rate limited | lock screen | stops; freezes sign-ins for that bank until a person clears them | `failed: operator_locked`, not retryable | step, frame, freeze |
| Staff code needed | code screen with proof a code was sent | parks; opens a human task | `needs_human: awaiting_staff_code` | human task |
| Code rejected or expired | the bank's own wording | reports it; one attempt per code; asks for a new code only if the bank offers to send one | `needs_human` again, or `failed` after three rounds | human task, step |
| No member found, member closed | lookup result screen | stops | `business_outcome: no_such_member` / `member_closed` | step, frame |
| Record in use by another operator | lookup result screen | retries the read up to twice, then stops | `failed: record_in_use`, retryable | step, recoveries |
| Insufficient funds, permission, restricted, limit, validation | transfer or review screen | stops before anything is submitted | `business_outcome` with the code | step, frame |
| Slow page, late rows | fully-rendered wait | waits up to the step limit | nothing | span timings |
| 503 or fatal script error page | error screen signature | retries a read up to twice with backoff | nothing, or `failed: unavailable`, retryable | recoveries, frames |
| A widget failed to draw | screen model missing a needed control | reloads once | nothing, or `escalated: unknown_screen` | recovery |
| Session expired | sign-in screen inside the frameset | signs in again once, returns to the same screen, re-checks the member | nothing, or `failed` | recovery |
| Confirmation dialog, promo | dialog or interstitial signature | answers with the non-committal choice | nothing | recovery |
| Control moved before the click | re-read just before acting | re-targets, up to twice | nothing, or `escalated` | step |
| Layout cannot be read on a drawn page | empty screen model with a non-empty screenshot | waits and reads once more | nothing, or `escalated` | step, frame |
| Unknown screen, or two matches | recognition | stops where it is | `escalated: unknown_screen` | final frame, screen model |
| Unclear submit result | no confirmation screen | never clicks again; reads history for the memo token | `succeeded`, or `escalated: ambiguous_outcome` | journal intent, history read |
| Grant does not match the screen | guard before the click | refuses the click | `escalated` | journal, guard decision |
| Guard trip | any guard layer | stops; freezes the bank | `escalated: guard_tripped` | journal, freeze, notification |

#### Failures in our own system

| Failure | The system | The caller sees |
|---|---|---|
| Worker or browser crash mid-run | the workflow resumes at its last completed step; a lost browser means a fresh sign-in and a return to the same screen. A crash between a submit's journaled intent and its result sends the run straight to the history check; it never clicks again | nothing, or `escalated: ambiguous_outcome` |
| Stall (no step, no navigation for 3 minutes) | the watchdog saves a final frame and ends the run | `escalated: stuck` |
| Nobody answers a human task | the deadline ends the run | `expired` |
| Postgres down | the API answers 503; running workflows pause and resume when it returns | HTTP 503 on new calls |
| MinIO down | frames are held on the runner's disk (at most 60 a run) and uploaded when it returns; if they cannot be kept, they are withheld with the reason | nothing |
| Memory down | runs continue; their episodes wait in an outbox. The factory will not start a run without its knowledge pack | nothing for tasks |
| Masking cannot prove a frame clean | the frame is withheld; the run continues | nothing |
| No promoted driver for the bank and task | refused before any browser opens | `failed: no_driver`, not retryable |
| Invalid task input | refused by the schema with the field that failed | HTTP 400 |
| Same idempotency key twice | the existing run is returned | the same run |

#### Failures in the factory

| Failure | The factory |
|---|---|
| Model API error or timeout | retries with backoff inside the run's caps; then hands back |
| A cap reached (spend, turns, sign-ins, hours) | stops and hands back; a run can lower a cap, never raise it |
| Spend ledger unreadable, or a model with no known price | refuses the call; fails closed |
| The same failure twice, or three turns without progress | ends the build loop and hands back |
| A tool call outside the role's allowlist | vetoed, recorded, and the model is told why |
| An eval rung could not run | never a pass; the run reports "could not run" |
| Review gate not answered | one reminder at 24 hours; expires at 7 days |
| A regression on probation | reopens the build once; a second regression hands back |

### D.5 Tools for agents

`GET /tools` returns the API as JSON-schema tool definitions, generated from the zod contracts:

| Tool | Calls | Returns |
|---|---|---|
| `list_banks` | `GET /banks` | every bank and the tasks it supports now |
| `check_balance` | `POST /tasks/check-balance` | the typed result of [§D.2](#d2-the-result) |
| `transfer` | `POST /tasks/transfer` | `needs_human` until approved, then the result |
| `download_statements` | `POST /tasks/download-statements` | one entry per month |
| `get_task` | `GET /tasks/:id?wait=…` | the task's current result |

Each description says what the tool does and never does (no money moves without a person). A
contract test fails on any difference between a tool and its endpoint. The agent calls the
endpoint itself with its own access token.


### D.6 OAuth2: clients, tokens and refresh

Bearer access tokens only; the authorization server is part of the API service. An admin creates
a client on the Console's "API clients" page (name, scopes, creator). The `client_id`,
`client_secret` and one-time starting code are shown once; only hashes are stored.

| Scope | Allows |
|---|---|
| `tasks:read` | `GET /banks`, `GET /tasks`, `GET /tools`, `GET /tasks/:id` |
| `tasks:balance` | `check_balance` |
| `tasks:statements` | `download_statements` |
| `tasks:transfer` | `transfer` (it still needs a person's approval for the money to move) |
| `bank:<id>` (optional) | limits the client to the named banks; a client with no `bank:` scope may use every bank |

```text
 Console ──▶ client_id + client_secret + one-time code (24 h, single use)
 agent  ──▶ POST /oauth/token  grant_type=authorization_code   (client authenticates with its secret)
        ◀── access_token (15 min) + refresh_token (30 days)
 agent  ──▶ any API call       Authorization: Bearer <access_token>
 agent  ──▶ POST /oauth/token  grant_type=refresh_token        (before the access token expires)
        ◀── a new access_token + a new refresh_token; the old refresh token is now spent
 agent  ──▶ POST /oauth/revoke                                 (when it is done)
```

- Tokens are random and opaque; only a keyed hash of each is stored.
- **Refresh tokens rotate.** Presenting a spent one revokes its whole family and every access
  token issued from it, and the Console flags a possible theft.
- Revoking a client stops every token it holds.
- Errors follow the OAuth2 rules: `400 invalid_grant` for a bad or spent code or refresh token,
  `401 invalid_client` for a bad secret; on the API, `401` with `WWW-Authenticate: Bearer
  error="invalid_token"` for a missing or expired access token and `403 insufficient_scope` for a
  missing scope.
- Token requests are rate-limited per client, and every token issued, refreshed or revoked
  writes an audit entry.

### D.7 HTTP status codes

| Result | HTTP | Headers and body |
|---|---|---|
| `running`, `needs_human` | `202 Accepted` | `Retry-After`, `Location: /tasks/:id`; the body carries the status and, while waiting on a person, what kind of answer is pending |
| `succeeded`, `handed_off` | `200 OK` | the typed result |
| `business_outcome` | `422 Unprocessable Content` | problem details with the business code (`insufficient_funds`, …) |
| `escalated` | `409 Conflict` | problem details with the reason (`unknown_screen`, `stuck`, `ambiguous_outcome`, `guard_tripped`) and the human task id |
| `expired`, `cancelled` | `410 Gone` | problem details |
| `failed`, retryable | `503 Service Unavailable` | `Retry-After`; problem details |
| `failed`, not retryable | `502 Bad Gateway` | problem details |
| invalid input | `400 Bad Request` | the field that failed |
| unknown bank, or no promoted crawler for this bank and task | `404 Not Found` | problem details with `unknown_bank` or `task_not_available`, and the banks that do support the task |
| missing or expired token | `401 Unauthorized` | `WWW-Authenticate: Bearer` |
| missing scope | `403 Forbidden` | `insufficient_scope` |
| too many requests | `429 Too Many Requests` | `Retry-After` |

Problem details follow RFC 9457 (`application/problem+json`) with `code`, `runId` and
`retryable`. A tool call returns the same object, flagged as an error for every status but
`succeeded`, `handed_off` and the waiting states.

### D.8 Escalate, resolve, retry

```text
 agent ──▶ POST /tasks/transfer {…, idempotencyKey: K}
       ◀── 202 Accepted   Location: /tasks/r_91aa
 agent ──▶ GET /tasks/r_91aa?wait=30
       ◀── 409 Conflict   {code: "unknown_screen", runId: "r_91aa", escalationId: "h_33c1",
                           resolvable: true, retryable: true}
                     person, in the Console inbox (h_33c1):
                       Resume          clears the blocker on the bank, presses Resume
                       Finish by hand  does the job, records the result
                       Cancel
 agent ──▶ GET /tasks/r_91aa   (or the same POST with key K)
       ◀── 409 until a person acts
       ◀── 202 after Resume, then 200 succeeded
       ◀── 200 handed_off {result recorded by the person, resolvedBy, resolvedAt}
       ◀── 410 Gone after Cancel
```

- **Resume:** the crawler reloads, recognizes the screen and checks the member before acting. An
  unsubmitted transfer goes back through approval. For an unclear one, it reads the history and
  never resubmits ([§F.2](#f2-the-swallowed-submit-protocol)).
- **Finish by hand** records the person's result in the typed shape, with who and when.
- The same idempotency key always returns the same run. While a transfer is escalated, a new
  request for the same member, accounts and amount gets `409` pointing to the open run.
- A guard trip cannot resume (`resolvable: false`): the bank stays frozen until a person clears
  it.
- The inbox shows how long the agent has waited and how often it has asked.

---

## Appendix E. The Runner: driving a messy UI

The Runner is the crawler. A **driver** is its knowledge of one product's screens; a **profile**
adapts the driver to one bank.

### E.1 Perception: what the operator sees

A plain HTTP fetch of these pages returns an empty shell, so the Runner lets Chromium run every
bank script, waits until the page is **fully rendered**, and reads what was drawn **from outside
the page**. After every navigation or action it builds a **screen model**:

1. **Capture** over the Chrome DevTools Protocol: the browser's layout (`DOMSnapshot`: every
   visible node with box, text, input type, paint order) for every frame, the accessibility
   tree, and a screenshot. No script is injected. A cross-origin frame is read through its own
   DevTools session; if no session can reach it, it is marked unreadable.
2. **Flatten frames** into page coordinates.
3. **Keep only what is visible and on top,** by a hit-test at each control's center, so a hidden
   twin of a button cannot be clicked.
4. **Name pictures of text** without reading pixels: the factory's vision model names each
   image once, the profile stores its perceptual hash with that name, and the crawler matches
   images on screen against those hashes. An unmatched image has no name and is never clicked.
5. **Never treat an unreadable page as empty.** An empty layout read on a drawn page is retried
   once, then escalated with the screenshot; it never counts as "signed in".
6. **Assign references** `c1`, `c2`, … with role, name, box and state (enabled, checked, value
   present yes or no; never the value).

### E.2 Fully rendered, not "network idle"

Never network idle. A page is ready once its frames have loaded, the screen the step expects
is recognized, a control on it is visible and enabled, nothing says it is still loading (no
`aria-busy`, spinner, skeleton or short "Loading…" text), and its layout has held for 300 ms.

Failing that, it is ready when two screenshots 700 ms apart match and so does the layout
structure. A loaded, usable page that matches no known screen is handed back as an unknown
screen after 2 seconds, whether it is still or not. A page that is still loading gets up to a
minute.

Signed in means a recognized signed-in screen, never a missing password field. Every browser
call has its own timeout.

### E.3 Screen recognition

Every screen the product can show is a named **screen signature** in the driver: required
phrases, forbidden phrases, required control kinds, and an optional path hint (weak evidence
only). For example, `transfer.review` requires "Review your transfer" and a control named
"Submit transfer" or "Confirm", and forbids "Transfer submitted".

Exactly one signature must match above the threshold; none or two means **unknown screen**, and
the run escalates with the masked screenshot and screen model. Error and outcome screens are
signatures too ("We could not find a member…" is `login.no_such_member`).

### E.4 Targeting

Drivers never write selectors. They ask for things by meaning:

- `field("Amount")`: find the label text (with the tenant's synonyms), then the editable control
  that belongs to it by geometry: same row to the right first, then directly below, within a
  distance limit. Exactly one candidate, or it is an error, never a guess.
- `button("Submit transfer")`: the visible control whose name matches, from text, accessible name
  or learned image name.
- `tile("Account ending in", last4)` and `rowWhere(column, value)`: pick items by identity, never
  by position.

**Acting** uses the real mouse and keyboard at the control's center. Right before a click the
Runner re-reads the screen; if the control moved, it re-targets, up to twice. Typing is key by
key, from a fixed set. Every action declares the screens it may lead to; anything else is a
recoverable condition, a business outcome or an unknown screen.

### E.5 Drivers: one vendor, many tenants

A **driver** is a state machine over screens for one task, written once per vendor product
(`packages/drivers/corelink`). Each tenant is a **profile**: labels and synonyms, signature
overrides, account-number format, thresholds, code-delivery style, layout variant. When a tenant
behaves differently, the result is an escalation, never a wrong answer.

A **catalog** maps `(tenant, task)` to the promoted driver version (none means
`failed: no_driver`). Catalog keys are unique, checked by a test.

### E.6 Visual analysis, three layers

1. **Every run:** layout text, accessible names and learned image fingerprints. No model.
2. **Assisted fallback (Part 2):** one bounded vision-model call proposing a control, never on a
   money-moving control.
3. **Factory time:** the Supervisor judges every Scout step from the frame, and names the
   pictures of text.

### E.7 Time limits and the stall watchdog

Each step has a time limit (sign-in 2 minutes, a page 45 seconds, a download 60 seconds per
statement). A watchdog ends a run with no step and no navigation for 3 minutes, saves a final
frame, and reports `escalated: stuck`. It stands down while a run waits for a person.

### E.8 Browser identity, set at launch

Full Chromium in its modern headless mode (Debian's `chromium` in the Runner, Chrome for Testing
on a Mac and in CI) gets its identity ([Appendix W](#appendix-w-browser-identity-reference))
before its first page:

- **Launch switches:** `--lang=en-US`, no automation marker, a wide-gamut display, Web
  Bluetooth, software WebGL without a GPU, and the banks' origins treated as secure (Chrome sends
  Sec-Fetch headers and client hints only to secure origins).
- **The DevTools Protocol, on every page and frame before its first request:** the user agent
  and client hints (platform "macOS", architecture "arm", 64-bit, not mobile), languages
  `en-US,en`, Chrome's own brand list for the engine's version, eight cores, a 1440 × 900 screen
  at pixel ratio 2, locale `en-US` and the machine's timezone. A frame from another origin is
  held paused until it has its identity.
- **The identity extension** (`packages/screen/extension`), loaded over the DevTools Protocol:
  the WebGL vendor and renderer of an Apple M1, color depth 30, the working area below the menu
  bar and the Dock, 8 GB of device memory, and Web Share.

Screenshots are taken at the pixel ratio's inverse, so a picture keeps one pixel per CSS pixel.
A browser test compares the headers a bank receives and the values page scripts see with
`tests/fixtures/browser/mac-chrome.json`; the one known difference is where Chrome puts
Accept-Language when its user agent is overridden.

---

## Appendix F. Transfers: a human-approved activity

The automation prepares a transfer, a person approves it, and only then is it submitted.

### F.1 Flow

![A transfer: prepared by automation, approved by a person, one click](diagrams/transfer.svg)

1. **Prepare (nothing moves).** Sign in, find both accounts by identity, check the balance,
   fill the form, press "Continue", stop on the **review page**, recognize it, and read back
   from, to, amount and memo. A business outcome here ends the run.
2. **Park** as `needs_human: awaiting_approval`, deadline 15 minutes by default, browser session
   held open.
3. **Approve, in the Console,** where the person sees the masked inputs, the masked review
   screenshot, the amounts as read, and the trail:
   - **Approve:** issues a single-use **approval grant**, valid for 5 minutes. It is bound to
     this run, the masked from/to references, the exact amount, the memo token and a nonce. Over
     the bank's threshold, the approver also gives the supervisor approval code that the bank's
     "Supervisor approval required" page asks for.
   - **Reject:** the run ends `business_outcome: approval_rejected`.
   - **Take over:** the person finishes the transfer by hand; the run is recorded as
     `handed_off`.
   - **Cancel:** the run stops cleanly.
4. **Submit, under the grant.** The guard blocks every money-moving control. It lets one click
   through only with an unused, unexpired grant, only on the recognized review page, and only if
   from, to and amount match the grant. The click consumes the grant. The guard is never disabled.
5. **Verify** ([§F.2](#f2-the-swallowed-submit-protocol)).

One person may both start and approve a transfer; four-eyes approval is Part 2.

### F.2 The swallowed-submit protocol

- Before the click, the intent and grant id go to the hash-chained journal.
- Every transfer carries a **memo token** we generate (for example `GBX 7Q4M`). It's our idempotency
  marker, kept in the bank's own data.
- On the confirmation screen, read the confirmation number, then find the transfer in the
  activity by its memo token: `succeeded`.
- If the result is unclear (gateway error, spinner, no answer in 10 seconds, unknown screen,
  session lost), **do not click again**. Open the activity and look for the memo token, polling
  briefly:
  - found once: `succeeded`, with the reference read from history
  - found twice: `escalated: ambiguous_outcome` (a duplicate exists; a person must look)
  - not found: `escalated: ambiguous_outcome`. Never resubmit.

If the session is lost while parked, it is rebuilt after approval: a fresh sign-in, the form
filled again, and everything re-checked against the grant. The grant binds values, not a browser.

### F.3 Codes and other human steps

- **Code needed,** once the bank shows proof it sent one ("Enter the 6-digit code we sent to
  …"): the person enters it in the Console; it is typed key by key and stored as `****`. One
  attempt per sent code; a rejection is reported. "Send code" counts as a send only when the
  bank shows it registered.
- **Unknown screen or stuck:** the person takes over or cancels.
- **Deadlines:** an unanswered human task ends the run `expired`.

Every Console action is also an API call: `POST /human-tasks/:id/answer|approve|reject|take-over|cancel`.

---

## Appendix G. The Console

The Console is **AdminJS** on the control app's Fastify server (`apps/control`), over the
control database's **Prisma** models. That gives every model lists, filters, search, detail
pages, relations, actions and role-based access. Custom components: the **trail viewer** (masked thumbnails, step, screen
and outcome, an "only the interesting parts" toggle), the **state badge**
([§G.3](#g3-state-markers)), the **approval inbox** over `human_task`, **reasoned actions**
(promote, roll back, freeze, unfreeze require a written reason), the **memory pages** (through the
Memory API; the Console never opens Memory's tables), and the **dashboard** and **cost** charts
from SQL views.

### G.1 Rules for every page

- **Newest first** on every list, enforced by a test; filters and search everywhere; every
  object links to its neighbors.
- Every state-changing action needs a **written reason** (at least ten characters) and writes an
  audit entry. Trail, journal and audit are read-only.
- Screenshots are shown only masked ([Appendix I](#appendix-i-evidence-redaction-and-observability)), through an allow-listed proxy; a withheld
  frame shows "Withheld: reason".
- URLs show host and path only, never a query string.
- Sign-in: AdminJS authentication over a local user table (argon2, session cookie), roles
  `viewer`, `approver`, `admin`, declared per resource and action.

### G.2 Pages

| Page | Shows | Actions |
|---|---|---|
| **Home** | waiting for a person, approvals pending, stuck runs, frozen tenants, drivers on probation, today's spend | links |
| **Inbox** | open human tasks with deadlines, oldest deadline first, and how long the agent has been waiting | answer code, approve, reject, resume, finish by hand (record the result), cancel |
| **API clients** | each agent's client, its scopes, last used, tokens alive, any refresh-token reuse | create (shows the secret and starting code once), revoke, revoke all tokens |
| **Task runs** | id, task, tenant, status, result code, driver version, duration. Filters: status, tenant, task, outcome | open |
| **Task run** | summary, typed result, the **trail** (one masked frame per step, thumbnails that open full size, "only the interesting parts" toggle), steps, human tasks, journal rows, network events (method, host, path, status, ms), evidence manifest | cancel |
| **Drivers** | per tenant × task: active, candidate and previous versions, **state badge**, last promoted, last demoted and why, probation progress | promote candidate, roll back, freeze, unfreeze (each with a reason) |
| **Driver** | versions, diffs between versions, promotion history, the runs that proved it, lessons it relied on | |
| **Factory runs** | id, tenant, task, mode, status, phase, spend, model turns, live verifications, stalls, last activity | stop |
| **Factory run** | summary, timeline with masked frames, model calls (role, model, prompt id and version, tokens, cost), eval results by rung, lessons served, proposed, relied on and contradicted, the run folder's manifest (path, size, sha256) | review gate: approve or reject the candidate |
| **Repair queue** | one case per tenant × task: status, consecutive failures, last failure, last success | mark in repair, won't fix, put back |
| **Freezes** | tenant, layer, run, reason, cleared | clear |
| **Sign-in ledger** | attempts per member and tenant, caps reached | clear today's cap |
| **Memory** | lessons (status, scope, seen in, served and relied counts), facts with their valid and closed times, episodes, the change chain, a knowledge-pack preview per bank | add or edit a lesson (a new pending version), retire a lesson, close a fact, approve pending changes, verify chain |
| **Allowlist** | every job's permitted actions (screen, verb, control), exactly as the guard enforces them, and every refusal | none: read-only on purpose |
| **Prompts** | the prompt library with every version, its includes, inputs and eval cases; from any model call, the exact version used and the masked text sent | edit or add a prompt (a draft), run its evals, activate it once they pass, roll back to the git version |
| **Journal** | every intended and performed action, hash-chained | verify chain |
| **Audit** | every Console action with its reason | |
| **Cost** | spend by day, role and run; cost to author each driver | |
| **Health** | each service, queue depth, oldest parked task | |

### G.3 State markers

Each driver version shows one state as a colored badge carrying the word:

| State | Meaning | Badge |
|---|---|---|
| `draft` | being written by a factory run | gray |
| `candidate` | passed offline evals and live verification; waiting for review | blue |
| `probation` | approved; must succeed on real runs before promotion | amber |
| `promoted` | serving real tasks | green |
| `demoted` | removed after production faults; the previous version serves | red |
| `frozen` | a guard tripped; nothing runs for that tenant until a person clears it | purple, striped |
| `stuck` | a factory run or task run shows no activity past its quiet limit | orange |
| `retired` | superseded and kept for history | outline only |

A task run shows `stuck` when it has produced nothing past its limit; a factory run, after 2
hours with no activity.

### G.4 Notifications

A Console banner and the log (ntfy is Part 2). Each stuck run, each frozen tenant, and each
approval waiting more than five minutes notifies once.

---

## Appendix H. The task runner

**DBOS** runs each task as a durable workflow whose state lives in our Postgres, so tasks survive
restarts and wait for people (minutes for an approval, weeks for probation) without holding
anything open. Workflow code calls our own interface (`startRun`, `waitForHuman`, `sleep`,
`step`). Side effects happen only in steps, a person's answer arrives as a message, and every
wait has a deadline. A task is: prepare, wait for a person if needed, act, verify, settle. A factory
run's workflow is in [§M.3](#m3-phases).

---

## Appendix I. Evidence, redaction and observability

### I.1 What every run writes

- **The trail:** one frame per step, grabbed when the page is ready ([§E.2](#e2-fully-rendered-not-network-idle)).
  A frame is a masked screenshot (viewport only, 8-bit gray PNG at one pixel per CSS pixel), the
  masked screen model as JSON (visible elements only; no shadow DOM, nothing hidden), host and
  path, the step and the time. At most 60 frames per run. A capture failure is logged and never
  breaks the run.
- **Steps:** name, recognized screen, action, outcome, timing.
- **The journal:** intent before every action, result after, hash-chained, append-only.
- **Network events:** method, host, path, status, duration. No bodies, no query strings.
- **The run folder** (factory runs): every file listed in a manifest of path, size and sha256,
  written last.

### I.2 Masking

- **Known values:** the member's credentials, codes, name, account numbers and email are known to
  the Runner before the run starts, and masked wherever they appear.
- **Patterns:** any run of four or more digits, any currency amount, emails, phone numbers,
  street lines.
- **Screenshots:** mask boxes come from the screen model, which knows where every piece of text
  is. These get a **white box filled with asterisks**, the way a redacted form looks: every input,
  every text run matching a known value or a pattern, and every image or canvas the crawler
  cannot read (unless the bank's profile marks it safe, like a learned "Confirm" button).
- **Withheld frames:** if a frame's screen model could not be read, or a known value appears
  outside a covered box, the frame is **withheld**: stored as a placeholder with the reason,
  never as an image.
- **Text and logs:** structured JSON logs (`pino`) with redaction of known keys, then a final
  scrubbing pass with the known values and patterns before anything leaves the process.
- **Results and errors:** customer-safe messages only.

`tests/pii` runs each task once on bank 1, scans everything written (database rows, MinIO
objects, logs) for every seeded secret and personal value, and checks that every place the bank
drew a seeded value is covered in the stored frame.

### I.4 Two signals, one id

```text
  api · console · runner · memory · factory
     │  every row and log line carries  runId · step
     │
     ├──▶ records ──▶ Postgres ──▶ the Console's timelines        source of truth
     │
     └──▶ JSON logs ──▶ stdout and .data/logs/*.jsonl            just logs
```

`runId` and step travel on every row and log line.

| Signal | Where it lives | What it is for |
|---|---|---|
| **Records** | Postgres, box B | the source of truth: runs, steps, frames, journal, human tasks, model calls, tool calls, evals, registry events |
| **Logs** | JSON lines on each container's stdout, kept in rotating files under `.data/logs/` | what each process was doing, in order, for debugging the system itself |

### I.5 What the crawler did

For a task run the Console shows every step, frame, recovery (with its hazard), guard decision,
network event ([§I.1](#i1-what-every-run-writes)), journal row and human task.

### I.6 What the agent did

For a factory run: every model call (role, model, prompt id and version, input, output and cached
tokens, cost, latency), every tool call (masked arguments, compact result, any veto), every
Supervisor verdict with its frame, every eval rung, the lessons served, relied on, contradicted
and proposed, and spend against the caps.

### I.8 Locally, and later

No extra containers: logs go to stdout and rotating JSON files, read with `just logs` and
`just logs <group>`. Traces and the Grafana stack are Part 2 ([§17](#17-goal)).

### I.9 Masking applies to telemetry too

Logs are masked like everything else, and frames are referenced by key. A test runs a task under
every hazard and scans the log files for every seeded value.

### I.10 Metrics

SQL views over the records, on the Home, Health and Cost pages: task duration, outcomes by code,
recoveries by hazard, guard refusals by layer, human-task wait time, model tokens and spend by
role.

---

## Appendix J. Guardrails

All in `packages/guardrails`, which imports nothing from drivers, the Runner or the factory. Each
layer is tested on its own.

### J.1 The allowlist, written down

One file per job in `packages/guardrails/allowlists/`, as *screen, verb, control*. The guard
enforces it and the Console renders it. Anything else is refused before the browser and recorded
with the rule and layer.

| Job | Screen | Allowed |
|---|---|---|
| every job | `sign_in` | type into "Operator ID" and "Password" (secret typing only), press "Sign In" |
| | `staff_code` | choose a delivery channel once, ask for a code or a new one, type the code a person supplied, press "Verify" |
| | `notice`, `promo`, `session_warning` | press the non-committal choice ("Not now", "Stay signed in"), or "Acknowledge" for updated terms |
| | `home` | open a menu |
| | `member.search` | type into "Member number", press "Search", open the one matching result |
| | any screen | open "Member Search", wherever the bank puts it (an open menu hides the page under it); press "Dismiss" on a notice drawn over the page |
| `check_balance` | `member.summary` | read; nothing else |
| `download_statements` | `member.summary`, `statements`, `statement.viewer` | press "Statements", choose the account, show more rows, open a row's menu, press "Statement" on each requested row; on a statement's own page, press "Download" and "Back to statements" (document GET only) |
| `transfer` | `member.summary` | open "Transfer Funds", and "Activity" to confirm |
| | `transfer.form` | choose "From" and "To", type "Amount" and "Memo", press "Continue" |
| | `transfer.review` | press "Submit transfer" **only with an unused grant whose values match the screen** |
| | `supervisor_approval` | type the supervisor code a person supplied, press "Approve" |
| | `activity` | read, to confirm by memo token |

Never on any list: "Pay now", "Add payee", "Change address", "Waive fee", "Enroll in
eStatements", "Close account", "Admin", "Reports". Widening a list is a reviewed code change,
never a Console form.

The lists name controls in the product's words. Each bank's reviewed profile gives its own, so
"Log In" counts as "Sign In". The names never on a list are refused first, whatever a bank calls
them.

### J.2 The layers

| Layer | What it does |
|---|---|
| **Task allowlist** | Each task declares its capabilities. `checkBalance`: read. `downloadStatements`: read plus document GETs. `transfer`: read, fill the transfer form, press "Continue", and the one granted submit. Anything else is refused before it reaches the browser. |
| **Session guard: network** | Only the tenant's own host is reachable. After sign-in, state-changing requests are refused unless the task allowlist names them (the transfer form's "Continue" and the granted submit). |
| **Session guard: element** | Every click and key press is classified from the control's visible name against money and account-change vocabularies ("Pay", "Transfer", "Submit", "Add payee", "Enroll", "Update", "Go paperless"). A generic "Continue" on a money page counts as money. Refused unless allowed. |
| **Session guard: page** | Pages are classified as read-only, money-moving, account-change or unknown. On a money or account-change page the session may read and leave, but not type or click, except as the task allowlist and a grant permit. |
| **Session guard: outcome** | After any click, watch for confirmation wording that should not appear. Seeing it trips the guard. |
| **Member scope** | The staff service account can reach every member, so every screen the Runner acts on must show the member number the task named. An action on a screen showing a different member, or no member where one is expected, is refused and trips the guard. |
| **Approval grant** | The single-use key for the one money-moving click ([Appendix F](#appendix-f-transfers-a-human-approved-activity)). |
| **Guard trip** | Ends the run `escalated: guard_tripped`, writes a journal row, freezes the tenant and notifies. Guard errors always propagate: a lint rule forbids catching them. |
| **Secret typing** | The Runner types credentials from its secrets and never returns them. Plain typing of any text that equals or contains a stored secret is refused. |
| **Injected instructions** | Handled structurally: guards judge controls and pages, never what page text asks for. A test checks that every guard verdict is identical with and without injected text. |
| **Sign-in pacing** | A ledger caps sign-ins per member per day and paces them. It fails closed if unreadable. |
| **Caps for models** | Spend per run and per week, turns, live sign-ins, active hours, failed checks, in one file with no imports. A run's input can lower a cap, never raise it. The meter checks before every model call and fails closed on an unreadable ledger or an unknown price. |
| **Tool allowlist** | A closed set of capabilities per role ([§M.4](#m4-tools)). No money capability exists. No tool runs script in a page. |
| **Code rules** | Lint rules on driver code ([Appendix N](#appendix-n-evaluations), E0). |
| **Network** | Compose networks enforce who can reach whom. The sandbox has no route out. |

**Proof:** the trap matrix runs every money trap and injected instruction on both tenants with
one guard layer removed at a time. A clean read task leaves the bank's state-change counter
unchanged.

A page's own background requests (analytics, feature flags, keep-alives) are refused quietly and
logged. They never trip a guard; the guards that trip judge only controls a person can see.

---

## Appendix K. Memory: how the agents remember

### K.1 The factory, and why it needs memory

The factory takes a work order (a new bank to learn, or a broken crawler to repair), and two
AI roles carry it out. The **Scout** navigates. The **Supervisor** watches every step, judges
the evidence, drafts the crawler's profile, and stops the job when something is wrong. The crawler is
verified against the real bank, goes to a person for review, runs on **probation** for two
clean real runs, and only then is **promoted**. One action rolls it back.

Without memory, every job starts from zero and rediscovers what the last one learned. With
memory, the factory learns from each job, from its successes and its mistakes, and from every
sibling it has shipped. The second CoreLink bank should be cheaper than the first; the fourth
should be cheaper still.

### K.2 What is remembered

| Kind | What it is | Example | Trusted when |
|---|---|---|---|
| **Episode** | what happened: one run, one attempt, its outcome and evidence | "Attempt 2 of a factory run signed in, found the member, opened the statements page, verified" | always; it is a record, not a claim |
| **Hypothesis** | what an agent believes but has not proven | "This bank probably needs a wait after the staff code is entered" | **never served as truth** |
| **Fact** | a typed claim proven by a run that succeeded | `Example Credit Union GATED_BY staff code by email` | only after a successful, promoted run (enforced) |
| **Lesson / pattern** | advice for future jobs, with its evidence and scope | "One member can hold several accounts; choose by identity, never by position" | once confirmed |

Episodes are **episodic memory**, facts are **semantic memory**, and lessons, together with the
curated rules, checks, scenarios and approaches, are **procedural memory**.

**What a lesson contains:** one sentence of advice, its area, the evidence it rests on (cited
by run, frame and hash), the scenario it belongs to, a scope, and a state: proposed,
confirmed, disputed, retired, or retired at one bank only. The scope is one of three:

- **tenant:** true of one bank
- **vendor:** true of every bank that runs the same product (CoreLink)
- **pattern:** true everywhere

A pattern is the most valuable kind and the most dangerous. One right pattern improves every
future job; one wrong pattern misleads every future job. So patterns are confirmed most
strictly, and only a person can approve a new one.

### K.3 Where memory lives

**Postgres is the store.** Memory has its own database (`memory`) on box B, with its own Prisma
schema, and only the Memory service opens it. Episodes, hypotheses, lesson versions and the
change log are written in plain SQL by code, with no model in the loop.

**Facts are bi-temporal rows.** Each fact carries `valid_at`, `invalid_at` and `expired_at`. A
fact that stops being true is closed, never deleted, so memory can say what was believed at
the time of any past run. The idea comes from the temporal knowledge graph for agent memory in
the Zep paper (arXiv:2501.13956); here it is a table, not a graph database.

- **Facts are built by code** from a run's records, in a fixed vocabulary, so no page text
  ever reaches a model through memory.
- **Search is hybrid:** Postgres full-text ranking and pgvector similarity, fused by
  reciprocal rank. Embeddings come from a small local model inside the service; no text goes
  to an outside API.
- **Duplicates merge.** A new lesson within 0.95 similarity of one already held, in the same
  scope, adds its evidence to that lesson instead of becoming a new one.

### K.4 How memory is used

**Recall at intake.** Every factory run starts from a **knowledge pack**: patterns first, then
the vendor's lessons, then everything about this bank, with its latest attempts and the
vendor's recurring failures, and the two closest existing crawlers as examples. Unconfirmed
and disputed lessons are labeled; a pattern is served only once confirmed. The pack has a size
budget, filled in rank order. If memory is unreachable, the run stops rather than reason from
nothing. Mid-run, the agents ask questions with one tool, `memory_query`.

**Write-back after a run.** At every ending, the Supervisor writes what the run taught, each
lesson citing its frames, and names the served lessons it relied on and the ones it
contradicted. They reach memory as **proposals**. Every task run in production also records
one episode, and that write can never affect the task.

**Consolidation by promotion.** Promotion is the proof. Memory checks the claim against its own
records, then confirms every lesson the probation runs proposed or relied on, and writes the
bank's **verified facts** in a fixed vocabulary: "A fresh sign-in at Example Credit Union asks
for a staff code sent by email." The screens the factory mapped while exploring become facts
here too (`Example Credit Union has_screen transfer.review`), and not before.

**Forgetting by evidence.** Fixed rules revise beliefs, with no model involved. A first contradiction
disputes a lesson; contradictions from two runs retire it. A demotion disputes what its
promotion confirmed. A lesson wrong at one bank is retired there only. A lesson proven at two
banks of the same product widens to the vendor, and across three vendors becomes a pattern
candidate. A retired lesson comes back if a later promoted run relied on it. A lesson never
used is ranked lower, never dropped.

**The human curator.** A person curates, rarely. A curated change or a pattern candidate waits,
unserved, until a person approves it in the Console.

### K.5 Guardrails

Every writer holds a token for one role, and memory refuses any write outside it. The Scout
and Supervisor may record episodes and hypotheses, and the Supervisor may propose lessons and
challenge a fact or lesson. Box A, the only box that faces callers, can add episodes and
forward lessons, nothing more. Confirmations and verified facts are written by the Memory
service itself, when a promotion checks out. **No agent can promote its own belief into
truth.** Writes are also signed with a key that only deterministic code holds, so a model
cannot forge one.

- **Provenance on every entry:** which run, which model, which prompt versions, and a hash of
  the evidence.
- **Nothing is overwritten.** Every edit adds a version, and every write appends to a
  hash-chained change log, so tampering is detectable.
- **A privacy screen on every write.** No passwords, codes, cookies or tokens, no
  account-like numbers, no screenshots or page data, nothing about a person, and no lesson that
  advises a forbidden action.

### K.6 The architecture

![Memory: who reads and writes, through one door](diagrams/memory.svg)

| Component | What it does |
|---|---|
| **Memory service** | the only process that opens the memory database; it checks roles, screens writes, keeps versions and the change log |
| **Facts table** | stores and searches verified facts as bi-temporal rows |
| **Embedder** | turns text into vectors for similarity search, locally |
| `memory_query` | answers an agent's mid-run question with matching lessons, scenarios and facts |
| **The recorder** | writes one episode for every run the system settles |
| **The lesson sweep** | forwards finished runs' lessons, and what they relied on and contradicted |
| **The rules** | confirm, dispute, retire, narrow and widen lessons, and write facts on promotion |

### K.7 Endpoints

| Endpoint | What it does |
|---|---|
| `episodes/runs`, `episodes/attempts` | record a run and its attempts, with any promotion or demotion mark |
| `episodes/search`, `/recent`, `/recurring` | find similar failures, a bank's latest attempts, or a vendor's recurring failures |
| `facts`, `facts/search` | write a fact at the role's truth level; retrieve served facts, never a hypothesis |
| `facts/invalidate` | close a fact, backed by a failed run, or propose that a fact or lesson does not hold |
| `lessons/proposals` | propose a lesson; a near-duplicate merges, and advice to do a forbidden action is refused |
| `lessons/relied-on` | record which served lessons a run actually used |
| `lessons/confirm`, `lessons/retire` | confirm or retire a lesson, as a new version |
| `curated`, `curated/approve` | propose a curated version; approve it, making it current |
| `scenarios`, `approaches`, `rules`, `checks`, `lessons` | list or read the catalog, at any version |
| `knowledge/pack` | return everything a run starts from |
| `history`, `history/verify` | show what changed, for an entry, since a time or in a run; verify the change log |
| `healthz` | report liveness, and whether the database answers |

### K.8 Querying memory: an agent and a person

**An agent** asks with `memory_query`: at most eight items, at most three facts per answer.
Most of what a run needs arrives in the knowledge pack, so mid-run questions are the exception.

**A person** reads memory in the Console. It shows lessons with their state, scope, evidence and
where they have been seen; facts with their valid and closed times; episodes; the change log,
with a button that verifies the chain; and a **knowledge-pack preview** for any bank, showing
exactly what the factory's agents would be given. The Console reads and writes through the
Memory service's API, so memory keeps one door.

**A person can also add to memory, as the curator:**

- **Add or edit a lesson.** Each save is a new version, pending until approved (in Part 1 the
  same person may approve). It carries who wrote it and why, like any other entry.
- **Retire a lesson** with a reason. Nothing is deleted; the history keeps it.
- **Close a fact** that is no longer true, with a reason. Nobody types in a fact by hand. A
  fact needs a promoted run as proof, so new facts come only from the factory.
- **Approve or refuse** pattern candidates and pending curated changes.

### K.9 Autocrawl

The factory's scout phase ([§M.3](#m3-phases)) is how the system learns a bank it has never seen. It signs
in with a staff test login, explores read-only, and records every screen it reaches: the
masked frame, the screen model, the labels, the controls and the transition that led there.
Those are episodes and hypotheses while the run is going. When the crawler built from them is
promoted, they become verified facts about that bank. Over runs and banks, the facts and
lessons build up a map of the vendor's product. That map is what lets the next bank arrive as a
profile rather than a rebuild.

### K.10 The starting knowledge

Memory does not start empty. `seeds/memory/` holds a cleaned starting set, written for this
project: standing **rules**, Supervisor **checks**, **lessons** about how legacy sites behave
and how agents should work, and the **scenario** and **approach** catalogs. Every entry is
stated generally: no institutions, people, dates, incidents, file paths or evasion techniques.
Scenarios that a bank does not yet reproduce carry a proposed hazard, which is where banks 3
and 4 get their extra trouble.

The seed enters through Memory's own door, as the curator role, with one approval record for
the whole set (`just memory-seed`), so every row passes the privacy screen and appears in the
change log. Seeded lessons start as curated patterns; from then on the rules treat them like
any other lesson. Facts are not seeded: they are written the first time the factory scouts and
promotes a crawler for each bank.

### K.11 Error handling

| Response | Means |
|---|---|
| `401` | no token, or an unknown one |
| `403 role_forbidden` | a known role, not allowed this write; or an unsigned write |
| `409` | a verified fact with no successful run, an attempt with no run, or an approval that would move a version backward |
| `422` | the privacy screen refused a value |
| `503` | the memory database is down; runs keep going and their episodes wait in an outbox, but the factory will not start without its knowledge pack |

A change log that fails verification puts Memory into read-only mode and notifies, until a
person looks.

### K.12 Stack and footprint

Fastify, its own Prisma schema in its own Postgres database, with pgvector for embeddings
(declared in Prisma as an unsupported column type and queried with raw SQL). Embeddings are
computed in-process with a small open model (`bge-small-en-v1.5`, 384 dimensions, through
`@huggingface/transformers` on CPU). No graph database, and no model inside the service.
Each write and its change-log row are one serializable transaction. About 300 to 400 MB of
RAM.

The machinery is domain-neutral; only the vocabulary of banks, screens and sign-in methods
belongs to this first domain.

**Reference:** "Zep: A Temporal Knowledge Graph Architecture for Agent Memory."
arXiv:2501.13956.

---

## Appendix L. Driver lifecycle and the repair loop

A bank and task are available exactly when a promoted crawler exists. Promotion adds the bank to
`GET /banks`, and demotion falls back to the previous version. A freeze, or no crawler at all,
means `404 task_not_available` before any browser opens.

- **Promotion** needs two clean probation runs within 30 days, one with a fresh sign-in and one
  on a trusted workstation, verified against the bank's own data. At most four probation
  attempts. Probation finds the candidate by version id, never by name.
- **Demotion** is automatic: with fewer than two clean runs since promotion, the first driver
  fault demotes; otherwise it takes two faults in a row. The previous version
  serves again.
- **Faults:** an `app_error` or a 503 is the bank's; a driver fault is an unknown screen, a
  targeting failure, or a wrong result.
- **Repair cases** open after repeated driver faults, one per tenant × task: the factory's repair
  queue.
- **Freezes** follow any guard trip and block every run and factory sign-in for that tenant until
  a person clears them with a reason.
- **Sign-in ledger:** every sign-in attempt is recorded and capped per member per day.

Every transition writes a registry event and an audit entry, and appears in the Console.

---

## Appendix M. The software factory

### M.1 What it does

Given a tenant and a task, the factory produces a driver version: a **profile** for a known
vendor, **driver code** for a new one, stored as a versioned bundle with a sha256 in the
registry. **Build** mode starts from the vendor's driver and the knowledge pack; **repair** mode
from a repair case and the failing runs' trails.

### M.2 Roles

- **Scout:** drives one live browser through tools, one simple step at a time, as the Supervisor
  directs; every page it reaches is a frame.
- **Supervisor:** after every Scout step, looks at the frame and decides the next step toward the
  goal, or `wait`, or `stop`, citing the frame. An unreadable answer counts as `wait`. It drafts
  the profile as a recommendation (each claim citing frames, marked seen or guess) and writes the
  lessons at the end.

### M.3 Phases

`INTAKE` → `SCOUT` (autocrawl, read-only) → `BUILD` ⇄ `OFFLINE EVAL` (E0 to E3) →
`LIVE VERIFY` (E4) → `LESSONS` → `REVIEW GATE` → `PROBATION` (E5) → `DONE`

- **Stall rule:** the same failure signature twice, or no progress for three turns, ends the build
  loop with a hand-back.
- **Doneness:** all checks green, no unfinished markers in the bundle.
- **Review gate:** a person approves or rejects with the diff, eval results and trail. One
  reminder at 24 hours; expires at 7 days.
- **Probation:** [Appendix L](#appendix-l-driver-lifecycle-and-the-repair-loop); a regression reopens the build once.
- **Hand-back:** what it knows, what it does not, what would settle it, in a fixed format.

A candidate declares every host it needs; live verification lists every host refused.

### M.4 Tools

A closed set:

| Tool | Roles | Notes |
|---|---|---|
| `browser_open` | Scout | allowed hosts only; never a host the model proposes |
| `browser_look` | both | masked screenshot plus screen model |
| `browser_click`, `browser_type`, `browser_choose`, `browser_press`, `browser_scroll`, `browser_wait` | Scout | by control reference; keys from a fixed set; typing refuses secrets; never the bank's submit for a transfer |
| `browser_type_credential` | Scout | field name only (`user_id` or `password`); the server types the value |
| `browser_enter_code` | Scout | only after the bank proved it sent a code; the person's code never reaches the model |
| `recommend` | Supervisor | the profile; each claim cites frames of this run and is marked seen or guess; refused without a frame |
| `run_evals` | Supervisor | the profile against each forced hazard; results compacted for the model |
| `memory_query`, `catalog_lookup` | both | read-only |
| `record_lesson` | Supervisor | one to three sentences, a confidence, citing frames this run showed |
| `evidence_read`, `frames` | both | masked frames and step records of this run |

No tool moves money, runs page script, makes its own non-GET request, or reaches a host outside
the allowlist. Factory work on transfers stops at the review page.

### M.5 Caps (in code)

| Cap | Default |
|---|---|
| Spend per run | $25 |
| Spend per rolling week | $150 |
| Scout turns | 6 |
| Live sign-ins per run | 6 |
| Active hours per run | 4 |
| Failed-check turns | 3 |
| Live verifications | 2 |
| Reserve kept for writing lessons | $1 |

### M.6 The agent harness and the model gateway

Each role is its own **pi** session ([pi.dev](https://pi.dev)). Each factory step restores the
role's session file, runs one prompt-to-idle cycle, and saves it, so a crash costs at most one
turn. Our code, not pi, owns:

- **The model gateway:** a metering endpoint in box D for each configured provider, pi's only route to
  the model. It checks the budget before every request, records tokens and cost, and refuses at
  a cap or an unknown price.
- **The tool allowlist:** pi's tool-call hook asks our registry before every tool; a tool outside
  the role's list is vetoed, recorded, and the agent told why.
- **The prompts:** reviewed files rendered by our loader ([Appendix O](#appendix-o-the-prompt-library)).

**Models are configuration.** Each role's provider, model and effort are set in config, so a
deployment can run on another provider (OpenAI, for one) through pi without a code change. The
defaults: Supervisor `claude-opus-5-5` at high effort (it reasons), Scout `claude-opus-5-5` at low
effort (it navigates), small judgments `claude-haiku-4-5-20251001`. The gateway meters whichever
provider is configured and refuses a model with no known price. **Mock mode** replays recorded
model responses through the same gateway.

### M.7 Generated code

Candidate code runs only in the sandbox until approved at the review gate. Before it runs, its
sha256 must match the bundle, it is linted again (E0), and it loads in its own module scope,
importing only the driver SDK. Every factory run records the sha of the code it ran.

---

## Appendix N. Evaluations

### N.1 The ladder

| Rung | What it proves | How |
|---|---|---|
| **E0** lint | The code follows the rules | TypeScript compiler API, never executes the code. Rules: no CSS or id locators, no `evaluate` or injected script, no non-GET requests, no model calls in drivers, guard errors propagate, no `.first` on ambiguous matches, every loop bounded, imports from the driver SDK only. Each rule names the scenario it prevents. |
| **E1** contract | The driver honors the task contract | Against recorded screen models: one result per request, typed outcomes, customer-safe messages, no hang. |
| **E2** hazard matrix | The driver survives every hazard | Real Chromium in the sandbox against the throwaway bank. A control run first; if it fails, stop. Then each forced hazard alone, each with its expected typed result. The hazard list is read from the bank, never kept by hand. |
| **E3** replay | Behavior matches recorded trails | Recorded screen-model sequences replayed offline. |
| **E4** live verify | It works on the real tenant | Ambient hazards on; one fresh sign-in, one trusted workstation. |
| **E5** probation | It works in production | [Appendix L](#appendix-l-driver-lifecycle-and-the-repair-loop). |

A rung passes only if every check passed **and it actually ran**; "could not run" is its own exit
code. The eval CLI prints one JSON object, and an exit code that disagrees with it is not a pass.

### N.2 Prompt evals

Each prompt has a case file of inputs and expected properties. A runner scores each prompt
version against the configured models, on demand and before any version bump, under its own
spend cap.

---

## Appendix O. The prompt library

### O.1 Contents

| Folder | Prompts |
|---|---|
| `shared/` | `invariants` (mission, roles, standing rules from [Appendix A](#appendix-a-principles)), `contract` (the driver SDK and task contracts), `house_style` (code conventions, all backed by lint rules) |
| `operator/` | `build_driver` (first turn), `fix_driver` (later turns and repair mode) |
| `supervisor/` | `check_step` (continue, wait or stop after each browser step), `write_lessons` |
| `memory/` | `ontology` (entity and edge types, with CoreLink examples) |
| `messages/` | `hand_back`, `review_summary`, `cost_report` |
| `judges/` | `review_summary_honesty` |
| `schemas/` | answer formats, each a `.md` explanation paired with a `.json` schema: `operator_report`, `step_verdict`, `lessons_report`, `judge_verdict` |
| `tools/` | one description per tool in [§M.4](#m4-tools) |
| `catalog/scenarios/` | failure modes, families: login, code, navigation, download, enumeration, session, pacing, transfer, legacy surfaces, registry |
| `catalog/approaches/` | techniques, families: login, code, navigation, download, enumeration, pacing, cross-cutting |
| `_evals/<id>/cases.yaml` | cases for every prompt |

A scenario says how to recognize it, what it is mistaken for, how to probe and recover, and the
approaches in order, with a short example. An approach says when it applies, its steps and
limits.

### O.2 Composition and checks

Frontmatter: `id`, `version`, `role`, `purpose`, `inputs`, `output_schema`, `includes`, `evals`,
and a one-line changelog per version. Includes render depth-first, once each. Cycles are errors, and so
are missing or extra `{{name}}` variables. The loader returns a branded type, so the gateway
never takes a raw string. `shared/invariants` comes first in every prompt.

`npm run check-prompts` fails when:

- a model call in source carries more than 200 characters of literal text
- frontmatter is missing
- declared and used inputs differ
- a prompt has no eval cases
- a schema has no `.json`
- a catalog entry has no prose, or prose has no entry
- the spelling or style check fails

### O.3 Writing standard

- General behavior, not stories: no dates, incidents, people's names, real institutions, ticket
  or PR numbers. Examples use the two Generic Bank tenants.
- One term per idea, from a glossary ("fully rendered", "screen", "control", "grant",
  "hand-back").
- Prompts never contradict each other or the code: never request a second code, never submit a
  password twice, and examples never use page script, forced clicks, non-GET requests, or the
  first of several matches.
- Nothing about evading bot detection, CAPTCHAs, spoofing fingerprints or proxy networks.
- `cspell` and a style check run in CI. Lines wrap at 100.

### O.4 Prompts in the Console

The files in `packages/prompts/` are the baseline. In the Console a person may edit or add a
prompt. Saving creates a **draft** (with author and reason) that no run uses. "Run evals" runs
its cases under their own cap, and "Activate" is offered only when they pass. Any version, or the git
file, can be restored in one click. `just prompts-export` writes active versions back to the
files for a pull request.

---

## Appendix P. Tests

| Suite | Where | What |
|---|---|---|
| Unit | `packages/*/test`, `apps/*/test` | pure logic: recognition scoring, label geometry, masking, guards, caps, memory rules, result mapping. `vitest`. |
| Bank | `apps/bank/test` | every page in all four banks, every hazard on and off, the ledger, statements, the markup dialects. |
| Browser | `tests/browser` | the Runner against the real bank in Chromium. Skipped only if the browser cannot launch; CI fails on any skip. |
| Outcomes | `tests/outcomes` | one business outcome, one recoverable condition and one hard failure from the outcome table, each its exact typed result. |
| Escalation | `tests/escalation` | an unknown screen escalates; a person resumes it through the Console API, and the run finishes. |
| Guard | `tests/browser/guard.test.ts` | the allowlist refuses what it does not list, and the submit without a grant; the bank's state-change counter does not move. |
| PII | `tests/pii` | scans everything runs wrote (database rows, objects and log files) for seeded secrets and personal values. |
| Factory | `apps/factory/test` | workflow phases with a fake browser and mock model, caps, the meter, the tool veto, doneness, probation. |
| Memory | `apps/memory/test` | screens, merge, confirm, dispute, retire, widen, return, demote, pack budget, chain verification. |
| Prompts | `packages/prompts/test` | the checker, the loader, schemas. |

**CI** (GitHub Actions) has four jobs. The first runs typecheck, lint and the import
boundaries. The second runs the tests, split across three machines by file: a pull request runs
the tests its change touches, and a merge to master runs them all. The third is a fresh clone, where `just setup` and `just up` run on a machine with
nothing cached and every service must answer. The fourth runs `gitleaks` over the history.
`just check` runs `gitleaks` over the history and uncommitted changes.

**Rules:** fakes never return the answer under test. Every guard has a test that it refuses.
Tests use real-shaped data judged by the bank's ground truth. CI builds the real images and
compose files, and fails on any skipped or missing suite. Deploy workflows have path filters.
Secret scanning catches secrets written as sentences, and CI checks that every imported file is
tracked by git.

---

## Appendix Q. Repository layout, documentation and branches

### Q.1 Layout

```
apps/
  bank/          the CoreLink staff console (all four banks), markup dialects, hazards, inbox, seed
  api/           Task API and workflows (the back end)
  console/       the AdminJS Console: approvals, runs, drivers, factory, memory, hazard lab
  runner/        task runner: browser lifecycle, step clock, evidence capture (the crawlers)
  memory/        Memory service
  factory/       factory workflows, model gateway, tools
  agent/         the demo member-assistant agent on pi, calling the REST API as tools
packages/
  contracts/     zod schemas: tasks, results, outcome codes, events
  screen/        capture, screen model, image fingerprints, fully-rendered wait, recognition, targeting
  drivers/       driver SDK; corelink/ driver; bank profiles
  guardrails/    task allowlists, session guard, member scope, grants, secret typing, caps, tools
  evidence/      trail frames, masking pipeline, journal, manifests
  lint/          E0 rules
  evals/         ladder E0 to E6, CLI
  prompts/       library, loader, checker, eval runner
  db/            Prisma schema, migrations and seed for the control database
seeds/
  memory/        the sanitized starting knowledge: rules, checks, lessons, scenarios, approaches
tests/           browser, outcomes, escalation, runs, pii
infra/           compose files, SOPS files, export and import scripts
docs/            the documents the README links to (§Q.2)
Justfile         the only entry point: every action is a just recipe (§S.1)
```

npm workspaces, TypeScript project references, ESM, Node 26.

**Import boundaries**, enforced by `dependency-cruiser` in CI:

- Nothing imports `apps/bank`. The bank is reached only over HTTP.
- `guardrails`, `evidence`, `evals` and `lint` never import `runner`, `drivers` or `factory`.
- `drivers` may import only the driver SDK, `screen` and `contracts`.
- `factory` reaches `evals` only through its CLI.
- Generated driver code may import only the driver SDK.

### Q.2 Documentation: a short README and seventeen documents

The README says what the system is in one paragraph, shows the picture, and links to the
documents.

| Document | What it covers |
|---|---|
| `README.md` | the one-paragraph framing, the picture, the reading order, links to everything below |
| `docs/00-requirements.md` | the brief, point by point: every requirement, how we meet it, where, and the test or demo that proves it |
| `docs/01-setup.md` | prerequisites, `git clone`, `just setup`, filling in `.env` values, SOPS and age keys, first `just up` |
| `docs/02-running.md` | every just recipe, what each group starts, URLs and ports, `just demo`, `just try`, `just down` |
| `docs/03-architecture.md` | the boxes, the diagrams, the data models, where the risky parts live |
| `docs/04-tech-stack.md` | every technology choice and why |
| `docs/05-the-bank.md` | CoreLink, the four banks, their differences, the hazards, the hazard lab |
| `docs/06-task-api.md` | tasks, inputs, the result, outcome codes, `GET /banks`, OAuth2 clients and tokens, trying it in Swagger UI at `/docs` |
| `docs/07-runner-and-perception.md` | the screen model, the fully-rendered wait, recognition, targeting, drivers and profiles (the crawlers) |
| `docs/08-transfers-and-approvals.md` | the approval grant, the one click, the swallowed-submit protocol |
| `docs/09-console.md` | every Console page, roles, state markers, the inbox |
| `docs/10-observability.md` | records and logs; what the crawler did and what the agent did |
| `docs/11-guardrails-and-safety.md` | every guard layer, masking, the trap matrix, the PII scan |
| `docs/12-memory.md` | what memory keeps, the learning rules, the knowledge pack, autocrawl, export and import |
| `docs/13-factory.md` | roles, phases, tools, caps, mock mode, probation, the repair loop |
| `docs/14-evals-and-tests.md` | the eval ladder, every test suite, CI |
| `docs/15-prompts.md` | the prompt library, composition, checks and the writing standard |
| `docs/16-from-80-to-100.md` | what AI produced, what changed and why, what was cut, what is still needed; with more time ([Part 2](#part-2-with-more-time)) |

The Markdown is the source; `just docs` renders it as a website, published to **GitHub Pages** at
`https://dphipps4.github.io/generic_bank/` on every merge to `master`. Rendered HTML is never
committed. The repository is the product: catalog, memory seed and prompts live in it, and
nothing is hosted elsewhere.

### Q.3 Branches

- **`master`** is the default branch and always releasable (`just up` and `just demo` work on
  every commit).
- Every change goes through a short-lived branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`) and a
  pull request, where CI runs.
- A **GitHub ruleset on `master`:** pull request and CI checks required, linear history (squash
  merges), no force pushes, no deletion, zero required approvals.
- **Tags** mark milestones (`m3-check-balance`, `m7-factory`, `submission`).
- Conventional Commits; each pull request says what it proves and how.

---

## Appendix R. Secrets and configuration

- **`.env`** carries configuration into containers. `.env.example` is committed and documents
  every variable; `just setup` copies it to `.env`, which is never committed.
- **SOPS** (with `age`) encrypts the committed secret files (`infra/secrets/local.sops.env` and
  friends). `just setup` generates a local age key and random dev secrets; no key is committed.
- **`ANTHROPIC_API_KEY=`** ships blank, which means mock mode. Only the factory agent gets the
  key, never the Runner, the sandbox, the Console or the bank.
- **Settings fail closed:** every required variable present, secrets at least 32 characters, no
  two tokens equal.
- **SOPS** holds every secret, the staff service account included; each service receives only
  its own (Vault comes in Part 2).
- No cloud account, third-party sign-in, rotating secrets or intrusion detection locally.

---

## Appendix S. Running it

### S.1 Everything through just

| Recipe | What it does |
|---|---|
| `just requirements` | checks the Mac with explicit versions (macOS 14, git, just, Docker Engine 27 and Compose 2.29 with 5 GB of memory, disk, ports) and fails, saying what to install, until every one is met; `just requirements-dev` adds Node 26 |
| `just plan` | renders every document in `docs/plan` as HTML pages, in a container, and opens them |
| `just setup` | once after `git clone`: `just requirements`, then generates the age key and dev secrets and builds the images; SOPS, age and jq run from a pinned tools image, so the Mac needs only Docker |
| `just dev-setup` | once, to develop: Node dependencies, the Prisma client, Chromium for the browser tests |
| `just up` | everything in the base stack: data, back end, console, crawlers, banks 1 and 2 |
| `just down` | stops everything; volumes are kept |
| `just data` | box B: Postgres, MinIO, Memory |
| `just backend` | box A's back end: the Task API and workflows (needs `data`) |
| `just console` | the AdminJS Console (needs `data`) |
| `just crawlers` | the Runner, which drives the banks for tasks (needs `backend`) |
| `just bank` | banks 1 and 2, the message inbox and `bank-db` |
| `just bank-more` | banks 3 and 4, for crawling later (not part of `just up`, to save memory) |
| `just factory` | box D: the factory agent, Scout browser and sandbox; live with a key, mock without |
| `just down <group>`, `just logs <group>`, `just rebuild <group>` | the same for one or more groups |
| `just demo` | check balance and transfer on banks 1 and 2, printing each typed result |
| `just try <hazard> [task]` | any task under any forced hazard |
| `just test`, `just test-browser`, `just test-pii`, `just evals` | the suites in [Appendix P](#appendix-p-tests) and the eval ladder |
| `just check-prompts` | the prompt checker |
| `just api-token` | creates a local API client (once) and prints a fresh access token for Swagger UI or `curl` |
| `just api-docs` | writes `openapi.json` and the static API reference page from the contracts |
| `just prompts-export` | writes the prompt versions activated in the Console back to `packages/prompts/` for a pull request |
| `just docs` | renders `README.md` and `docs/` as the white-template website into `site/`; the same build publishes to GitHub Pages |
| `just logs` | read the JSON logs from `.data/` |
| `just memory-seed` | imports `seeds/memory/` into an empty Memory (part of the first `just up`) |
| `just reset` | deletes volumes and starts again from the seed (asks first) |

The Console is at `http://localhost:8080`, the banks at their URLs ([§C.1](#c1-one-product-four-banks)), the inbox at
`:8089`. `just demo` pauses at the transfer approval and prints the Console link;
`AUTO_APPROVE=1 just demo` approves through the Console API.

**Mock mode** replays only the model responses of a recorded factory run; the browser, bank,
evals and Console are live, with hazards off and the recording's seed.

### S.2 The hazard lab

With `HAZARDS_FORCEABLE=true` (the local default), the Console's **Hazard lab** page lets an admin
pick a tenant, member, task and hazards and start the run, carrying the signed hazard header.
`just try` does the same from the command line. Every hazard in [§C.4](#c4-runtime-hazards) is one click away, with its
expected typed result.

### S.3 Fitting in 8 GB

Target: an 8 GB laptop, Docker Desktop with 5 GB. Every container has a memory limit. By default
there is one browser at a time (`RUNNER_CONCURRENCY=1`), started on demand. It's full Chromium in
modern headless mode, with no virtual display.

| Service | Box | Limit |
|---|---|---|
| `postgres` (pgvector; databases `control`, `memory`, and the workflow engine's tables) | B | 384 MB |
| `minio` | B | 128 MB |
| `memory` (with the in-process embedder) | B | 384 MB |
| `api` (Task API and workflows) | A | 192 MB |
| `console` (AdminJS, bundled at build time) | A | 256 MB |
| `runner` (plus one headless Chromium) | A | 768 MB |
| `bank-generic`, `bank-example` | world | 128 MB each |
| `bank-inbox` | world | 96 MB |
| `bank-db` (small Postgres, `shared_buffers` 32 MB) | world | 128 MB |
| **Base stack (`just up`)** | | **about 2.7 GB** |
| `bank-sample`, `bank-placeholder` (`just bank-more`, later) | world | 128 MB each |
| `factory` (agent and model gateway) | D | 256 MB |
| `operator-browser` | D | 768 MB |
| `sandbox` (eval runner with its own Chromium), `bank-sandbox`, `sandbox-db` | D | 768 MB |
| **With the factory running** | | **about 4.5 GB** |

`just requirements` checks Docker's memory allowance first.

Networks: `edge` (published ports), `app` (A to B), `data` (B internal), `world` (banks;
reachable from the Runner and the Scout browser), `factory` (D to A and B), `sandbox`
(`internal: true`, no route out).

Images are pinned by digest, and a preflight in `just up` and `just factory` refuses to start if
the boxes' versions disagree or the database isn't at the expected migration. Repeated log lines are
rate-limited, and every container has disk and memory limits.

---

## Appendix T. How this answers the review

### T.1 System design

- **Boundaries:** three boxes ([§B.1](#b1-the-three-boxes)), import rules checked in CI ([Appendix Q](#appendix-q-repository-layout-documentation-and-branches)), a bank that
  shares nothing with the automation.
- **The task contract:** a small typed union ([§D.2](#d2-the-result)); the caller never sees the UI.
- **Driving the UI:** screen model, recognition, targeting by meaning, verification ([Appendix E](#appendix-e-the-runner-driving-a-messy-ui)).
- **Simplicity:** no model at runtime, one Postgres, an in-process workflow library, AdminJS.
- **Data models:** [§B.2](#b2-data-models-control-database-one-prisma-schema).

### T.2 Robustness and error handling

- Every bank error is a named screen ([§E.3](#e3-screen-recognition)).
- Business outcomes, recoverable conditions and hard failures are kept apart ([§D.2](#d2-the-result), [§D.3](#d3-recoverable-conditions)).
- Waiting is "fully rendered", never network idle ([§E.2](#e2-fully-rendered-not-network-idle)), with step limits and a watchdog ([§E.7](#e7-time-limits-and-the-stall-watchdog)).
- Targeting re-checks and re-targets; every action verifies the next screen ([§E.4](#e4-targeting)).
- Every failure is tabled ([§D.4](#d4-how-failures-are-handled)); the outcome suite and the hazard lab prove them ([Appendix P](#appendix-p-tests), [§S.2](#s2-the-hazard-lab)).
- Records and logs share one run id ([§I.4](#i4-two-signals-one-id)).

### T.3 Human-in-the-loop escalation

- **Detected:** unknown or doubly matched screen, stall, exhausted recoveries, ambiguous submit,
  guard trip ([§D.2](#d2-the-result), [§E.7](#e7-time-limits-and-the-stall-watchdog), [§F.2](#f2-the-swallowed-submit-protocol)).
- **Escalated** to the Console inbox with the masked trail and a deadline ([§F.3](#f3-codes-and-other-human-steps)).
- **Proved** by the escalation suite, through the API ([Appendix P](#appendix-p-tests)).

### T.4 From 80% to 100%

What a first draft gets wrong, and what this plan does instead, each covered by a test:

- clicks by CSS selector; here E0 lint forbids it
- waits for network idle; here pixels must settle
- retries a failed submit; here the history is read and the run escalates
- lets the agent move money; here a person grants one click
- logs what it sees; here everything is masked first, or withheld
- reports green from checks that never ran; here "could not run" is never a pass ([§N.1](#n1-the-ladder))
- lets the model raise its budget; here caps live in code ([§M.5](#m5-caps-in-code))

### T.5 Generalization to the real environment

A driver per vendor, a profile per tenant ([§E.5](#e5-drivers-one-vendor-many-tenants)). Memory scopes lessons to tenant, vendor and
general pattern ([§K.4](#k4-how-memory-is-used)), and the factory learns bank 2 as a profile ([Appendix M](#appendix-m-the-software-factory)). Drivers see only
the **screen model** ([§E.1](#e1-perception-what-the-operator-sees)), so another capture source (UI Automation, the macOS AX tree, a
terminal's character grid, or screenshots alone) plugs in without changing recognition,
targeting, guardrails, masking or the trail.

### T.6 Safety and data handling

- **Allowlists** per task, role, tool and host ([Appendix J](#appendix-j-guardrails), [§M.4](#m4-tools)).
- **Transfers:** a person's grant, one click, values checked, no blind retry, duplicates found by
  memo token ([Appendix F](#appendix-f-transfers-a-human-approved-activity)).
- **Redaction** before any write; unprovable frames withheld ([Appendix I](#appendix-i-evidence-redaction-and-observability)).
- **Proof:** the trap matrix and PII scan ([Appendix P](#appendix-p-tests)).

### T.7 Communication

A two-page README leading with the problem and the cut lines, `architecture.md` with diagrams,
and every README claim linked to its code and test.

---

## Appendix U. Why each rule exists

> **Building the place where something is stored, leaving for later the step where it is
> used, and reporting the stored half as done.**

That is the most common failure. So "done" here means something actually uses it in the real
flow, shown by a test, a log line on the receiving side, or behavior seen live. Rules the plan states
elsewhere are not repeated; these are the rest:

| Rule | The failure it prevents |
|---|---|
| Look at the drawn page before naming a cause | our own outage read as banks blocking us |
| Our caps return a typed, named error; the Console shows the sign-in ledger | our sign-in cap mistaken for the bank's |
| Live verification follows the same sign-in pacing | our pacing refusing a check's second leg |
| Mask every frame, not only the step that typed; mask inputs and sensitive text, not every control | a code visible in a later frame; a button half hidden |
| A secret that reaches a transcript, log or remote is spent, and rotated | a pasted credential left valid |
| Ignore rules are anchored | real code silently kept out of git |
| Never commit a broad "add everything" in an unignored folder | personal files in a public history |
| Recordings and customer data are never files in the repo | private data in every image |
| Test the rendered prompt with every declared input | a judge deciding on half its inputs |
| One hypothesis at a time; every claim cites its proof | a cause announced from one green run |
| Stuck detection applies to running work, never queued work | a reaper killing queued jobs |
| Production last: sandbox evals and the hazard lab first | the live system used as the test bed |
| Fix a factory-written bug in the factory's rules first | the same bug in the next crawler |
| Keep working crawlers as examples | relearning what already worked |
| A correction given twice becomes a rule in code | the same correction again and again |
| Recordings are evidence, never a replay script | a replay broken by the first page change |
| Every choice put to a person says what each option is for and costs | a decision blind to what it removes |
| Report half-built work as "built, but nothing uses it yet" | storage reported live that nothing called |

---

## Appendix V. Technology stack

| Area | Choice |
|---|---|
| Language and runtime | TypeScript (strict), Node 26, ESM, npm workspaces with project references |
| Services | Fastify everywhere; zod contracts with OpenAPI and Swagger UI (`@fastify/swagger`); tool definitions from the same contracts |
| Console | AdminJS with `@adminjs/fastify` and `@adminjs/prisma`, custom React components |
| Bank | hand-written server templates and ES5, `pdf-lib`, argon2 |
| Data | PostgreSQL 16 with pgvector; Prisma (vector columns via `$queryRaw`); MinIO through the AWS S3 SDK |
| Workflows | DBOS Transact, including scheduled workflows (probation checks, stuck-run sweeps, gate reminders) |
| Browser and perception | Our own DevTools Protocol client driving full Chromium; CDP `DOMSnapshot`, accessibility tree and screenshots; `sharp` for masking, fingerprints and frame comparison |
| Models | pi per role; `@anthropic-ai/sdk` behind our metering endpoint; `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5-20251001` |
| Embeddings | `@huggingface/transformers` with `bge-small-en-v1.5` (384 dimensions, CPU, about 130 MB) |
| Prompts | Markdown with YAML frontmatter; JSON Schema answers validated with ajv |
| Secrets | SOPS with age; zod-parsed environment that fails closed |
| Observability | Postgres records; pino logs; OpenTelemetry, Tempo, Loki and Grafana in Part 2 |
| Quality | vitest, ESLint, Prettier, E0 rules on the TypeScript compiler API, dependency-cruiser, cspell, markdownlint, gitleaks, `npm audit`, GitHub Actions; SonarQube in Part 2 |
| Packaging | Docker compose profiles (`default`, `factory`), just, Node 26 slim images (Chromium only in Runner, Scout browser and sandbox) |

Not used: a graph database in Part 1, Redis or any broker, Kubernetes, a model inside production
tasks, a client framework in the bank.

---

## Appendix W. Browser identity reference

Chrome on an Apple-silicon Mac ([§E.8](#e8-browser-identity-set-at-launch)). `{v}` is the pinned Chrome major
version; the brand list comes from Chrome's own algorithm and is only compared.

### W.1 User agent

```text
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36
```

Chrome reports "Intel Mac OS X 10_15_7" on every Mac, Apple silicon included; the real platform
version and architecture appear only in client hints.

### W.2 Request headers (a top-level page load)

```text
sec-ch-ua: "Google Chrome";v="{v}", "Chromium";v="{v}", "Not)A;Brand";v="99"   (generated; order varies)
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
upgrade-insecure-requests: 1
user-agent: (W.1)
accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
sec-fetch-site: none | same-origin | cross-site
sec-fetch-mode: navigate
sec-fetch-user: ?1
sec-fetch-dest: document
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
```

Sent only when a site asks for them (high-entropy client hints):

```text
sec-ch-ua-platform-version: "15.x.0"    sec-ch-ua-arch: "arm"    sec-ch-ua-bitness: "64"
sec-ch-ua-model: ""                     sec-ch-ua-full-version-list: (generated)
```

### W.3 What the page's scripts can see

```text
navigator.platform              MacIntel
navigator.userAgentData         platform "macOS", mobile false, brands (generated)
navigator.languages             ["en-US", "en"]
navigator.hardwareConcurrency   8
navigator.deviceMemory          8
navigator.webdriver             false
screen                          1440 x 900, availHeight 780 (menu bar and Dock), colorDepth 30
window.devicePixelRatio         2
WebGL vendor / renderer         Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)
Intl timezone                   the timezone of the network exit
```

Part 1 presents every row above ([§E.8](#e8-browser-identity-set-at-launch)), matched to a
MacBook Air (M1).

### W.4 The usual mistakes, each a failing test

```text
accept-language with doubled weights     en-US,en;q=0.9;q=0.9
a hard-coded brand list                  the same order and placeholder on every launch
a software graphics renderer             SwiftShader or llvmpipe visible to scripts
a patch applied after page load          scripts read the old value first
Linux-only hardware                      2 cores, colorDepth 24, devicePixelRatio 1, no menu bar
a timezone that disagrees with the exit  UTC on a residential US address
```

### W.5 What curl sends

curl's defaults on macOS (8.7.1), Debian 12 (7.88.1) and Ubuntu 24.04 (8.5.0) differ only in the
version:

```text
GET /path HTTP/1.1
Host: <host>
User-Agent: curl/<version>
Accept: */*
```

No `Accept-Language`, no `Sec-Fetch-*`, no client hints: banks 2, 3 and 4 refuse it on sight.

---

## Appendix X. Build order

Each milestone ends with its tests green, a short note in `docs/`, and the requirements report
linking each point of the brief it touches to the code and test that prove it.

| # | Milestone | Done when |
|---|---|---|
| M0 | Skeleton: workspaces, compose with memory limits, auto-bootstrap of secrets, Prisma schema and first migration, AdminJS shell, CI, import boundaries | `just up` starts every service on an 8 GB laptop; CI green |
| M1 | Bank 1: ledger, seed, staff sign-in, codes, inbox, member lookup, member summary, activity, statements, transfer, supervisor approval, framesets, nested tables, markup dialects, forced hazards | bank tests green |
| M2 | Banks 2, 3 and 4, and ambient hazards: themes, labels, layout variants, URL bases, image text, account formats, bank 3's extra frame, bank 4's split transfer and popup results | all four banks seeded and browsable |
| M3 | Screen package and the first driver: capture, fully-rendered wait, recognition, targeting, image fingerprints, the CoreLink driver with bank 1's profile written by hand, Task API with OAuth2 (clients, tokens, refresh) and its HTTP status codes, trail, masking, AdminJS run pages and the API clients page | `checkBalance` succeeds on bank 1 under ambient hazards; outcome tests green |
| M4 | The browser's fingerprint (Chrome on a Mac, set at launch; banks 2 to 4 refuse anything not a browser), then human steps: inbox, codes, transfer preparation, approval grant, submit, swallowed-submit protocol, the tool definitions, `downloadStatements`, hazard lab | escalation and transfer-safety suites green |
| M5 | Guardrails complete, trap matrix, PII scan, customer-safe messages | guards and PII suites green |
| M6 | Memory service | memory suite green |
| M7 | **Factory:** workflow, model gateway, tools, caps, scout (autocrawl), evals E0 to E4, review gate, probation, driver states in the Console, mock mode | **the factory onboards bank 2 as a profile, end to end, and it is promoted after probation** |
| M8 | **Repair loop:** turn on bank 1's redesign (`BANK_REDESIGN`); runs fail; the driver is demoted; a repair case opens; a factory repair run fixes it | the repair is visible end to end in the Console |
| M9 | Prompt library, `check-prompts`, prompt eval runner; Console complete ([Appendix G](#appendix-g-the-console)) | `check-prompts` green; every Console page exists |
| M10 | README, diagram, the requirements report (every point of the brief, how we meet it, and links to the code and tests that prove it), the 80%-to-100% notes, a recorded factory run for mock mode | a reviewer can clone, `just up`, `just demo`, `just factory` in minutes |
| **Submission** | | |
