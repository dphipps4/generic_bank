# Generic Bank: technology stack

Companion to `GENERIC_BANK_PLAN.md` and `architecture.md`.

Three reasons drive every choice below, in this order. The system stays **small enough to
run on an 8 GB laptop**. The **risky parts stay in code we own**. And each piece is
**ordinary**: a reviewer recognizes it and can read the code without a tour.

Each entry gives the choice, the reason, and what else was considered.

---

## 1. Language and runtime

| Element | Choice | Why | Considered |
|---|---|---|---|
| Language | **TypeScript** (strict) | One language for the bank, the automation, the Console and the factory; types carry the task contract end to end | Python for the automation (rejected: two runtimes on a small box, and the contract would cross a language boundary) |
| Runtime | **Node 22 LTS** | Current long-term support; built-in `fetch`, test runner and watch mode | Bun, Deno (younger ecosystems for Playwright and AdminJS) |
| Modules | **ESM** throughout | AdminJS and most current libraries are ESM-only | CommonJS |
| Monorepo | **npm workspaces** with TypeScript project references | No extra tool to learn; incremental builds | pnpm, Nx, Turborepo (more machinery than six apps and nine packages need) |

---

## 2. Services and web

| Element | Choice | Why | Considered |
|---|---|---|---|
| HTTP framework | **Fastify** | Small, fast, schema-first, first-class AdminJS adapter; used by every service | NestJS (more structure, more weight), Express |
| Admin UI | **AdminJS** with `@adminjs/fastify` and `@adminjs/prisma` | The closest thing in Node to a framework admin: lists, filters, search, detail pages, relations, custom actions, role-based access, all generated from the Prisma models; custom React components for the trail viewer, state badges, approval inbox and hazard lab | Refine, React-Admin (frontend frameworks needing an API per model), a hand-built console (more code to own) |
| Admin components | AdminJS **design system** and React components bundled by AdminJS | Custom pages look native to the rest of the Console | |
| API contracts | **zod** schemas in `packages/contracts`, with **OpenAPI** generated from them | One source of truth for inputs, results and outcome codes; the same schema validates the request, types the code and documents the API | io-ts, TypeBox, class-validator |
| API documentation | **OpenAPI** generated from the zod contracts, served by `@fastify/swagger` with **Swagger UI** at `/docs`, and published as a static page with the docs | One source of truth; the reference cannot drift from the code | Hand-written API docs (they drift) |
| Agent interface | **Tool definitions generated from the zod contracts** (`GET /tools`), in the JSON-schema format model APIs accept; agents call the REST endpoints directly | No adapter between the agent and the API; one source of truth for endpoints and tools | An MCP server as the primary interface (an extra layer; offered as an adapter in plan 2) |
| Bank pages | **Hand-written server templates and ES5 JavaScript**, no framework | The target must be legacy on purpose: framesets, nested tables, inline handlers. A framework would make it modern by accident | |
| Statement PDFs | **pdf-lib** | Pure JavaScript, no native dependencies, generates statements from the ledger on request | PDFKit, Puppeteer print-to-PDF |
| Password hashing | **argon2** | Current recommendation for password storage; used by the bank and the Console | bcrypt |

---

## 3. Data

| Element | Choice | Why | Considered |
|---|---|---|---|
| Database | **PostgreSQL 16** with **pgvector** | One engine for the control data, the workflow engine's state, and Memory's episodes, lessons and embeddings | SQLite (no concurrent writers across containers), a graph database for Memory (too heavy for 8 GB, and not needed) |
| ORM and migrations | **Prisma** (`prisma migrate`, Prisma Client) | Schema-first, readable migrations reviewed as SQL, strong generated types, and AdminJS's Prisma adapter reads the same models. Vector columns are declared as unsupported types and queried with `$queryRaw` | Drizzle (closer to SQL, no AdminJS story as mature), TypeORM |
| Schemas | `control` (Task API, Console, registry, evidence index), `memory` (owned by the Memory service alone), workflow engine tables, and a separate `bank-db` instance for the two bank tenants | Each owner has its own schema; the bank shares nothing with the automation | |
| Object storage | **MinIO** through the AWS S3 SDK | Masked screenshots, screen models and run folders; the same code would talk to S3 | Files on a volume (no manifest-level access control, no S3 parity) |

---

## 4. Orchestration

| Element | Choice | Why | Considered |
|---|---|---|---|
| Durable workflows | **DBOS Transact** | A library, not a server: workflows and steps stored in the Postgres we already run, durable sleep for long timers, `send` and `recv` with timeouts for human answers, idempotent workflow ids. Adds almost nothing to memory use | pg-boss or graphile-worker (job queues; human waits and long timers would be hand-built); BullMQ (needs Redis) |
| Scheduling | DBOS scheduled workflows | Probation checks, stuck-run sweeps, gate reminders | cron containers |

---

## 5. Browser, perception and vision

| Element | Choice | Why | Considered |
|---|---|---|---|
| Browser automation | **Playwright** driving **Chromium headless shell** | Reliable frames, popups and downloads; real mouse and keyboard input; the smallest Chromium build | Puppeteer (similar, smaller ecosystem), Selenium |
| Page JavaScript | **Enabled and executed** by Chromium | The bank's content is drawn by its own scripts; a reader that does not execute them sees an empty shell | An HTML-only fetcher (sees nothing) |
| Perception | The **Chrome DevTools Protocol** through Playwright's CDP session (cross-origin frames through their own sessions): `DOMSnapshot` for layout and text across every frame, the `Accessibility` tree, and screenshots | Read from outside the page, so page code cannot see or fake it; no script is ever injected | Running JavaScript in the page (rejected: the page could tamper with it, and it violates the read-only rule) |
| Pictures of text | **Image fingerprints** (a perceptual hash computed with `sharp`), named once by the factory's vision model and stored in the bank's profile | Lets the crawler name image-only buttons without reading pixels | A vision-model call on every run (rejected: cost and latency on every screen) |
| Image work | **sharp** | Paints the white masking boxes, computes image fingerprints, compares frames for the "fully rendered" check | Jimp (slower) |
| Vision model | Claude, through the model gateway, **factory time only** (and the optional bounded assisted fallback) | Judges each Operator step from the screenshot; never inside a production task | |

---

## 6. Models and the factory

| Element | Choice | Why | Considered |
|---|---|---|---|
| Agent harness | **pi** ([pi.dev](https://pi.dev)), one pi session per role | A small, open-source agent harness: a session with a prompt loop, a tool-call hook that can veto, and a session file that doubles as the checkpoint and the record of what the agent did | LangChain.js or LangGraph.js (heavier, more of the loop outside our control), a hand-rolled loop (more code to own) |
| Model gateway | **@anthropic-ai/sdk** behind our own Anthropic-compatible metering endpoint | pi talks to the model only through it, so the spend meter and caps sit where the model cannot see or change them | Calling the model directly from pi (the meter could be bypassed) |
| Operator model | `claude-opus-5-5` | Writes and repairs drivers; the hardest reasoning | |
| Supervisor model | `claude-sonnet-5-5` | Checks every browser step from the screenshot; fast and cheap enough to run on every step | |
| Small judgments | `claude-haiku-4-5-20251001` | Honesty check on review summaries, short classifications | Switching providers through OpenRouter (plan 2) |
| Mock mode | Recorded model responses replayed by the gateway | A reviewer without an API key can still watch a whole factory run | |
| Embeddings | **@huggingface/transformers** with **bge-small-en-v1.5** (384 dimensions, CPU) | Runs in the Memory process; about 130 MB; no external service and no API cost | A hosted embedding API, a separate embedding server container |
| Prompt files | Markdown with YAML frontmatter, answer formats as **JSON Schema** validated with **ajv** | Prompts are reviewed files, versioned and checked like code | Prompts as strings in code (banned by the checker) |

---

## 7. Secrets and configuration

| Element | Choice | Why | Considered |
|---|---|---|---|
| Encrypted config in git | **SOPS** with **age** keys | Secrets can live in the repo encrypted, reviewed like code; the first `make up` creates a local key and dev secrets | Plain `.env` files (no protection), a hosted secrets manager |
| Runtime config | **Environment variables**, parsed by a zod schema that fails closed | Every required value present, secrets at least 32 characters, no two tokens equal | |
| Credentials and device cookies | **HashiCorp Vault** (KV), dev mode locally | Member credentials are fetched only at the moment of typing and never leave the Runner | Credentials in Postgres (even encrypted, they would sit beside everything else) |

---

## 8. Observability

| Element | Choice | Why | Considered |
|---|---|---|---|
| Source of truth | **Postgres records**, shown in the Console | Every step, frame, guard decision, model call and tool call is a row; the Console's timelines read them | |
| Logs | **pino** JSON logs with key redaction and a final scrubbing pass, on stdout and in rotating files under `.data/logs/` | Fast, structured; redaction is configuration rather than discipline | |
| Traces | **OpenTelemetry** SDK for Node in every service; one trace per run; model calls use the **GenAI semantic conventions** | Vendor-neutral; the same spans can go to Grafana Tempo, LangSmith, Langfuse or Phoenix later by configuration | **LangSmith** (hosted: prompts and frames would leave the machine, and it would be a second record of what the agent did) |
| Local trace storage | a small file exporter writing JSON lines to `.data/traces/` | No extra containers on an 8 GB laptop | |
| Optional stack | `make observe`: **OpenTelemetry Collector**, **Grafana Tempo**, **Loki**, **Grafana** | Search and dashboards when wanted, about 600 MB, off by default; always-on in plan 2 | Jaeger (traces only), a hosted APM |
| Metrics and cost | SQL views over the records, charted on the AdminJS dashboard; OpenTelemetry metrics when the collector runs | No metrics stack needed by default | Prometheus (plan 2) |
| Notifications | Console banner and log; optional webhook | ntfy and paging belong to Part 2 of `GENERIC_BANK_PLAN.md` | |

---

## 9. Quality: tests, lint and checks

| Element | Choice | Why |
|---|---|---|
| Test runner | **vitest** | Fast, TypeScript-native, good watch mode |
| Browser tests | vitest with Playwright against the real bank in compose | The same browser the Runner uses |
| Workflow tests | DBOS's testing utilities with a throwaway Postgres | Durable waits and timeouts tested quickly |
| Lint and format | **ESLint** (typescript-eslint) and **Prettier** | Ordinary |
| Driver rules (E0) | Custom rules on the **TypeScript compiler API** | Forbids CSS and id locators, page script, non-GET requests and model calls in drivers, without running the code |
| Import boundaries | **dependency-cruiser** | Guardrails, evals and lint never import the Runner or the factory; nothing imports the bank |
| Spelling and prose | **cspell** with a project dictionary, **markdownlint** | Keeps typos out of prompts and docs |
| Secret scanning | **gitleaks**, from its pinned image | In `make check` (the history and every uncommitted change), in CI over the whole history, and over every built image's filesystem |
| Dependencies | `npm audit` | |
| CI | **GitHub Actions** | Typecheck, lint, unit, `check-prompts`, then a compose job for the browser, outcome, escalation, transfer, guard and PII suites |

---

## 10. Packaging and running

| Element | Choice | Why |
|---|---|---|
| Containers | **Docker** with **docker compose** profiles (`default`, `factory`) | One command locally; every service has a memory limit |
| Entry point | **make** | `make up`, `make demo`, `make factory`, `make try`, `make requirements`, `make down` |
| Images | Node 22 slim; Playwright's Chromium headless shell only in the Runner, Operator browser and sandbox images | Keeps every other image small |

---

## 11. Deliberately not used

| Not used | Why not |
|---|---|
| A graph database for Memory | Postgres with pgvector covers the queries Memory needs at a fraction of the RAM |
| Redis, BullMQ, Celery | The workflow library keeps state in Postgres; nothing needs a broker |
| Kubernetes, Terraform, Atmos | Out of scope locally; Terraform and Atmos are in Part 2 of `GENERIC_BANK_PLAN.md` |
| Intrusion detection, third-party sign-in, rotating credentials | Part 2 of `GENERIC_BANK_PLAN.md`, under "with more time" |
| Real Chrome on real Macs in Part 1 | Part 1 sets the Mac identity at launch in the Linux container (plan §5.1); real Chrome on rented Macs, which makes the graphics renderer and fonts true as well, is Part 2 (plan chapter 23) |
| A model inside production tasks | Cost, reliability and auditability; the model works at factory time |
| A client framework in the bank | The target must stay legacy |
