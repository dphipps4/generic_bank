# Generic Bank: the brief, point by point

Every requirement in the take-home brief, in order. For each one: how the system meets it, where
the plan covers it, and a proof a reviewer can run or open, listed at the end.

## 1. The environment the brief describes

| The brief says | How we meet it | See |
|---|---|---|
| **Stable UIs, real runtime errors:** validation, not found, permission denied, surprise dialogs, session expiry, slowness, app errors | Each build is stable; at runtime, all of these show up as named hazards, ambient or forced: latency, script errors, 503s, dialogs, promos, expiry, record-in-use, swallowed submits, injected text | [§A.3](GENERIC_BANK_PLAN.md#a3-hazards), [§4](GENERIC_BANK_PLAN.md#4-the-four-banks) · [hazards](#proof-hazards) |
| **Heterogeneous, legacy surfaces:** server-rendered, framesets, nested tables, no test ids, non-semantic markup; maybe desktop | Framesets, tables nested four to seven deep, no ids, markup that shifts page to page, text as images, script-drawn content, cross-origin frames. Drivers read a screen model, so desktop and terminal surfaces can use the same seam | [§4](GENERIC_BANK_PLAN.md#4-the-four-banks), [§5](GENERIC_BANK_PLAN.md#5-the-crawler) · [legacy UI](#proof-legacy-ui) |
| **Multi-tenant at scale:** one vendor product, configured per tenant; generalize or degrade gracefully | One API for all banks: `bank` is an input, `GET /banks` lists what each supports, and a newly promoted crawler appears there without a new endpoint. One product (CoreLink) at four banks, each with its own labels, layouts, URLs, account formats and thresholds: one driver, a profile per bank, and the factory onboards new ones. Unknown screens escalate; nothing guesses | [§4](GENERIC_BANK_PLAN.md#4-the-four-banks), [§5](GENERIC_BANK_PLAN.md#5-the-crawler), [§7](GENERIC_BANK_PLAN.md#7-the-factory) · [bank 2](#proof-bank-2) |

## 2. The task: what to build

| The brief says | How we meet it | See |
|---|---|---|
| **An API our AI agent can call:** typed inputs, a structured result, no knowledge of the UI | One REST API: three tasks, one typed result, a catalog, a bank list, and tool definitions (`GET /tools`) that agents call directly. OpenAPI at `/openapi.json`, Swagger UI at `/docs`, OAuth2 tokens with refresh, status codes that say what to do next | [§3](GENERIC_BANK_PLAN.md#3-the-api), [§A.7](GENERIC_BANK_PLAN.md#a7-oauth2), [§A.1](GENERIC_BANK_PLAN.md#a1-results-and-http) · [API](#proof-api) |
| **Operate the application** as a human would; perceiving and driving the UI is the core design choice | A real browser runs the page's JavaScript. The crawler reads what's drawn (layout, accessibility tree, screenshot), knows screens by their words, finds controls by label and position, uses the real mouse and keyboard, and checks the next screen | [§5](GENERIC_BANK_PLAN.md#5-the-crawler) · [browser](#proof-browser) |
| **Escalate to a human when stuck,** with enough context to take over | Unknown screens, stalls, ambiguous submits and guard trips escalate with the masked trail and last screen. The API returns `409 Conflict`. A person resumes, finishes by hand or cancels, and the agent's retry gets the result | [§2](GENERIC_BANK_PLAN.md#2-the-pieces), [§3](GENERIC_BANK_PLAN.md#3-the-api), [§6](GENERIC_BANK_PLAN.md#6-transfers) · [escalation](#proof-escalation) |
| **Stay within guardrails:** an allowlist of permitted actions; never leak or persist sensitive data | A written allowlist per job, enforced by the guard and shown in the Console. Money moves only on a person's single-use grant. Everything is masked before it's written. Secrets come typed from SOPS and are never returned | [§9](GENERIC_BANK_PLAN.md#9-safety), [§A.5](GENERIC_BANK_PLAN.md#a5-the-allowlist) · [guardrails](#proof-guardrails) |
| **The target application:** a deliberately unfriendly legacy member-servicing console with lookup, balance and transfers; at least record not found, insufficient funds, session timeout and a surprise confirmation dialog | CoreLink Branch Console: lookup, member summary, activity, statements, and transfers with supervisor approval. All four errors, and many more | [§4](GENERIC_BANK_PLAN.md#4-the-four-banks), [§A.3](GENERIC_BANK_PLAN.md#a3-hazards) · [banks](#proof-banks) |

## 3. Minimum scope

| The brief says | How we meet it | See |
|---|---|---|
| **At least two tasks through the API:** check balance and transfer funds | Three: Check Balance, Transfer Funds, Download Statements | [§3](GENERIC_BANK_PLAN.md#3-the-api), [§A.1](GENERIC_BANK_PLAN.md#a1-results-and-http) · [tasks](#proof-tasks) |
| **Both tasks end to end** by driving the UI | Check Balance runs unattended; Transfer Funds finishes once a person approves it in the Console (the curl steps at the end of `ACCESS.md` walk through both) | [§5](GENERIC_BANK_PLAN.md#5-the-crawler), [§6](GENERIC_BANK_PLAN.md#6-transfers) · [end to end](#proof-end-to-end) |
| **One business outcome, one recoverable condition, one hard failure** at least, each reported distinctly | Business outcomes return `422`. Recoverable conditions are handled and recorded inside the run, out of the caller's sight. Hard failures return `502` or `503` with `retryable`, and escalations return `409` | [§A.1](GENERIC_BANK_PLAN.md#a1-results-and-http), [§5](GENERIC_BANK_PLAN.md#5-the-crawler), [§A.2](GENERIC_BANK_PLAN.md#a2-failures) · [outcomes](#proof-outcomes) |
| **At least one escalation path:** detect stuck, hand off with context | Six: unknown screen, stall, ambiguous transfer, guard trip, staff code, approval | [§2](GENERIC_BANK_PLAN.md#2-the-pieces), [§3](GENERIC_BANK_PLAN.md#3-the-api) · [escalation](#proof-escalation) |
| **Enforce an allowlist of permitted actions** | One file per job (screen, verb, control). The guard enforces exactly that file; anything else is refused and recorded | [§A.5](GENERIC_BANK_PLAN.md#a5-the-allowlist) · [guardrails](#proof-guardrails) |
| **No secrets or raw PII persisted** in logs or evidence | Values and patterns masked before any write; white boxes on screenshots; frames withheld unless provably clean; secrets in SOPS, typed, never returned | [§9](GENERIC_BANK_PLAN.md#9-safety), [§B.2](GENERIC_BANK_PLAN.md#b2-secrets-and-configuration) · [PII](#proof-pii) |
| **Enough evidence** to understand and debug a run | Every step with its masked frame, a hash-chained journal, and model and tool calls, all under one run id in the Console; plus JSON logs | [§9](GENERIC_BANK_PLAN.md#9-safety) · [evidence](#proof-evidence) |
| **No scaling infrastructure,** but abstractions that could scale | One process per box, two browsers at a time on a laptop. The task runner, driver registry and memory are the seams where Part 2 scales out | [§C.5](GENERIC_BANK_PLAN.md#c5-scaling-and-more), [§2](GENERIC_BANK_PLAN.md#2-the-pieces) · Part 2 |

## 4. What to submit

| The brief says | How we meet it | See |
|---|---|---|
| **A public or shared GitHub repository** with the system, the target app and a README | One public repository: banks, crawler, factory, memory, Console, docs | [§B.1](GENERIC_BANK_PLAN.md#b1-layout), [Appendix B](GENERIC_BANK_PLAN.md#appendix-b-running-and-building-it) · the repository |
| **Reproducible run instructions:** clone and run both tasks locally in a few minutes | `just requirements` (fails until the Mac is ready), `just setup`, `just up`, then curl or Swagger UI from `ACCESS.md`. The Mac needs only Docker and git; an 8 GB laptop is enough | [Appendix B](GENERIC_BANK_PLAN.md#appendix-b-running-and-building-it) · [setup](#proof-setup) |
| **Tests where they help,** especially the error taxonomy and escalation | Outcome, escalation, transfer, guard, PII, browser, memory and factory tests; the transfer-safety and memory suites and the trap matrix in Part 2 | [§B.4](GENERIC_BANK_PLAN.md#b4-tests-and-ci) · [tests](#proof-tests) |
| **Share the repo link before the session** | `master` is always releasable, and its link is what we share | [Appendix B](GENERIC_BANK_PLAN.md#appendix-b-running-and-building-it) · `master` |

## 5. What the README must cover

| The brief says | How we meet it | See |
|---|---|---|
| **How the system fits together:** architecture, decisions, trade-offs, why the boundaries sit where they do | Three boxes, split by what they hold and reach, with the banks outside; one picture | [§2](GENERIC_BANK_PLAN.md#2-the-pieces) · [architecture.md](architecture.md) |
| **How we met the task and minimum scope:** the messy UI, outcomes versus failures, escalation, safety with regulated data | A chapter each in the plan, which the README links | [§5](GENERIC_BANK_PLAN.md#5-the-crawler), [§A.2](GENERIC_BANK_PLAN.md#a2-failures), [§2](GENERIC_BANK_PLAN.md#2-the-pieces), [§9](GENERIC_BANK_PLAN.md#9-safety) · the plan, linked from the README |
| **From 80% to 100%:** what AI produced, what we changed, hardened or threw away, what we would cut, what unattended use still needs | What AI wrote, what we changed, threw away and would cut next, and what unattended use still needs; each rule beside the failure it prevents | [80-to-100.md](80-to-100.md), [§9](GENERIC_BANK_PLAN.md#9-safety) |
| **An architecture diagram:** boundaries, data models, where the risky bits live | The system, transfer and memory pictures, plus the data models | [§2](GENERIC_BANK_PLAN.md#2-the-pieces), [the Prisma schema](../../packages/db/prisma/schema.prisma) · [architecture.md](architecture.md) |

## 6. Extensions: one, done properly

| The brief offers | Our choice | See |
|---|---|---|
| **Cross-tenant reuse:** a base-app task run on a second variant, with per-variant overrides | **The one we build.** One driver per product, a profile per bank, and a software factory that learns a new bank, proves the driver and lets it earn its promotion | [§7](GENERIC_BANK_PLAN.md#7-the-factory), [§5](GENERIC_BANK_PLAN.md#5-the-crawler) · [reuse](#proof-reuse) |
| Reusability: repeat a task without re-solving it; a catalog the agent can discover | Comes with it: promoted drivers in a registry; a task catalog and bank list over REST | [§3](GENERIC_BANK_PLAN.md#3-the-api), [§7](GENERIC_BANK_PLAN.md#7-the-factory) · [catalog](#proof-catalog) |
| Confidence and approval: score tasks, gate unattended runs on approval | Comes with it: draft, candidate, probation, promoted, demoted | [§7](GENERIC_BANK_PLAN.md#7-the-factory) · [driver states](#proof-driver-states) |
| Cost control (not asked for, but a reviewer will wonder) | Only the factory calls models, and our gateway meters and records each call. Spend is **capped at $25 per run and $150 per rolling week**, in code, and fails closed | [§7](GENERIC_BANK_PLAN.md#7-the-factory) · [cost](#proof-cost) |
| Assisted fallback, multi-run stability, code generation | Part 2 | [§C.5](GENERIC_BANK_PLAN.md#c5-scaling-and-more) · Part 2 |

## 7. How the work is reviewed

| The brief weighs | Our answer | See |
|---|---|---|
| **System design** | Typed REST tasks, loaded by agents as tools, over a crawler that reads screens, not markup; clear boxes; small on purpose | [§2](GENERIC_BANK_PLAN.md#2-the-pieces), [§3](GENERIC_BANK_PLAN.md#3-the-api), [§5](GENERIC_BANK_PLAN.md#5-the-crawler) |
| **Robustness and error handling** | Every failure named, detected and reported one way; waits on what's drawn, not on the network | [§A.2](GENERIC_BANK_PLAN.md#a2-failures), [§5](GENERIC_BANK_PLAN.md#5-the-crawler) |
| **Human-in-the-loop escalation** | An inbox, approvals, codes, resume and finish by hand, all in the API too | [§2](GENERIC_BANK_PLAN.md#2-the-pieces), [§3](GENERIC_BANK_PLAN.md#3-the-api) |
| **From 80% to 100%** | First-draft mistakes replaced; every rule explained | [80-to-100.md](80-to-100.md), [§9](GENERIC_BANK_PLAN.md#9-safety) |
| **Generalization to the real environment** | A screen-model seam for other surfaces; one product, four banks; a factory that learns | [§7](GENERIC_BANK_PLAN.md#7-the-factory) |
| **Safety and data handling** | An explicit allowlist, money only under a grant, masking before every write, model spend capped in code | [§9](GENERIC_BANK_PLAN.md#9-safety) |
| **Communication** | A short README, ACCESS.md, the plan and five companion documents, diagrams we can redraw in the session | [Appendix B](GENERIC_BANK_PLAN.md#appendix-b-running-and-building-it) |

## 8. Ground rules

| The brief says | How we meet it | See |
|---|---|---|
| **About a working day; no gold-plating; say what more time would buy** | The core comes first in the build order; Part 2 is what more time would buy | [the build sheets](../build/), [§C.1](GENERIC_BANK_PLAN.md#c1-production-ground) |
| **AI tools welcome; be honest about what was generated and what changed** | A document of its own, and every README claim links to its proof | [80-to-100.md](80-to-100.md) |
| **Language and stack are your call; defend the choice** | TypeScript on Node throughout, each choice with its reason and alternatives | [techstack.md](techstack.md) |
| **Land on an answer; bring opinions** | One strong design, no open questions | the whole plan |

## Proof

What a reviewer can run or open for each requirement.

| Proof | What proves it |
|---|---|
| <a id="proof-hazards"></a>**Hazards** | `apps/bank/test/hazard-matrix.test.ts`: every hazard forced alone, and nothing without it; `just try <hazard> <task>` and the hazard lab show any one |
| <a id="proof-legacy-ui"></a>**Legacy UI** | `tests/runs/execute.test.ts` and `tests/browser/corelink-banks.test.ts`: the crawler drives banks 1 and 2 with no CSS selectors, by label, geometry and visible name |
| <a id="proof-bank-2"></a>**Bank 2** | `tests/browser/corelink-banks.test.ts`: Check Balance on bank 2 through its own profile |
| <a id="proof-api"></a>**API** | `curl` against the API (ACCESS.md); `apps/api/test/catalog.test.ts` pairs each tool with its endpoint |
| <a id="proof-browser"></a>**Browser** | `tests/runs/execute.test.ts`: Check Balance in Chrome, with its masked frames; the Console's run page |
| <a id="proof-escalation"></a>**Escalation** | `tests/escalation/escalations.test.ts`: 409, Resume, then 200, through the API; the Console inbox |
| <a id="proof-guardrails"></a>**Guardrails** | `packages/guardrails/test`: the allowlist refuses what it doesn't list, and a money press without a grant; every end-to-end run goes through the guard |
| <a id="proof-banks"></a>**Banks** | `apps/bank/test`; the hazard lab |
| <a id="proof-tasks"></a>**Tasks** | `tests/runs/execute.test.ts` (Check Balance, Download Statements), `tests/runs/transfer.test.ts` |
| <a id="proof-end-to-end"></a>**End to end** | `tests/runs/execute.test.ts`; `tests/runs/transfer.test.ts`, approved by a person |
| <a id="proof-outcomes"></a>**Outcomes** | `tests/outcomes/outcomes.test.ts`: no such member, a session that ends early, a 503 |
| <a id="proof-pii"></a>**PII** | `tests/pii/pii.test.ts` scans every row, object and log line for every seeded secret and personal value |
| <a id="proof-evidence"></a>**Evidence** | the Console's run page; `just logs` |
| <a id="proof-setup"></a>**Setup** | `ACCESS.md`; the fresh-clone check in CI |
| <a id="proof-tests"></a>**Tests** | `just check`, CI |
| <a id="proof-reuse"></a>**Reuse** | `tests/browser/corelink-banks.test.ts`: bank 2 on its own profile; `tests/browser/repair.test.ts`: the factory repairs a bank's crawler after a redesign |
| <a id="proof-catalog"></a>**Catalog** | `GET /tasks`, `GET /tools` |
| <a id="proof-driver-states"></a>**Driver states** | the Console's **Data** pages, under **Drivers**: each driver's state, its versions and their registry events |
| <a id="proof-cost"></a>**Cost** | the Console's Model calls table; `apps/factory/test` (the meter refuses past a cap) |
