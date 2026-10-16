# Generic Bank: technology stack

Every choice runs on an 8 GB laptop, keeps the risky parts in code we own, and is ordinary.

---

## 1. Language and runtime

| Element | Choice | Why |
|---|---|---|
| Language | **TypeScript** (strict) | One language everywhere; types carry the task contract end to end |
| Runtime | **Node 22 LTS** | Built-in `fetch`, test runner and watch mode |
| Modules | **ESM** throughout | AdminJS and most libraries are ESM-only |
| Monorepo | **npm workspaces**, TypeScript project references | Incremental builds, no extra tool |

---

## 2. Services and web

| Element | Choice | Why |
|---|---|---|
| HTTP framework | **Fastify** | Small, fast, schema-first; an AdminJS adapter |
| Admin UI | **AdminJS** (`@adminjs/fastify`, `@adminjs/prisma`), its **design system** and React components | Lists, filters, relations, actions and roles generated from the Prisma models; custom pages (trail viewer, approval inbox, hazard lab, state badges) look native |
| API contracts | **zod** schemas in `packages/contracts` | One schema validates, types and documents every input, result and outcome code |
| API documentation | **OpenAPI** from the zod contracts; **Swagger UI** at `/docs` via `@fastify/swagger`, also a static page | It can't drift from the code |
| Agent interface | **Tool definitions generated from the zod contracts** (`GET /tools`); agents call REST directly | No adapter in between |
| Bank pages | **Hand-written server templates and ES5 JavaScript** | Legacy on purpose: framesets, nested tables, inline handlers |
| Statement PDFs | **pdf-lib** | Pure JavaScript; statements built from the ledger on request |
| Password hashing | **argon2** | The current recommendation |

---

## 3. Data

| Element | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 16** with **pgvector** | One engine for control data, workflow state, and Memory's episodes, lessons and embeddings |
| ORM and migrations | **Prisma** | SQL migrations, generated types, the models AdminJS reads; vectors via `$queryRaw` |
| Schemas | `control`, `memory`, workflow tables; the two bank tenants in a separate `bank-db` | One schema per owner; the bank shares nothing |
| Object storage | **MinIO** via the AWS S3 SDK | Masked screenshots, screen models, run folders; the same code talks to S3 |

---

## 4. Orchestration

| Element | Choice | Why |
|---|---|---|
| Durable workflows | **DBOS Transact** | A library on our Postgres, not a server: durable sleep, `send`/`recv` with timeouts for human answers, idempotent ids |
| Scheduling | DBOS scheduled workflows | Probation checks, stuck-run sweeps, gate reminders |

---

## 5. Browser, perception and vision

| Element | Choice | Why |
|---|---|---|
| Browser automation | **Our own DevTools Protocol client** driving **full Chromium** in modern headless mode (Debian's in the Runner, Chrome for Testing to develop) | Reliable frames, popups, downloads and real input; the identity extension needs full Chromium (plan §E.8) |
| Page JavaScript | **Enabled and executed** | The bank draws its content with script |
| Perception | **Chrome DevTools Protocol** through our client's sessions: `DOMSnapshot`, the `Accessibility` tree, screenshots, across every frame | Read from outside, so the page can't see or fake it; nothing is injected |
| Pictures of text | **Image fingerprints** (perceptual hashes), named once by the factory's vision model, kept in the bank's profile | Image-only buttons get names without reading pixels |
| Image work | **sharp** | Masking boxes, fingerprints, the "fully rendered" frame check |
| Vision model | Claude via the model gateway, **factory time only** (and the optional bounded assisted fallback) | Judges each Scout step from the frame |

---

## 6. Models and the factory

| Element | Choice | Why |
|---|---|---|
| Agent harness | **pi** ([pi.dev](https://pi.dev)), one session per role | Switches model providers by configuration; a prompt loop, a tool-call hook that can veto, a session file as checkpoint |
| Model gateway | Our metering endpoint, per configured provider (Anthropic by default, OpenAI possible) | The spend meter and caps sit where the model can't touch them |
| Scout model (default; configurable) | `claude-opus-5-5`, low effort | Navigates as the Supervisor directs; the cheapest Opus |
| Supervisor model (default; configurable) | `claude-opus-5-5`, high effort | Reasons over every frame and drafts the profile |
| Small judgments | `claude-haiku-4-5-20251001` | Honesty checks on summaries, short classifications |
| Mock mode | Recorded responses replayed by the gateway | A whole factory run without an API key |
| Embeddings | **@huggingface/transformers** with **bge-small-en-v1.5** (384 dimensions, CPU) | In the Memory process, about 130 MB, no API cost |
| Prompt files | Markdown with YAML frontmatter; answers in **JSON Schema**, checked by **ajv** | Prompts are reviewed and versioned like code |

---

## 7. Secrets and configuration

| Element | Choice | Why |
|---|---|---|
| Encrypted config in git | **SOPS** with **age** keys | Encrypted secrets reviewed like code; `make up` makes a local key |
| Runtime config | **Environment variables** through a zod schema that fails closed | All values present, secrets 32+ characters, no duplicate tokens |
| Credentials and device cookies | **HashiCorp Vault** (KV), dev mode locally | Fetched only at the moment of typing; never leave the Runner |

---

## 8. Observability

| Element | Choice | Why |
|---|---|---|
| Source of truth | **Postgres records** | Every step, frame, guard decision and call is a row |
| Logs | **pino** JSON, redacted and scrubbed, to stdout and `.data/logs/` | Redaction is configuration, not discipline |
| Traces (Part 2 of `GENERIC_BANK_PLAN.md`) | **OpenTelemetry**, one trace per run, **GenAI semantic conventions**; `make trace` and `make observe` (**Collector**, **Grafana Tempo**, **Loki**, **Grafana**) | Vendor-neutral; Tempo, LangSmith, Langfuse or Phoenix by configuration |
| Metrics and cost | SQL views on the AdminJS dashboard | No metrics stack by default |
| Notifications | Console banner, log, optional webhook | ntfy and paging are Part 2 |

---

## 9. Quality: tests, lint and checks

| Element | Choice | Why |
|---|---|---|
| Test runner | **vitest** | Fast, TypeScript-native |
| Browser tests | vitest and our DevTools client against the real bank | The Runner's own browser |
| Workflow tests | DBOS testing utilities, throwaway Postgres | Durable waits tested fast |
| Lint and format | **ESLint** (typescript-eslint), **Prettier** | Ordinary |
| Driver rules (E0) | Custom rules on the **TypeScript compiler API** | No CSS or id locators, page script, non-GET requests or model calls in drivers |
| Import boundaries | **dependency-cruiser** | Guardrails, evals and lint never import the Runner or factory; nothing imports the bank |
| Spelling and prose | **cspell**, **markdownlint** | Clean prompts and docs |
| Secret scanning | **gitleaks**, pinned image | History, uncommitted changes and every built image |
| Code quality (Part 2 of `GENERIC_BANK_PLAN.md`) | **SonarQube** (SonarQube Cloud, free for public repositories) | A quality gate on new code (coverage, duplication, hotspots, vulnerabilities) before merge |
| CI | **GitHub Actions** | Typecheck, lint, unit, `check-prompts`, then the compose suites (browser, outcome, escalation, transfer, guard, PII) |

---

## 10. Packaging and running

| Element | Choice | Why |
|---|---|---|
| Containers | **Docker** compose profiles (`default`, `factory`) | One command; a memory limit on every service |
| Entry point | **make** | `up`, `demo`, `factory`, `try`, `requirements`, `down` |
| Images | Node 22 slim; Debian's Chromium only where a browser runs | Small images |
