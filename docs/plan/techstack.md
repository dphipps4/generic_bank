# Generic Bank: technology stack

Companion to `GENERIC_BANK_PLAN.md` and `architecture.md`.

Three rules decide every choice, in this order: it **runs on an 8 GB laptop**, the **risky
parts live in code we own**, and every piece is **ordinary**, something a reviewer reads
without a tour.

---

## 1. Language and runtime

| Element | Choice | Why | Considered |
|---|---|---|---|
| Language | **TypeScript** (strict) | One language everywhere; types carry the task contract end to end | Python for the automation (two runtimes, a contract across languages) |
| Runtime | **Node 22 LTS** | Built-in `fetch`, test runner and watch mode | Bun, Deno |
| Modules | **ESM** throughout | AdminJS and most libraries are ESM-only | CommonJS |
| Monorepo | **npm workspaces**, TypeScript project references | Incremental builds, no extra tool | pnpm, Nx, Turborepo (too much for six apps and nine packages) |

---

## 2. Services and web

| Element | Choice | Why | Considered |
|---|---|---|---|
| HTTP framework | **Fastify** | Small, fast, schema-first; an AdminJS adapter | NestJS, Express |
| Admin UI | **AdminJS** (`@adminjs/fastify`, `@adminjs/prisma`), its **design system** and React components | Lists, filters, relations, actions and roles generated from the Prisma models; custom pages (trail viewer, approval inbox, hazard lab, state badges) look native | Refine, React-Admin, a hand-built console |
| API contracts | **zod** schemas in `packages/contracts` | One schema validates, types and documents every input, result and outcome code | io-ts, TypeBox, class-validator |
| API documentation | **OpenAPI** from the zod contracts; **Swagger UI** at `/docs` via `@fastify/swagger`, also a static page | It can't drift from the code | Hand-written docs |
| Agent interface | **Tool definitions generated from the zod contracts** (`GET /tools`); agents call REST directly | No adapter in between | An MCP server (an adapter in Part 2) |
| Bank pages | **Hand-written server templates and ES5 JavaScript** | Legacy on purpose: framesets, nested tables, inline handlers | |
| Statement PDFs | **pdf-lib** | Pure JavaScript; statements built from the ledger on request | PDFKit, Puppeteer |
| Password hashing | **argon2** | The current recommendation | bcrypt |

---

## 3. Data

| Element | Choice | Why | Considered |
|---|---|---|---|
| Database | **PostgreSQL 16** with **pgvector** | One engine for control data, workflow state, and Memory's episodes, lessons and embeddings | SQLite (no concurrent writers across containers), a graph database for Memory (too heavy for 8 GB, and not needed) |
| ORM and migrations | **Prisma** | SQL migrations, generated types, the models AdminJS reads; vectors via `$queryRaw` | Drizzle, TypeORM |
| Schemas | `control`, `memory`, workflow tables; the two bank tenants in a separate `bank-db` | One schema per owner; the bank shares nothing | |
| Object storage | **MinIO** via the AWS S3 SDK | Masked screenshots, screen models, run folders; the same code talks to S3 | Files on a volume |

---

## 4. Orchestration

| Element | Choice | Why | Considered |
|---|---|---|---|
| Durable workflows | **DBOS Transact** | A library on our Postgres, not a server: durable sleep, `send`/`recv` with timeouts for human answers, idempotent ids | pg-boss, graphile-worker (human waits built by hand), BullMQ (needs Redis) |
| Scheduling | DBOS scheduled workflows | Probation checks, stuck-run sweeps, gate reminders | cron containers |

---

## 5. Browser, perception and vision

| Element | Choice | Why | Considered |
|---|---|---|---|
| Browser automation | **Our own DevTools Protocol client** driving **full Chromium** in modern headless mode (Debian's in the Runner, Chrome for Testing to develop) | Reliable frames, popups, downloads and real input; the identity extension needs full Chromium (plan §E.8) | Playwright, Puppeteer (they inject scripts and add automation tells) |
| Page JavaScript | **Enabled and executed** | The bank draws its content with script | An HTML-only fetcher (sees an empty shell) |
| Perception | **Chrome DevTools Protocol** through our client's sessions: `DOMSnapshot`, the `Accessibility` tree, screenshots, across every frame | Read from outside, so the page can't see or fake it; nothing is injected | JavaScript in the page (tamperable, and it breaks the read-only rule) |
| Pictures of text | **Image fingerprints** (perceptual hashes), named once by the factory's vision model, kept in the bank's profile | Image-only buttons get names without reading pixels | A vision call every run |
| Image work | **sharp** | Masking boxes, fingerprints, the "fully rendered" frame check | Jimp |
| Vision model | Claude via the model gateway, **factory time only** (and the optional bounded assisted fallback) | Judges each Operator step from the screenshot | |

---

## 6. Models and the factory

| Element | Choice | Why | Considered |
|---|---|---|---|
| Agent harness | **pi** ([pi.dev](https://pi.dev)), one session per role | Small, open source: a prompt loop, a tool-call hook that can veto, a session file that is checkpoint and record | LangChain.js, LangGraph.js, a hand-rolled loop |
| Model gateway | **@anthropic-ai/sdk** behind our Anthropic-compatible metering endpoint | The spend meter and caps sit where the model can't touch them | Calling the model straight from pi |
| Operator model | `claude-opus-5-5` | Writes and repairs drivers | |
| Supervisor model | `claude-sonnet-5-5` | Cheap enough to check every browser step | |
| Small judgments | `claude-haiku-4-5-20251001` | Honesty checks on summaries, short classifications | OpenRouter (Part 2) |
| Mock mode | Recorded responses replayed by the gateway | A whole factory run without an API key | |
| Embeddings | **@huggingface/transformers** with **bge-small-en-v1.5** (384 dimensions, CPU) | In the Memory process, about 130 MB, no API cost | A hosted API, an embedding server |
| Prompt files | Markdown with YAML frontmatter; answers in **JSON Schema**, checked by **ajv** | Prompts are reviewed and versioned like code | Strings in code (banned) |

---

## 7. Secrets and configuration

| Element | Choice | Why | Considered |
|---|---|---|---|
| Encrypted config in git | **SOPS** with **age** keys | Encrypted secrets reviewed like code; `make up` makes a local key | Plain `.env`, a hosted secrets manager |
| Runtime config | **Environment variables** through a zod schema that fails closed | All values present, secrets 32+ characters, no duplicate tokens | |
| Credentials and device cookies | **HashiCorp Vault** (KV), dev mode locally | Fetched only at the moment of typing; never leave the Runner | Postgres (they'd sit beside everything else) |

---

## 8. Observability

| Element | Choice | Why | Considered |
|---|---|---|---|
| Source of truth | **Postgres records** | Every step, frame, guard decision and call is a row | |
| Logs | **pino** JSON, redacted and scrubbed, to stdout and `.data/logs/` | Redaction is configuration, not discipline | |
| Traces | **OpenTelemetry**, one trace per run, **GenAI semantic conventions**; JSON lines in `.data/traces/` | Vendor-neutral; Tempo, LangSmith, Langfuse or Phoenix by configuration | **LangSmith** (prompts and frames would leave the machine) |
| Optional stack | `make observe`: **OpenTelemetry Collector**, **Grafana Tempo**, **Loki**, **Grafana** | About 600 MB, off by default, always on in Part 2 | Jaeger, a hosted APM |
| Metrics and cost | SQL views on the AdminJS dashboard | No metrics stack by default | Prometheus (Part 2) |
| Notifications | Console banner, log, optional webhook | ntfy and paging are Part 2 | |

---

## 9. Quality: tests, lint and checks

| Element | Choice | Why |
|---|---|---|
| Test runner | **vitest** | Fast, TypeScript-native |
| Browser tests | vitest and Playwright against the real bank in compose | The Runner's own browser |
| Workflow tests | DBOS testing utilities, throwaway Postgres | Durable waits tested fast |
| Lint and format | **ESLint** (typescript-eslint), **Prettier** | Ordinary |
| Driver rules (E0) | Custom rules on the **TypeScript compiler API** | No CSS or id locators, page script, non-GET requests or model calls in drivers |
| Import boundaries | **dependency-cruiser** | Guardrails, evals and lint never import the Runner or factory; nothing imports the bank |
| Spelling and prose | **cspell**, **markdownlint** | Clean prompts and docs |
| Secret scanning | **gitleaks**, pinned image | History, uncommitted changes and every built image |
| Dependencies | `npm audit` | |
| Code quality (Part 2 of `GENERIC_BANK_PLAN.md`) | **SonarQube** (SonarQube Cloud, free for public repositories) | A quality gate on new code (coverage, duplication, hotspots, vulnerabilities) before merge |
| CI | **GitHub Actions** | Typecheck, lint, unit, `check-prompts`, then the compose suites (browser, outcome, escalation, transfer, guard, PII) |

---

## 10. Packaging and running

| Element | Choice | Why |
|---|---|---|
| Containers | **Docker** compose profiles (`default`, `factory`) | One command; a memory limit on every service |
| Entry point | **make** | `up`, `demo`, `factory`, `try`, `requirements`, `down` |
| Images | Node 22 slim; Debian's Chromium only where a browser runs | Small images |

---

## 11. Deliberately not used

| Not used | Why not |
|---|---|
| A graph database for Memory | Postgres with pgvector covers the queries Memory needs at a fraction of the RAM |
| Redis, BullMQ, Celery | State lives in Postgres; nothing needs a broker |
| Kubernetes, Terraform, Atmos | Terraform and Atmos are Part 2 |
| Intrusion detection, third-party sign-in, rotating credentials | Part 2 |
| Real Chrome on real Macs | Part 1 sets the Mac identity inside the Linux container (plan §5.1); real Macs are Part 2 (plan §23) |
| A model inside production tasks | Cost, reliability, auditability |
| A client framework in the bank | It must stay legacy |
