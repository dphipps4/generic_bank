# Appendix A: the brief, point by point

Each requirement of the brief, how it's met, and the code or test that shows it.

## What to build

| The brief asks for | How it's met | See |
|---|---|---|
| An API an AI agent calls with typed inputs and a structured result, knowing nothing of the UI | One REST API: `POST /tasks/check-balance` and `POST /tasks/transfer`, one typed result, `GET /banks`, and tool definitions at `GET /tools`; OAuth2; Swagger UI | [`server.ts`](../apps/api/src/server.ts), [Appendix B](results.md) |
| Doing the task by operating the application as a person would | Playwright and Chrome, seeing first: the masked picture, the visible tree, controls by role and position; fields found by drawn labels, buttons by drawn names | [`packages/runtime`](../packages/runtime/README.md) |
| Escalating to a person when stuck, with enough context to take over | An unknown page, the same page three times, or an unclear result after Submit stops as 409 with every page's picture; a person resumes, finishes by hand or cancels | [`escalations.test.ts`](../tests/escalation/escalations.test.ts) |
| Staying within an allowlist, and never leaking or persisting sensitive data | Every action is judged against the job's allowlist; personal values are painted out before anything is kept; the PII suite searches every row, object and log line | [`allowlists`](../packages/guardrails/allowlists), [`pii.test.ts`](../tests/pii/pii.test.ts) |
| A deliberately unfriendly legacy console: lookup, balance, transfers; record not found, insufficient funds, session timeout, a surprise dialog | Two 2003-style CoreLink consoles: framesets, deeply nested tables, no test IDs, styled text for buttons; all four errors and more, forced on demand | [`apps/bank`](../apps/bank/src), [the evidence](evidence/bank-1/README.md) |

## Minimum scope

| The brief asks for | How it's met | See |
|---|---|---|
| Two tasks: check balance and transfer funds | Both, typed in and out | [`contracts`](../packages/contracts/src/index.ts) |
| Both end to end through the UI | A balance runs unattended; a transfer runs once a person approves it | [`execute.test.ts`](../tests/runs/execute.test.ts), [`transfer.test.ts`](../tests/runs/transfer.test.ts) |
| One business outcome, one recoverable condition, one hard failure, each reported distinctly | "No such member" (422); a session that ends early, signed in again within the run (200); the bank unavailable (503) | [`outcomes.test.ts`](../tests/outcomes/outcomes.test.ts) |
| One escalation path | Unknown page, stuck, unclear transfer, guard trip, plus the codes and approvals a person gives | [`escalations.test.ts`](../tests/escalation/escalations.test.ts) |
| An allowlist enforced; no secrets or raw PII in logs or evidence | A list per job, judged before each action; masked pictures, text and addresses | [`decide.test.ts`](../packages/guardrails/test/decide.test.ts), [`pii.test.ts`](../tests/pii/pii.test.ts) |
| Enough evidence to debug a run | Every page a step with its masked picture and visible tree, in the Console, run by run | [the runner](../apps/runner/src/execute.ts) |
| No scaling machinery, but abstractions that could scale | A bank is data (its table); the loop, the guard and the API are the same for every bank; runs are durable | [the architecture](architecture.md) |

## What to submit

| The brief asks for | How it's met |
|---|---|
| A repository with the system, the target app and a README | This one |
| Run both tasks locally in a few minutes | `just setup`, `just up`, then Swagger UI and the Console's hazard lab |
| Tests where they help, especially the error taxonomy and escalation | The outcome, escalation, transfer, guard, PII, crawler and factory tests |
| A README on how it fits together, how it meets the task, and 80 to 100, with a diagram | [README](../README.md), [the architecture](architecture.md), [80 to 100](80-to-100.md) |

## The extension: cross-tenant reuse

Bank 2 runs the same vendor product as bank 1, configured differently. Its table, the per-variant part, is learned by the factory and approved by a person. The loop, the runtime, the guard and the API are shared. See [the factory](factory.md).
