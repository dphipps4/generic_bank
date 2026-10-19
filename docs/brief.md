# Appendix A: the brief, point by point

Each requirement of the brief, how it's met, and the code or test that shows it. [How it meets the task](scope.md) tells the same story in prose.

## What to build

| The brief asks for | How it's met | See |
|---|---|---|
| An API an AI agent calls with typed inputs and a structured result, knowing nothing of the UI | One REST API: `POST /tasks/check-balance` and `POST /tasks/transfer`, one typed result, `GET /banks`, and tool definitions at `GET /tools`; OAuth2; Swagger UI | [`server.ts`](../apps/api/src/server.ts), [Appendix B](results.md) |
| Doing the task by operating the application as a person would | Playwright and Chrome, seeing first: the masked picture, the visible tree, controls by role and position; fields found by drawn labels, buttons by drawn names | [`see.ts`](../packages/runtime/src/see.ts) (ready), [`act.ts`](../packages/runtime/src/act.ts) (labels, names and the real mouse), [`hands.ts`](../packages/runtime/src/hands.ts) (acting at a point) |
| Escalating to a person when stuck, with enough context to take over | An unknown page, the same page three times, or an unclear result after Submit stops as 409 with every page's picture; a person resumes, finishes by hand or cancels | [`escalations.test.ts`](../tests/escalation/escalations.test.ts) |
| Staying within an allowlist, and never leaking or persisting sensitive data | Every action is judged against the job's allowlist; personal values are painted out before anything is kept; the PII suite searches every row, object and log line | [`allowlists`](../packages/guardrails/allowlists), [`rule.ts`](../packages/runtime/src/rule.ts) (masking), [`pii.test.ts`](../tests/pii/pii.test.ts) |
| A deliberately unfriendly legacy console: lookup, balance, transfers; record not found, insufficient funds, session timeout, a surprise dialog | Two 2003-style CoreLink consoles: framesets, deeply nested tables, no test IDs, styled text for buttons; all four errors and more, forced on demand from the Console's hazard lab | [`apps/bank`](../apps/bank/src), [the hazard lab](../apps/console/src/pages/lab.ts), [the evidence](evidence/bank-1/README.md), [`table.test.ts`](../packages/crawler/test/table.test.ts) (every row against its picture) |

## Minimum scope

| The brief asks for | How it's met | See |
|---|---|---|
| Two tasks: check balance and transfer funds | Both, typed in and out | [`contracts`](../packages/contracts/src/index.ts) |
| Both end to end through the UI | A balance runs unattended; a transfer runs once a person approves it, and Submit is pressed once | [`execute.test.ts`](../tests/runs/execute.test.ts), [`transfer.ts`](../apps/runner/src/transfer.ts), [`transfer.test.ts`](../tests/runs/transfer.test.ts) |
| One business outcome, one recoverable condition, one hard failure, each reported distinctly | "No such member" (422); a session that ends early, signed in again within the run (200); the bank unavailable (503) | [`outcomes.test.ts`](../tests/outcomes/outcomes.test.ts) |
| One escalation path | Unknown page, stuck, unclear transfer, guard trip, plus the codes and approvals a person gives | [`escalations.test.ts`](../tests/escalation/escalations.test.ts) |
| An allowlist enforced; no secrets or raw PII in logs or evidence | A list per job, judged before each action by the kind of screen and the control's name; masked pictures, text and addresses | [`decide.test.ts`](../packages/guardrails/test/decide.test.ts), [`pii.test.ts`](../tests/pii/pii.test.ts) |
| Enough evidence to debug a run | Every page a step with its masked picture and visible tree, in the Console, run by run | [the runner](../apps/runner/src/execute.ts) |
| No scaling machinery, but abstractions that could scale | A bank is data (its route); the code that replays it, the guard and the API are the same for every bank; runs are durable | [the architecture](architecture.md) |

## What to submit

| The brief asks for | How it's met |
|---|---|
| A repository with the system, the target app and a README | This one |
| Run both tasks locally | `just setup`, `just up`, then [Demo 1](demo-1.md): Swagger UI and the Console's hazard lab |
| Tests where they help, especially the error taxonomy and escalation | The outcome, escalation, transfer, guard, PII, crawler and factory tests |
| A README on how it fits together, how it meets the task, and 80 to 100, with a diagram | [README](../README.md), [the architecture](architecture.md), [how it meets the task](scope.md), [80 to 100](80-to-100.md) |

## The extension: cross-tenant reuse

Bank 2 runs the same vendor product as bank 1, configured differently. Its route, the per-variant part, is learned by the factory's agents and approved by a person. It is plain data, replayed by the same code as bank 1's, with no model. The runtime, the guard and the API are shared. The factory's run is in [`run.ts`](../apps/factory/src/run.ts), the Scout's tools in [`scout.ts`](../apps/factory/src/scout.ts), the Supervisor in [`supervisor.ts`](../apps/factory/src/supervisor.ts), the guard's words for a learned route in [`guard.ts`](../apps/factory/src/guard.ts), and the gate in [`gate.ts`](../apps/factory/src/gate.ts). See [the factory](factory.md) and [Demo 2](demo-2.md).
