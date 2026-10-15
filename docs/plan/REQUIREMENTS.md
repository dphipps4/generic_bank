# Generic Bank: the brief, point by point

Every requirement in the take-home brief, in order: how the system meets it, where the plan covers
it, and a proof a reviewer can run (a test suite, a make target or a demo step).

---

## 1. The environment the brief describes

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **Stable UIs, real runtime errors:** validation, not found, permission denied, surprise dialogs, session expiry, slowness, app errors | Stable per build, and all of these at runtime as named hazards, ambient or forced: latency, script errors, 503s, dialogs, promos, expiry, record-in-use, swallowed submits, injected text | [§C.4](GENERIC_BANK_PLAN.md#c4-runtime-hazards), [§C.2](GENERIC_BANK_PLAN.md#c2-the-operators-journey) | `tests/outcomes` maps each forced hazard to its exact typed result; `make try TASK=… HAZARD=…` |
| **Heterogeneous, legacy surfaces:** server-rendered, framesets, nested tables, no test ids, non-semantic markup; maybe desktop | Framesets, tables nested four to seven deep, no ids, markup that shifts page to page, text as images, script-drawn content, cross-origin frames. Drivers read a screen model, so desktop and terminal surfaces use the same seam | [§C.3](GENERIC_BANK_PLAN.md#c3-deliberately-legacy-surfaces), [§E.1](GENERIC_BANK_PLAN.md#e1-perception-what-the-operator-sees), [§T.5](GENERIC_BANK_PLAN.md#t5-generalization-to-the-real-environment) | `tests/browser`: the crawler drives both banks with no CSS selectors (E0 lint forbids them) |
| **Multi-tenant at scale:** one vendor product, configured per tenant; generalize or degrade gracefully | One API for all banks: `bank` is an input, `GET /banks` lists what each supports, and a newly promoted crawler appears there without a new endpoint. One product (CoreLink) at four banks, each with its own labels, layouts, URLs, account formats and thresholds: one driver, a profile per bank, and the factory onboards new ones. Unknown screens escalate; nothing guesses | [§4](GENERIC_BANK_PLAN.md#4-the-banking-sites), [§E.5](GENERIC_BANK_PLAN.md#e5-drivers-one-vendor-many-tenants), [§7](GENERIC_BANK_PLAN.md#7-the-software-factory) | M7 demo: the factory onboards bank 2 as a profile; banks 3 and 4 wait for it |

## 2. The task: what to build

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **An API our AI agent can call:** typed inputs, a structured result, no knowledge of the UI | One REST API: three tasks, one typed result, a catalog, a bank list, and tool definitions (`GET /tools`) agents call directly. OpenAPI at `/openapi.json`, Swagger UI at `/docs`, OAuth2 tokens with refresh, status codes that say what to do next | [§3](GENERIC_BANK_PLAN.md#3-the-agents-interface), [§D.1](GENERIC_BANK_PLAN.md#d1-tasks), [§D.5](GENERIC_BANK_PLAN.md#d5-tools-for-agents-and-the-demo-agent), [§D.6](GENERIC_BANK_PLAN.md#d6-oauth2-clients-tokens-and-refresh), [§D.7](GENERIC_BANK_PLAN.md#d7-http-status-codes) | `make agent`: a Claude agent using only the tool definitions; a contract test pairs each tool with its endpoint |
| **Operate the application** as a human would; perceiving and driving the UI is the core design choice | A real browser runs the page's JavaScript; the crawler reads what is drawn (layout, accessibility tree, screenshot), knows screens by their words, finds controls by label and geometry, uses the real mouse and keyboard, and checks the next screen | [§5](GENERIC_BANK_PLAN.md#5-the-crawler-and-its-three-jobs), [§E.1](GENERIC_BANK_PLAN.md#e1-perception-what-the-operator-sees), [§E.2](GENERIC_BANK_PLAN.md#e2-fully-rendered-not-network-idle), [§E.3](GENERIC_BANK_PLAN.md#e3-screen-recognition), [§E.4](GENERIC_BANK_PLAN.md#e4-targeting) | `make demo`; `tests/browser`; the masked screenshot trail in the Console |
| **Escalate to a human when stuck,** with enough context to take over | Unknown screens, stalls, ambiguous submits and guard trips escalate with the masked trail and last screen. The API returns `409 Conflict`; a person resumes, finishes by hand or cancels; the agent's retry gets the result | [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§D.8](GENERIC_BANK_PLAN.md#d8-escalate-resolve-retry), [§F.3](GENERIC_BANK_PLAN.md#f3-codes-and-other-human-steps) | `tests/escalation`, all through the API |
| **Stay within guardrails:** an allowlist of permitted actions; never leak or persist sensitive data | A written allowlist per job, enforced by the guard and shown in the Console. Money moves only on a person's single-use grant. Masking before every write. Secrets typed from Vault, never returned | [§13](GENERIC_BANK_PLAN.md#13-keeping-it-safe), [§J.1](GENERIC_BANK_PLAN.md#j1-the-allowlist-written-down), [§J.2](GENERIC_BANK_PLAN.md#j2-the-layers), [§I.2](GENERIC_BANK_PLAN.md#i2-masking) | `tests/guards` (the trap matrix), `tests/pii` |
| **The target application:** a deliberately unfriendly legacy member-servicing console with lookup, balance and transfers; at least record not found, insufficient funds, session timeout and a surprise confirmation dialog | CoreLink Branch Console: lookup, member summary, activity, statements, and transfers with supervisor approval. All four errors, and many more | [§4](GENERIC_BANK_PLAN.md#4-the-banking-sites), [§C.1](GENERIC_BANK_PLAN.md#c1-one-product-four-banks), [§C.2](GENERIC_BANK_PLAN.md#c2-the-operators-journey), [§C.4](GENERIC_BANK_PLAN.md#c4-runtime-hazards) | `apps/bank/test`; the hazard lab |

## 3. Minimum scope

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **At least two tasks through the API:** check balance and transfer funds | Three: Check Balance, Transfer Funds, Download Statements | [§3](GENERIC_BANK_PLAN.md#3-the-agents-interface), [§D.1](GENERIC_BANK_PLAN.md#d1-tasks), [§D.2](GENERIC_BANK_PLAN.md#d2-the-result) | `make demo` |
| **Both tasks end to end** by driving the UI | Check Balance runs unattended; Transfer Funds finishes once a person approves it in the Console (`make demo AUTO_APPROVE=1` approves through the API) | [§5](GENERIC_BANK_PLAN.md#5-the-crawler-and-its-three-jobs), [§6](GENERIC_BANK_PLAN.md#6-transfers-need-a-person), [§F.1](GENERIC_BANK_PLAN.md#f1-flow) | `make demo`, `tests/transfer` |
| **One business outcome, one recoverable condition, one hard failure** at least, each reported distinctly | Business outcomes `422`; recoverable conditions handled and recorded inside the run, invisible to the caller; hard failures `502` or `503` with `retryable`; escalations `409` | [§D.2](GENERIC_BANK_PLAN.md#d2-the-result), [§D.3](GENERIC_BANK_PLAN.md#d3-recoverable-conditions), [§D.4](GENERIC_BANK_PLAN.md#d4-how-failures-are-handled), [§D.7](GENERIC_BANK_PLAN.md#d7-http-status-codes) | `tests/outcomes`: a row per hazard and per seeded member case |
| **At least one escalation path:** detect stuck, hand off with context | Six: unknown screen, stall, ambiguous transfer, guard trip, staff code, approval | [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§D.8](GENERIC_BANK_PLAN.md#d8-escalate-resolve-retry) | `tests/escalation`; the Console inbox |
| **Enforce an allowlist of permitted actions** | One file per job (screen, verb, control). The guard enforces exactly that file and refuses and records the rest | [§J.1](GENERIC_BANK_PLAN.md#j1-the-allowlist-written-down) | `tests/guards`: every trap refused with every other layer removed |
| **No secrets or raw PII persisted** in logs or evidence | Values and patterns masked before any write; white boxes on screenshots; frames withheld unless provably clean; secrets in SOPS and Vault, typed, never returned | [§9](GENERIC_BANK_PLAN.md#9-reviewing-the-evidence), [§I.2](GENERIC_BANK_PLAN.md#i2-masking), [§I.9](GENERIC_BANK_PLAN.md#i9-masking-applies-to-telemetry-too), [Appendix R](GENERIC_BANK_PLAN.md#appendix-r-secrets-and-configuration) | `tests/pii` scans every row, object, log and trace for every seeded secret and personal value |
| **Enough evidence** to understand and debug a run | Steps with a masked frame each, a hash-chained journal, network events, model and tool calls, one run id, all in the Console; JSON logs, OpenTelemetry traces | [§9](GENERIC_BANK_PLAN.md#9-reviewing-the-evidence), [§12](GENERIC_BANK_PLAN.md#12-seeing-what-happened), [§I.1](GENERIC_BANK_PLAN.md#i1-what-every-run-writes), [§I.4](GENERIC_BANK_PLAN.md#i4-three-signals-one-id) | the Console's run page; `make trace RUN=…` |
| **No scaling infrastructure,** but abstractions that could scale | One process per box, one browser at a time on a laptop. The task runner, driver registry and memory are the seams Part 2 scales | [§22](GENERIC_BANK_PLAN.md#22-scaling-out), [Appendix H](GENERIC_BANK_PLAN.md#appendix-h-the-task-runner) | Part 2, chapter 22 |

## 4. What to submit

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **A public or shared GitHub repository** with the system, the target app and a README | One public repository: banks, crawler, factory, memory, Console, docs | [§Q.1](GENERIC_BANK_PLAN.md#q1-layout), [§Q.2](GENERIC_BANK_PLAN.md#q2-documentation-a-short-readme-and-seventeen-documents) | the repository |
| **Reproducible run instructions:** clone and run both tasks locally in a few minutes | `make requirements` (fails until the Mac is ready), `make setup`, `make up`, `make demo`. The Mac needs only Docker and Xcode's tools; an 8 GB laptop is enough | [§14](GENERIC_BANK_PLAN.md#14-running-it), [Appendix S](GENERIC_BANK_PLAN.md#appendix-s-running-it) | `docs/01-setup.md`, `docs/02-running.md` |
| **Tests where they help,** especially the error taxonomy and escalation | Outcome, escalation, transfer-safety, guard, PII, browser, memory and factory suites | [Appendix P](GENERIC_BANK_PLAN.md#appendix-p-tests) | `make check`, CI |
| **Share the repo link before the session** | `master` is always releasable; a `submission` tag marks what was sent | [§Q.3](GENERIC_BANK_PLAN.md#q3-branches) | the tag |

## 5. What the README must cover

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **How the system fits together:** architecture, decisions, trade-offs, why the boundaries sit where they do | Three boxes, split by what they hold and reach, with the banks outside; one picture | [§2](GENERIC_BANK_PLAN.md#2-how-it-fits-together), [§B.1](GENERIC_BANK_PLAN.md#b1-the-three-boxes), [§T.1](GENERIC_BANK_PLAN.md#t1-system-design) | README §2; `docs/03-architecture.md` |
| **How we met the task and minimum scope:** the messy UI, outcomes versus failures, escalation, safety with regulated data | A chapter each, linked from the README | [§5](GENERIC_BANK_PLAN.md#5-the-crawler-and-its-three-jobs), [§D.4](GENERIC_BANK_PLAN.md#d4-how-failures-are-handled), [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§13](GENERIC_BANK_PLAN.md#13-keeping-it-safe) | README §3 to §6 |
| **From 80% to 100%:** what AI produced, what we changed, hardened or threw away, what we would cut, what unattended use still needs | Each first-draft mistake replaced and tied to a test; each rule beside the failure it prevents | [§T.4](GENERIC_BANK_PLAN.md#t4-from-80-to-100), [Appendix U](GENERIC_BANK_PLAN.md#appendix-u-why-each-rule-exists) | `docs/16-from-80-to-100.md` |
| **An architecture diagram:** boundaries, data models, where the risky bits live | The system, transfer and memory pictures, plus the data models | [§2](GENERIC_BANK_PLAN.md#2-how-it-fits-together), [§B.2](GENERIC_BANK_PLAN.md#b2-data-models-control-database-one-prisma-schema) | README; `docs/03-architecture.md` |

## 6. Extensions: one, done properly

| The brief offers | Our choice | Where | Proof |
|---|---|---|---|
| **Cross-tenant reuse:** a base-app task run on a second variant, with per-variant overrides | **The one we build.** One driver per product, a profile per bank, and a software factory that learns a new bank, proves it and earns its promotion | [§7](GENERIC_BANK_PLAN.md#7-the-software-factory), [§E.5](GENERIC_BANK_PLAN.md#e5-drivers-one-vendor-many-tenants), [Appendix M](GENERIC_BANK_PLAN.md#appendix-m-the-software-factory) | M7: bank 2 onboarded as a profile, end to end |
| Reusability: repeat a task without re-solving it; a catalog the agent can discover | Comes with it: promoted drivers in a registry; a task catalog and bank list over REST | [§3](GENERIC_BANK_PLAN.md#3-the-agents-interface), [Appendix L](GENERIC_BANK_PLAN.md#appendix-l-driver-lifecycle-and-the-repair-loop) | `GET /tasks`, `GET /tools` |
| Confidence and approval: score tasks, gate unattended runs on approval | Comes with it: draft, candidate, probation, promoted, demoted | [§10](GENERIC_BANK_PLAN.md#10-promotion-and-demotion), [Appendix L](GENERIC_BANK_PLAN.md#appendix-l-driver-lifecycle-and-the-repair-loop) | the Drivers page |
| Cost control (not asked for, but a reviewer will wonder) | Only the factory calls models, each call metered and recorded at our gateway; spend is **capped at $25 per run and $150 per rolling week**, in code, failing closed | [§7](GENERIC_BANK_PLAN.md#7-the-software-factory), [§M.5](GENERIC_BANK_PLAN.md#m5-caps-in-code) | the Console's Cost page; `apps/factory/test` (the meter refuses past a cap) |
| Assisted fallback, multi-run stability, code generation | Part 2 | [§31](GENERIC_BANK_PLAN.md#31-what-else-more-time-would-buy) | |

## 7. How the work is reviewed

| The brief weighs | Our answer | Where |
|---|---|---|
| **System design** | Typed REST tasks, loaded by agents as tools, over a crawler that reads screens, not markup; clear boxes; small on purpose | [§15](GENERIC_BANK_PLAN.md#15-why-this-answers-the-brief), [§T.1](GENERIC_BANK_PLAN.md#t1-system-design) |
| **Robustness and error handling** | Every failure named, detected and reported one way; wait on what is drawn, not the network | [§D.4](GENERIC_BANK_PLAN.md#d4-how-failures-are-handled), [§E.2](GENERIC_BANK_PLAN.md#e2-fully-rendered-not-network-idle), [§T.2](GENERIC_BANK_PLAN.md#t2-robustness-and-error-handling) |
| **Human-in-the-loop escalation** | An inbox, approvals, codes, resume and hand finish, all in the API too | [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§D.8](GENERIC_BANK_PLAN.md#d8-escalate-resolve-retry), [§T.3](GENERIC_BANK_PLAN.md#t3-human-in-the-loop-escalation) |
| **From 80% to 100%** | First-draft mistakes replaced, each with a test; every rule explained | [§T.4](GENERIC_BANK_PLAN.md#t4-from-80-to-100), [Appendix U](GENERIC_BANK_PLAN.md#appendix-u-why-each-rule-exists) |
| **Generalization to the real environment** | A screen-model seam for other surfaces; one product, four banks; a factory that learns | [§T.5](GENERIC_BANK_PLAN.md#t5-generalization-to-the-real-environment), [§7](GENERIC_BANK_PLAN.md#7-the-software-factory) |
| **Safety and data handling** | An explicit allowlist, money only under a grant, masking before every write, model spend capped in code | [§13](GENERIC_BANK_PLAN.md#13-keeping-it-safe), [Appendix J](GENERIC_BANK_PLAN.md#appendix-j-guardrails), [§T.6](GENERIC_BANK_PLAN.md#t6-safety-and-data-handling) |
| **Communication** | A two-page README, sixteen focused documents, diagrams we can redraw in the session | [§T.7](GENERIC_BANK_PLAN.md#t7-communication), [§Q.2](GENERIC_BANK_PLAN.md#q2-documentation-a-short-readme-and-seventeen-documents) |

## 8. Ground rules

| The brief says | How we meet it | Where |
|---|---|---|
| **About a working day; no gold-plating; say what more time would buy** | The core comes first in the build order; Part 2 is the more-time answer | [§16](GENERIC_BANK_PLAN.md#16-build-order), [§17](GENERIC_BANK_PLAN.md#17-goal) |
| **AI tools welcome; be honest about what was generated and what changed** | A document of its own, and every README claim links to its proof | [§T.4](GENERIC_BANK_PLAN.md#t4-from-80-to-100) |
| **Language and stack are your call; defend the choice** | TypeScript on Node throughout, each choice with its reason and alternatives | [Appendix V](GENERIC_BANK_PLAN.md#appendix-v-technology-stack) |
| **Land on an answer; bring opinions** | One strong design, no open questions | the whole plan |
