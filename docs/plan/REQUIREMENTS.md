# Generic Bank: the brief, point by point

Every requirement in the take-home brief, in the brief's own order, with how this system meets
it, where the plan describes it, and what proves it. "Proof" names the test suite, the make
target or the demo step a reviewer can run.

---

## 1. The environment the brief describes

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **Stable UIs, but real runtime errors:** validation errors, record not found, permission denials, unexpected confirmation dialogs, session expiry, transient slowness, outright app errors | The banks are stable per build and produce every one of these at runtime: random latency, script errors, 503s, dialogs, promos, expiry, record-in-use, swallowed submits, injected text. Each is a named hazard, ambient or forced | [§C.4](GENERIC_BANK_PLAN.md#c4-runtime-hazards), [§C.2](GENERIC_BANK_PLAN.md#c2-the-operators-journey) | `tests/outcomes`: every forced hazard maps to its exact typed result; `make try TASK=… HAZARD=…` |
| **Heterogeneous, legacy surfaces:** server-rendered, framesets, nested tables, no test ids, non-semantic markup; possibly desktop | Framesets, four to seven nested tables, no ids, markup that varies page to page, text drawn as images, content drawn by the page's own JavaScript, cross-origin frames. Drivers read a screen model, so desktop and terminal surfaces plug into the same seam | [§C.3](GENERIC_BANK_PLAN.md#c3-deliberately-legacy-surfaces), [§E.1](GENERIC_BANK_PLAN.md#e1-perception-what-the-operator-sees), [§T.5](GENERIC_BANK_PLAN.md#t5-generalization-to-the-real-environment) | `tests/browser`: the crawler drives both banks with no CSS selectors (E0 lint forbids them) |
| **Multi-tenant at scale:** many tenants run the same vendor product, configured differently; automation should generalize or degrade gracefully | One API for every bank: `bank` is an input, `GET /banks` says which banks support which tasks, and a newly promoted crawler makes its bank appear with no new endpoint. One product (CoreLink), four banks with different labels, layouts, URLs, account formats and thresholds; one driver per product, one profile per bank; the factory onboards a new bank as a profile; an unknown screen escalates instead of guessing | [§4](GENERIC_BANK_PLAN.md#4-the-banking-sites), [§E.5](GENERIC_BANK_PLAN.md#e5-drivers-one-vendor-many-tenants), [§7](GENERIC_BANK_PLAN.md#7-the-software-factory) | M7 demo: the factory onboards bank 2 as a profile; banks 3 and 4 wait for it |

## 2. The task: what to build

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **Expose an API our AI agent can call,** programmatic, typed inputs, structured result, no knowledge of the UI | One REST API: three tasks, one typed result, a discoverable catalog and bank list, and tool definitions (`GET /tools`) that agents load and call directly. Self-documenting: OpenAPI at `/openapi.json` and Swagger UI at `/docs`. OAuth2 clients with access and refresh tokens; HTTP status codes that say what to do next | [§3](GENERIC_BANK_PLAN.md#3-the-agents-interface), [§D.1](GENERIC_BANK_PLAN.md#d1-tasks), [§D.5](GENERIC_BANK_PLAN.md#d5-tools-for-agents-and-the-demo-agent), [§D.6](GENERIC_BANK_PLAN.md#d6-oauth2-clients-tokens-and-refresh), [§D.7](GENERIC_BANK_PLAN.md#d7-http-status-codes) | `make agent`: a Claude agent uses only the API's tool definitions; a contract test comparing each tool with its endpoint |
| **Accomplish the task by operating the application** the way a human operator would; how we perceive and drive the UI is a core design choice | A real browser runs each page's JavaScript; the crawler reads the drawn result from outside the page (layout, accessibility tree, screenshot), recognizes screens by their words, targets controls by label and geometry, acts with the real mouse and keyboard, and verifies the next screen | [§5](GENERIC_BANK_PLAN.md#5-the-crawler-and-its-three-jobs), [§E.1](GENERIC_BANK_PLAN.md#e1-perception-what-the-operator-sees), [§E.2](GENERIC_BANK_PLAN.md#e2-fully-rendered-not-network-idle), [§E.3](GENERIC_BANK_PLAN.md#e3-screen-recognition), [§E.4](GENERIC_BANK_PLAN.md#e4-targeting) | `make demo`; `tests/browser`; the trail of masked screenshots in the Console |
| **Escalate to a human when stuck,** with enough context for a person to take over | Unknown screens, stalls, ambiguous submits and guard trips escalate with the masked trail and the last screen. The API answers `409 Conflict`; a person resumes, finishes by hand or cancels; the agent retries and gets the result | [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§D.8](GENERIC_BANK_PLAN.md#d8-escalate-resolve-retry), [§F.3](GENERIC_BANK_PLAN.md#f3-codes-and-other-human-steps) | `tests/escalation`, driven entirely through the API |
| **Stay within safety guardrails:** respect an allowlist of permitted actions; do not leak or persist sensitive data | A written allowlist per job, enforced by the guard and shown in the Console; money moves only under a person's single-use grant; masking before every write; secrets typed from Vault and never returned | [§13](GENERIC_BANK_PLAN.md#13-keeping-it-safe), [§J.1](GENERIC_BANK_PLAN.md#j1-the-allowlist-written-down), [§J.2](GENERIC_BANK_PLAN.md#j2-the-layers), [§I.2](GENERIC_BANK_PLAN.md#i2-masking) | `tests/guards` (the trap matrix), `tests/pii` |
| **The target application:** a legacy member-servicing console with member lookup and balance, and a transfer between accounts; deliberately unfriendly; at least record not found, insufficient funds, session timeout and an unexpected confirmation dialog | CoreLink Branch Console: a staff console with member lookup, member summary, activity, statements and transfers with supervisor approval. All four named errors, and many more | [§4](GENERIC_BANK_PLAN.md#4-the-banking-sites), [§C.1](GENERIC_BANK_PLAN.md#c1-one-product-four-banks), [§C.2](GENERIC_BANK_PLAN.md#c2-the-operators-journey), [§C.4](GENERIC_BANK_PLAN.md#c4-runtime-hazards) | `apps/bank/test`; the hazard lab |

## 3. Minimum scope

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **At least two tasks through the API:** check balance and transfer funds, typed inputs, structured results | Three: Check Balance, Transfer Funds and Download Statements | [§3](GENERIC_BANK_PLAN.md#3-the-agents-interface), [§D.1](GENERIC_BANK_PLAN.md#d1-tasks), [§D.2](GENERIC_BANK_PLAN.md#d2-the-result) | `make demo` |
| **Complete both tasks end to end** against the target app by driving its UI | Check Balance runs unattended; Transfer Funds runs end to end with a person's approval in the Console (`make demo AUTO_APPROVE=1` approves through the API) | [§5](GENERIC_BANK_PLAN.md#5-the-crawler-and-its-three-jobs), [§6](GENERIC_BANK_PLAN.md#6-transfers-need-a-person), [§F.1](GENERIC_BANK_PLAN.md#f1-flow) | `make demo`, `tests/transfer` |
| **Handle at least one business outcome, one recoverable condition and one hard failure,** each reported deliberately and distinguishably | Business outcomes (`422`), recoverable conditions handled inside the run and recorded (never reach the caller), hard failures (`502` or `503` with `retryable`), escalations (`409`) | [§D.2](GENERIC_BANK_PLAN.md#d2-the-result), [§D.3](GENERIC_BANK_PLAN.md#d3-recoverable-conditions), [§D.4](GENERIC_BANK_PLAN.md#d4-how-failures-are-handled), [§D.7](GENERIC_BANK_PLAN.md#d7-http-status-codes) | `tests/outcomes`: one row per hazard and per seeded member case |
| **Demonstrate at least one escalation path:** detect stuck, hand off with enough context | Several: unknown screen, stall, ambiguous transfer, guard trip, staff code, approval | [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§D.8](GENERIC_BANK_PLAN.md#d8-escalate-resolve-retry) | `tests/escalation`; the Console inbox |
| **Enforce an allowlist of permitted actions** | The allowlist is a file per job: screen, verb, control. The guard enforces exactly that file; anything else is refused and recorded | [§J.1](GENERIC_BANK_PLAN.md#j1-the-allowlist-written-down) | `tests/guards`: every trap refused with each other layer removed |
| **Show that secrets and raw PII are not persisted** in logs or evidence | Known values and patterns masked before any write; screenshots covered with white boxes; frames withheld when not provably clean; secrets in SOPS and Vault, typed and never returned | [§9](GENERIC_BANK_PLAN.md#9-reviewing-the-evidence), [§I.2](GENERIC_BANK_PLAN.md#i2-masking), [§I.9](GENERIC_BANK_PLAN.md#i9-masking-applies-to-telemetry-too), [Appendix R](GENERIC_BANK_PLAN.md#appendix-r-secrets-and-configuration) | `tests/pii`: scans every row, object, log and trace file for every seeded secret and personal value |
| **Capture enough evidence** that someone could understand and debug a run | One masked frame per step, steps, a hash-chained journal, network events, model and tool calls, all keyed by one run id and shown in the Console; JSON logs and OpenTelemetry traces | [§9](GENERIC_BANK_PLAN.md#9-reviewing-the-evidence), [§12](GENERIC_BANK_PLAN.md#12-seeing-what-happened), [§I.1](GENERIC_BANK_PLAN.md#i1-what-every-run-writes), [§I.4](GENERIC_BANK_PLAN.md#i4-three-signals-one-id) | the Console's run page; `make trace RUN=…` |
| **No scaling infrastructure needed;** design the abstractions so they could scale | One process per box, one browser at a time on a laptop; the task runner, driver registry and memory are the seams that scale in Part 2 | [§22](GENERIC_BANK_PLAN.md#22-scaling-out), [Appendix H](GENERIC_BANK_PLAN.md#appendix-h-the-task-runner) | Part 2, chapter 22 |

## 4. What to submit

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **A public or shared GitHub repository** with the system, the target app and a README | One public repository: the banks, the crawler, the factory, memory, the Console and the docs | [§Q.1](GENERIC_BANK_PLAN.md#q1-layout), [§Q.2](GENERIC_BANK_PLAN.md#q2-documentation-a-short-readme-and-sixteen-documents) | the repository |
| **Clear, reproducible run instructions:** clone and run both tasks locally in a few minutes | `make setup`, then `make up`, then `make demo`; every step is a make target; fits an 8 GB laptop | [§14](GENERIC_BANK_PLAN.md#14-running-it), [Appendix S](GENERIC_BANK_PLAN.md#appendix-s-running-it) | `docs/01-setup.md`, `docs/02-running.md` |
| **Tests where they help,** especially the error taxonomy and the escalation path | Outcome, escalation, transfer-safety, guard, PII, browser, memory and factory suites | [Appendix P](GENERIC_BANK_PLAN.md#appendix-p-tests) | `make check`, CI |
| **Share the repo link ahead of the session** | The `master` branch is always releasable; a `submission` tag marks what was sent | [§Q.3](GENERIC_BANK_PLAN.md#q3-branches) | the tag |

## 5. What the README must cover

| The brief says | How we meet it | Where | Proof |
|---|---|---|---|
| **How the system fits together:** architecture, key decisions and trade-offs, why the boundaries are where they are | Three boxes split by what they hold and reach; the banks as the outside world; one picture | [§2](GENERIC_BANK_PLAN.md#2-how-it-fits-together), [§B.1](GENERIC_BANK_PLAN.md#b1-the-three-boxes), [§T.1](GENERIC_BANK_PLAN.md#t1-system-design) | README §2; `docs/03-architecture.md` |
| **How we met the task and minimum scope:** driving the messy UI, separating outcomes and failures, escalation, safety with regulated data | One chapter each, linked from the README | [§5](GENERIC_BANK_PLAN.md#5-the-crawler-and-its-three-jobs), [§D.4](GENERIC_BANK_PLAN.md#d4-how-failures-are-handled), [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§13](GENERIC_BANK_PLAN.md#13-keeping-it-safe) | README §3 to §6 |
| **From 80% to 100%:** what AI produced, what we changed, hardened or threw away, what we would cut, what is still needed before unattended use | Every first-draft mistake the plan replaces, each tied to a test; every rule with the failure it prevents | [§T.4](GENERIC_BANK_PLAN.md#t4-from-80-to-100), [Appendix U](GENERIC_BANK_PLAN.md#appendix-u-why-each-rule-exists) | `docs/16-from-80-to-100.md` |
| **An architecture diagram:** boundaries, data models, where the risky bits live | The system picture, the transfer picture and the memory picture, plus the data models | [§2](GENERIC_BANK_PLAN.md#2-how-it-fits-together), [§B.2](GENERIC_BANK_PLAN.md#b2-data-models-control-database-one-prisma-schema) | README; `docs/03-architecture.md` |

## 6. Extensions: one, done properly

| The brief offers | Our choice | Where | Proof |
|---|---|---|---|
| **Cross-tenant reuse:** apply a task built for a base app to a second variant with per-variant overrides | **The extension we build.** One driver per product, a profile per bank, and a software factory that learns a new bank, proves it and earns its promotion | [§7](GENERIC_BANK_PLAN.md#7-the-software-factory), [§E.5](GENERIC_BANK_PLAN.md#e5-drivers-one-vendor-many-tenants), [Appendix M](GENERIC_BANK_PLAN.md#appendix-m-the-software-factory) | M7: bank 2 onboarded as a profile, end to end |
| Reusability: repeat a completed task without re-solving it; a catalog the agent can discover | Part of the same work: promoted drivers in a registry, and a task catalog and bank list over REST | [§3](GENERIC_BANK_PLAN.md#3-the-agents-interface), [Appendix L](GENERIC_BANK_PLAN.md#appendix-l-driver-lifecycle-and-the-repair-loop) | `GET /tasks`, `GET /tools` |
| Confidence and approval: score tasks, gate unattended runs on approval | Part of the same work: draft, candidate, probation, promoted, demoted | [§10](GENERIC_BANK_PLAN.md#10-promotion-and-demotion), [Appendix L](GENERIC_BANK_PLAN.md#appendix-l-driver-lifecycle-and-the-repair-loop) | the Drivers page |
| Assisted fallback, multi-run stability, code generation | Next steps, in Part 2 | [§31](GENERIC_BANK_PLAN.md#31-what-else-more-time-would-buy) | |

## 7. How the work is reviewed

| The brief weighs | Our answer | Where |
|---|---|---|
| **System design** | A typed REST task API, loaded by agents as tools, over a crawler that reads screens, not markup; clear boxes; small on purpose | [§15](GENERIC_BANK_PLAN.md#15-why-this-answers-the-brief), [§T.1](GENERIC_BANK_PLAN.md#t1-system-design) |
| **Robustness and error handling** | Every failure named, detected and reported one way; waiting on what is drawn, not on the network | [§D.4](GENERIC_BANK_PLAN.md#d4-how-failures-are-handled), [§E.2](GENERIC_BANK_PLAN.md#e2-fully-rendered-not-network-idle), [§T.2](GENERIC_BANK_PLAN.md#t2-robustness-and-error-handling) |
| **Human-in-the-loop escalation** | A working inbox, approvals, codes, resume and hand finish, all through the API too | [§8](GENERIC_BANK_PLAN.md#8-the-console-where-people-step-in), [§D.8](GENERIC_BANK_PLAN.md#d8-escalate-resolve-retry), [§T.3](GENERIC_BANK_PLAN.md#t3-human-in-the-loop-escalation) |
| **From 80% to 100%** | The first-draft mistakes replaced, each with a test, and every rule explained | [§T.4](GENERIC_BANK_PLAN.md#t4-from-80-to-100), [Appendix U](GENERIC_BANK_PLAN.md#appendix-u-why-each-rule-exists) |
| **Generalization to the real environment** | A screen-model seam for other surfaces; one product, four banks; a factory that learns | [§T.5](GENERIC_BANK_PLAN.md#t5-generalization-to-the-real-environment), [§7](GENERIC_BANK_PLAN.md#7-the-software-factory) |
| **Safety and data handling** | An explicit allowlist, money only under a grant, masking before every write | [§13](GENERIC_BANK_PLAN.md#13-keeping-it-safe), [Appendix J](GENERIC_BANK_PLAN.md#appendix-j-guardrails), [§T.6](GENERIC_BANK_PLAN.md#t6-safety-and-data-handling) |
| **Communication** | A two-page README, sixteen focused documents, diagrams that can be redrawn in the session | [§T.7](GENERIC_BANK_PLAN.md#t7-communication), [§Q.2](GENERIC_BANK_PLAN.md#q2-documentation-a-short-readme-and-sixteen-documents) |

## 8. Ground rules

| The brief says | How we meet it | Where |
|---|---|---|
| **About a working day; do not gold-plate; say what you would do with more time** | The core comes first in the build order; Part 2 is the "with more time" answer | [§16](GENERIC_BANK_PLAN.md#16-build-order), [§17](GENERIC_BANK_PLAN.md#17-goal) |
| **AI tools welcome; be honest about what was generated and what was changed** | A dedicated document, and every claim in the README links to its proof | [§T.4](GENERIC_BANK_PLAN.md#t4-from-80-to-100) |
| **Language and stack are your call; defend the choice** | TypeScript on Node throughout, every choice with its reason and its alternatives | [Appendix V](GENERIC_BANK_PLAN.md#appendix-v-technology-stack) |
| **Land on an answer; bring opinions** | One strong design, no open questions | the whole plan |
