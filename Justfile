# Generic Bank: every action is a just recipe. `just` alone lists them.
#
# The stack runs locally on docker compose. Secrets live in SOPS files under config/, encrypted
# to this machine's age key; `just env` renders one env file per service, each holding only the
# secrets that service may see (infra/secrets/scope.json).

set shell := ["bash", "-euo", "pipefail", "-c"]

# Every recipe sees the settings in config/app.env, with a fork's config/local.env over them (just
# fork-ports writes it; it is never committed). Loading two files needs just's lists setting.
set unstable
set lists
set dotenv-path := ["config/app.env", "config/local.env"]

alias doctor := requirements

# The compose project, and the image tags, are named after this folder, so a second copy has its
# own containers, volumes and images. This folder, generic_bank, is the project generic-bank.
project := `basename "$PWD" | tr 'A-Z_' 'a-z-' | tr -cd 'a-z0-9-'`
export GB_PROJECT := project
export GB_IMAGE := "generic-bank/node:" + project
export GB_RUNNER_IMAGE := "generic-bank/runner:" + project

# Compose reads the same two files.
local_env := if path_exists("config/local.env") == "true" { "--env-file config/local.env" } else { "" }
compose := "docker compose -f infra/compose/compose.yaml --env-file config/app.env " + local_env + " -p " + project
scripts := "infra/scripts"

# Service groups, for up, down, logs and rebuild.
data := "postgres vault minio memory"
backend := "api"
console := "console"
crawlers := "runner"
bank := "bank-db bank-generic bank-example bank-inbox"
bank_more := "bank-sample bank-placeholder"
factory := "factory"

# A hash of everything that goes into the image. The image carries it as a label, so a stale
# image is noticed and rebuilt instead of quietly running yesterday's code.
source_stamp := `find apps packages infra/docker package.json package-lock.json tsconfig*.json -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.tsbuildinfo' 2>/dev/null | LC_ALL=C sort | xargs shasum | shasum | cut -c1-16`

# List every recipe
[group('Start here')]
default:
    @just --list --unsorted

# Check this Mac can build and run the stack (explicit versions); fails if not
[group('Start here')]
requirements:
    @{{scripts}}/requirements.sh

# The same, plus Node 22 for developing and running the tests
[group('Start here')]
requirements-dev:
    @{{scripts}}/requirements.sh --dev

# Render the plan as HTML pages and open them
[group('Start here')]
plan: plan-html
    @open .run/plan/GENERIC_BANK_PLAN.html 2>/dev/null || echo "  open .run/plan/GENERIC_BANK_PLAN.html in a browser"

# Render every document in docs/plan as an HTML page into .run/plan (in a container)
[group('Start here')]
plan-html:
    @{{scripts}}/tool.sh node infra/docs/render-plan.cjs

# Once, after cloning: check the Mac, create secrets, build the images
[group('Start here')]
setup: requirements tools secrets-init build env
    @echo; echo "Ready. Next: just up, then open http://localhost:$CONSOLE_PORT"; echo "Console sign-in: $CONSOLE_ADMIN_EMAIL, password: just console-password"

# Once, to develop: Node dependencies, the Prisma client, Chromium for the tests
[group('Start here')]
dev-setup: requirements-dev install browser

# Install Node dependencies and generate the Prisma client
[group('Start here')]
install:
    @npm ci --no-audit --no-fund
    @npm run --silent db:generate

# For a second copy in another folder: move every port by an offset in config/local.env
[group('Start here')]
fork-ports offset="10000":
    @{{scripts}}/fork-ports.sh "{{offset}}"

# Build the tools image (sops, age, jq, the plan renderer), if its Dockerfile changed
[group('Start here')]
tools:
    @{{scripts}}/tool.sh true

# Create this machine's age key, .sops.yaml and the encrypted secrets files
[group('Secrets (SOPS + age)')]
secrets-init:
    @{{scripts}}/secrets-init.sh

# Render one env file per service into .run/env/ (least privilege)
[group('Secrets (SOPS + age)')]
env:
    @{{scripts}}/render-env.sh

# Edit secrets (in vi, in the tools image): just secrets-edit local|ops|factory
[group('Secrets (SOPS + age)')]
secrets-edit file="local":
    @{{scripts}}/tool.sh sops config/{{file}}.secrets.enc.env

# Set one secret unseen: just secret-set factory ANTHROPIC_API_KEY [path]
[group('Secrets (SOPS + age)')]
secret-set file key from="":
    @{{scripts}}/secret-set.sh "{{file}}" "{{key}}" "{{from}}"

# Rotate one generated secret: just secret-rotate local API_TOKEN_HASH_KEY
[group('Secrets (SOPS + age)')]
secret-rotate file key:
    @{{scripts}}/secret-rotate.sh "{{file}}" "{{key}}"

# List the secret names in each file (never the values)
[group('Secrets (SOPS + age)')]
secrets-keys:
    @for f in local factory ops; do echo "$f"; {{scripts}}/tool.sh sops decrypt --input-type dotenv --output-type dotenv config/$f.secrets.enc.env | cut -d= -f1 | sed 's/^/  /'; done

# Show the Console's first admin password
[group('Secrets (SOPS + age)')]
console-password:
    @{{scripts}}/tool.sh sops decrypt --input-type dotenv --output-type dotenv config/local.secrets.enc.env | grep '^CONSOLE_ADMIN_PASSWORD=' | cut -d= -f2-

# Build the Node image every service runs, and the Runner's (the same plus headless Chromium)
[group('Build')]
build:
    @docker build -f infra/docker/node.Dockerfile --label gb.source={{source_stamp}} -t $GB_IMAGE .
    @docker build -f infra/docker/runner.Dockerfile --build-arg BASE=$GB_IMAGE --label gb.source={{source_stamp}} -t $GB_RUNNER_IMAGE .

# Build the images from scratch (no cache)
[group('Build')]
build-nc:
    @docker build --no-cache -f infra/docker/node.Dockerfile --label gb.source={{source_stamp}} -t $GB_IMAGE .
    @docker build --no-cache -f infra/docker/runner.Dockerfile --build-arg BASE=$GB_IMAGE --label gb.source={{source_stamp}} -t $GB_RUNNER_IMAGE .

# Build the image if it is missing or older than the source
[group('Build')]
image:
    @have="$(docker image inspect -f '{{{{ index .Config.Labels "gb.source" }}' $GB_RUNNER_IMAGE 2>/dev/null || true)"; \
      if [[ "$have" != "{{source_stamp}}" ]]; then echo "==> The image is out of date with the source; building"; just build; fi

# Start everything: data, memory and its seed, back end, console, crawlers, all four banks, the factory
[group('Run')]
up: env image
    @just data
    @just memory-seed
    @just backend console crawlers bank bank-more factory
    @just credentials
    @just urls

# Stop everything (data is kept), or only some groups: just down console bank
[group('Run')]
down *groups:
    @if [[ -z "{{groups}}" ]]; then {{compose}} --profile '*' down; \
      else {{compose}} --profile '*' rm -sf $(just _services {{groups}}); fi

# Stop and start everything
[group('Run')]
restart: down up

# Show what is running and its health
[group('Run')]
ps:
    @{{compose}} --profile '*' ps --format 'table {{{{.Service}}\t{{{{.Status}}\t{{{{.Ports}}'

# Print where the main pages are (ACCESS.md has every URL; secrets/credentials.txt the logins)
[group('Run')]
urls:
    @echo; \
      echo "  Console        http://localhost:$CONSOLE_PORT"; \
      echo "  Task API       http://localhost:$API_PORT/docs"; \
      echo "  Generic Bank   http://localhost:$BANK_GENERIC_PORT/corelink/"; \
      echo "  Example CU     http://localhost:$BANK_EXAMPLE_PORT/"; \
      echo "  Staff inbox    http://localhost:$BANK_INBOX_PORT  (sign-in and approval codes)"; \
      echo "  MinIO          http://localhost:$MINIO_CONSOLE_PORT"; \
      echo "  Vault          http://localhost:$VAULT_PORT/ui"; \
      echo; echo "  Every URL: ACCESS.md. Logins: secrets/credentials.txt"; echo

# Write secrets/credentials.txt: every login and token for HTTP access (never committed)
[group('Run')]
credentials:
    @{{scripts}}/credentials.sh

# A signed X-Hazards value for curl: just hazard-header late-rows,promo
[group('Run')]
hazard-header hazards:
    @{{scripts}}/hazard-header.sh "{{hazards}}"

# Box B: Postgres, Vault, MinIO, Memory
[group('Run')]
data: env image
    @{{compose}} up -d --wait postgres vault minio
    @{{scripts}}/vault.sh ensure
    @{{compose}} up -d --wait memory

# Box A back end: the Task API (and its migrations)
[group('Run')]
backend: env image migrate
    @{{compose}} up -d --wait {{backend}}

# The admin console (AdminJS)
[group('Run')]
console: env image migrate
    @{{compose}} up -d --wait {{console}}

# The Runner, which drives the banks
[group('Run')]
crawlers: env image
    @{{compose}} up -d --wait {{crawlers}}

# Banks 1 and 2, the staff inbox and the banks' database
[group('Run')]
bank: env image
    @{{compose}} up -d --wait {{bank}}

# Banks 3 and 4
[group('Run')]
bank-more: env image
    @{{compose}} --profile more-banks up -d --wait {{bank_more}}
    @echo "  Sample Savings Bank   http://localhost:$BANK_SAMPLE_PORT/online/branch/"; echo "  Placeholder FCU       http://127.0.0.1:$BANK_PLACEHOLDER_PORT/cu/ib/"

# Box D: the software factory (mock mode until ANTHROPIC_API_KEY is set)
[group('Run')]
factory: env image
    @{{compose}} --profile factory up -d --wait {{factory}}

# The factory learns a bank, then runs the gate once you approve: just onboard sample
[group('Factory')]
onboard bank: factory
    @{{compose}} --profile factory-run run --rm factory-run onboard {{bank}}

# The factory repairs a bank's open repair case, then runs the gate: just repair generic
[group('Factory')]
repair bank: factory
    @{{compose}} --profile factory-run run --rm factory-run repair {{bank}}

# The gate alone, for a recommendation approved later: just gate rec_...
[group('Factory')]
gate rec: factory
    @{{compose}} --profile factory-run run --rm factory-run gate {{rec}}

# Apply database migrations
[group('Run')]
migrate: env image
    @{{compose}} up -d --wait postgres
    @{{compose}} run --rm migrate

# Follow every service's logs, or only some groups': just logs crawlers
[group('Run')]
logs *groups:
    @{{compose}} --profile '*' logs -f --tail=100 {{ if groups == "" { "" } else { "$(just _services " + groups + ")" } }}

# Rebuild the image and restart some groups: just rebuild backend
[group('Run')]
rebuild +groups:
    @just build
    @{{compose}} --profile '*' up -d --wait --force-recreate $(just _services {{groups}})

# Show whether Vault is initialized and unsealed
[group('Run')]
vault-status:
    @{{scripts}}/vault.sh status

# Load the starting knowledge (seeds/memory) into memory, through its door, as the curator; again writes nothing
[group('Run')]
memory-seed: env image
    @{{compose}} run --rm memory-seed

# Open psql on the control database
[group('Run')]
db-shell:
    @{{compose}} exec postgres psql -U postgres control

# A task under a forced hazard: just try late-rows [task] [member] [account] [bank]
[group('Run')]
try hazard task="" member="" account="" bank_id="":
    @{{compose}} exec -T -e CONSOLE_PORT=$CONSOLE_PORT api node apps/api/dist/try-cli.js "{{task}}" "{{hazard}}" "{{member}}" "{{account}}" "{{bank_id}}"

# A fresh access token for Swagger UI or curl (15 minutes)
[group('Run')]
api-token:
    @{{compose}} exec -T api node apps/api/dist/token-cli.js

# Write the API reference from the contracts, serve it and open it in Chrome
[group('Run')]
api-docs:
    @npx tsc -b && node apps/api/dist/openapi-cli.js > docs/api/openapi.json && echo "  wrote docs/api/openapi.json"
    @node infra/scripts/serve-docs.mjs docs/api $API_DOCS_PORT

# The demo agent: a member assistant on the configured model, using only the API's tools (scripted without ANTHROPIC_API_KEY)
[group('Run')]
agent: backend
    @mkdir -p .run/agent
    @client="$({{compose}} exec -T api node apps/api/dist/agent-client-cli.js)"; tty="$([[ -t 0 ]] && echo -t || true)"; \
      docker run --rm -i $tty --init --network {{project}}_app -v "$PWD/.run/agent:/app/.run/agent" \
        -e AGENT_CLIENT="$client" -e API_URL=http://api:8000 -e AGENT_PROVIDER -e AGENT_MODEL -e ANTHROPIC_API_KEY \
        $GB_IMAGE node apps/agent/dist/main.js

# The quick checks: typecheck, lint, tests, import boundaries, secrets
[group('Quality')]
check:
    @npm run --silent check
    @just secrets-scan

# The whole suite (what CI runs on every merge to master)
[group('Quality')]
test:
    @npx vitest run

# Everything GitHub's CI runs, here (slow: most of an hour): checks, both suites, images, secrets
[group('Quality')]
ci:
    @{{scripts}}/ci.sh

# Only the tests your uncommitted and unmerged changes touch
[group('Quality')]
test-changed:
    @npx vitest run --changed origin/master --passWithNoTests

# The PII suite: every task on banks 1 and 2, then everything they wrote searched for seeded values
[group('Quality')]
test-pii:
    @npx vitest run tests/pii

# The long suite: runs that sit through the banks' real hazards for minutes
[group('Quality')]
test-long:
    @npx vitest run --config vitest.long.config.ts

# TypeScript, every package
[group('Quality')]
typecheck:
    @npx tsc -b --pretty

# ESLint and Prettier
[group('Quality')]
lint:
    @npm run --silent lint

# Format everything with Prettier
[group('Quality')]
format:
    @npx prettier --write . >/dev/null

# Import boundaries (dependency-cruiser)
[group('Quality')]
boundaries:
    @npm run --silent depcruise

# Secrets (gitleaks, in its pinned image): the whole history and every uncommitted change
[group('Quality')]
secrets-scan:
    @{{scripts}}/secrets-scan.sh

# Install Chromium for the browser tests (.run/browser)
[group('Quality')]
browser:
    @{{scripts}}/browser.sh

# Delete all local data (volumes) and start again from nothing. Asks first.
[group('Housekeeping')]
[confirm('This deletes every database, Vault and object store volume. Continue?')]
reset:
    @{{compose}} --profile '*' down -v

# Remove build output (dist, tsbuildinfo, .run)
[group('Housekeeping')]
clean:
    @rm -rf apps/*/dist packages/*/dist .run
    @find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete

# Not built yet: evals (M7), check-prompts (M9), docs (M10); export, import, trace, observe (Part 2)
[group('Later')]
later name:
    @case "{{name}}" in \
      evals) m="milestone M7" ;; check-prompts) m="milestone M9" ;; docs) m="milestone M10" ;; \
      memory-export|memory-import|export|import|trace|observe) m="Part 2" ;; *) m="a later milestone" ;; esac; \
      echo "just {{name}} is not built yet: it arrives in $m."; exit 1

# Each group's services, for down, logs and rebuild.
[private]
_services +groups:
    @for g in {{groups}}; do case "$g" in \
      data) echo -n "{{data}} " ;; backend) echo -n "{{backend}} " ;; console) echo -n "{{console}} " ;; \
      crawlers) echo -n "{{crawlers}} " ;; bank) echo -n "{{bank}} " ;; bank-more) echo -n "{{bank_more}} " ;; \
      factory) echo -n "{{factory}} " ;; *) echo "unknown group: $g (data, backend, console, crawlers, bank, bank-more, factory)" >&2; exit 1 ;; \
      esac; done
