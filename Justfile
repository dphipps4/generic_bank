# Generic Bank: every action is a just recipe. `just` alone lists them.
#
# The stack runs locally on docker compose. Secrets live in SOPS files under config/, encrypted
# to this machine's age key; `just env` renders one env file per service, each holding only the
# secrets that service may see (infra/secrets/scope.json).

set shell := ["bash", "-euo", "pipefail", "-c"]

# Every recipe sees the settings in config/app.env, with config/local.env over them for local
# overrides (never committed). Loading two files needs just's lists setting.
set unstable
set lists
set dotenv-path := ["config/app.env", "config/local.env"]

alias doctor := requirements
alias help := default

# The compose project, and the image tags, are named after this folder and where it is (a short
# hash of its full path), so every copy has its own containers, volumes and images, even two
# folders with the same name: generic_bank here is the project generic-bank-1a2b.
project := `d="$(pwd -P)"; n="$(basename "$d" | tr 'A-Z_' 'a-z-' | tr -cd 'a-z0-9-')"; echo "$n-$(printf '%s' "$d" | shasum | cut -c1-4)"`
export GB_PROJECT := project
export GB_IMAGE := "generic-bank/node:" + project
export GB_RUNNER_IMAGE := "generic-bank/runner:" + project

# Compose reads the same two files.
local_env := if path_exists("config/local.env") == "true" { "--env-file config/local.env" } else { "" }
compose := "docker compose -f infra/compose/compose.yaml --env-file config/app.env " + local_env + " -p " + project
scripts := "infra/scripts"

# Service groups, for up, down, logs and rebuild.
data := "postgres memory"
backend := "api"
console := "console"
crawlers := "runner"
bank := "bank-db bank-generic bank-example bank-inbox"
factory := "factory"

# A hash of everything that goes into the image. The image carries it as a label, so a stale
# image is noticed and rebuilt instead of quietly running yesterday's code.
source_stamp := `find apps packages infra/docker package.json package-lock.json tsconfig*.json -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.tsbuildinfo' -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 shasum | shasum | cut -c1-16`

# List every recipe
[group('Start here')]
default:
    @just --list --unsorted

# Check this Mac can build and run the stack (explicit versions); fails if not
[group('Start here')]
requirements:
    @{{scripts}}/requirements.sh

# The same, plus Node 26 for developing and running the tests
[private]
requirements-dev:
    @{{scripts}}/requirements.sh --dev

# Once, after cloning: check the Mac, create secrets, build the images
[group('Start here')]
setup: requirements tools secrets-init build env
    @echo; echo "Ready. Next: just up, then open http://localhost:$CONSOLE_PORT"; echo "Console sign-in: $CONSOLE_ADMIN_EMAIL, password: just console-password"
    @{{scripts}}/model-mode.sh

# To develop, in one go: Node 26, dependencies, Chromium, every CI check
[group('Start here')]
dev: dev-setup ci

# Once, to develop: Node dependencies, the Prisma client, Chromium for the tests
[private]
dev-setup: requirements-dev install browser

# Install Node dependencies and generate the Prisma client
[private]
install:
    @npm ci --no-audit --no-fund
    @npm run --silent db:generate

# Build the tools image (sops, age, jq, the plan renderer), if its Dockerfile changed
[private]
tools:
    @{{scripts}}/tool.sh true

# Create this machine's age key, .sops.yaml and the encrypted secrets files
[private]
secrets-init:
    @{{scripts}}/secrets-init.sh

# Write each service's env file into .run/env/ (only the secrets it needs); adds new secrets, never changes one
[private]
env: secrets-init
    @{{scripts}}/render-env.sh

# Edit secrets (in vi, in the tools image): just secrets-edit local|factory
[private]
secrets-edit file="local":
    @{{scripts}}/tool.sh sops config/{{file}}.secrets.enc.env

# Set one secret unseen; it asks for the value: just secret-set factory OPENROUTER_API_KEY [clipboard|path]
[group('Secrets (SOPS + age)')]
secret-set file key from="":
    @{{scripts}}/secret-set.sh "{{file}}" "{{key}}" "{{from}}"

# Show the Console's first admin password
[private]
console-password:
    @{{scripts}}/tool.sh sops decrypt --input-type dotenv --output-type dotenv config/local.secrets.enc.env | grep '^CONSOLE_ADMIN_PASSWORD=' | cut -d= -f2-

# Build the Node image every service runs, and the Runner's (the same plus headless Chromium)
[private]
build:
    @docker build -f infra/docker/node.Dockerfile --label gb.source={{source_stamp}} -t $GB_IMAGE .
    @docker build -f infra/docker/runner.Dockerfile --build-arg BASE=$GB_IMAGE --label gb.source={{source_stamp}} -t $GB_RUNNER_IMAGE .

# The same, from nothing: no cached layers
[private]
build-nc:
    @docker build --no-cache -f infra/docker/node.Dockerfile --label gb.source={{source_stamp}} -t $GB_IMAGE .
    @docker build --no-cache -f infra/docker/runner.Dockerfile --build-arg BASE=$GB_IMAGE --label gb.source={{source_stamp}} -t $GB_RUNNER_IMAGE .

# Build the image if it is missing or older than the source
[private]
image:
    @have="$(docker image inspect -f '{{{{ index .Config.Labels "gb.source" }}' $GB_RUNNER_IMAGE 2>/dev/null || true)"; \
      if [[ "$have" != "{{source_stamp}}" ]]; then echo "==> The image is out of date with the source; building"; just build; fi

# Start everything: data, memory, back end, console, crawlers, both banks, the factory
[group('Run')]
up: env image
    @just data
    @just backend console crawlers bank factory-up
    @just access
    @echo; echo "  Everything is in ACCESS.md. just show opens it all."
    @{{scripts}}/model-mode.sh

# Write ACCESS.html afresh and open it, then Swagger UI, the Console, both banks and the simulated inbox
[group('Run')]
show: access
    @open ACCESS.html 2>/dev/null || echo "  ACCESS.html"
    @for u in "http://localhost:$API_PORT/docs" "http://localhost:$CONSOLE_PORT" "http://localhost:$BANK_GENERIC_PORT/corelink/" \
        "http://localhost:$BANK_EXAMPLE_PORT/" "http://localhost:$BANK_INBOX_PORT"; do \
        open "$u" 2>/dev/null || echo "  $u"; done

# Stop everything (data is kept), or only some groups: just down console bank
[group('Run')]
down *groups:
    @if [[ -z "{{groups}}" ]]; then {{compose}} --profile '*' down --remove-orphans; \
      else {{compose}} --profile '*' rm -sf $(just _services {{groups}}); fi

# Show what is running and its health
[private]
ps:
    @{{compose}} --profile '*' ps --format 'table {{{{.Service}}\t{{{{.Status}}\t{{{{.Ports}}'

# Write ACCESS.md: links, logins, each bank's members, the demo in short (never committed)
[group('Run')]
access:
    @mkdir -p .run; : > .run/members.md; \
      for b in generic example; do \
        rows="$({{compose}} exec -T bank-db psql -U postgres -d bank_$b -At -c "SELECT '| \`' || m.number || '\` | ' || m.first_name || ' ' || m.last_name || CASE WHEN m.status = 'closed' THEN ' (closed)' ELSE '' END || ' | ' || string_agg(a.nickname || ' …' || right(a.number, 4), ', ' ORDER BY a.id) || ' |' FROM members m JOIN accounts a ON a.member_number = m.number GROUP BY m.number, m.first_name, m.last_name, m.status ORDER BY m.number" 2>/dev/null || true)"; \
        [[ -n "$rows" ]] || continue; \
        { [[ $b == generic ]] && echo "**Bank 1, Generic Bank**" || echo "**Bank 2, Example Credit Union**"; \
          echo; echo "| Member | Name | Accounts |"; echo "|---|---|---|"; echo "$rows"; echo; } >> .run/members.md; \
      done
    @{{scripts}}/access.sh

# A signed X-Hazards value for curl: just hazard-header late-rows,promo
[private]
hazard-header hazards:
    @{{scripts}}/hazard-header.sh "{{hazards}}"

# The data box: Postgres and Memory
[private]
data: env image
    @{{compose}} up -d --wait postgres
    @{{compose}} up -d --wait memory

# The app box's back end: the Task API (and its migrations)
[private]
backend: env image migrate
    @{{compose}} up -d --wait {{backend}}

# The admin console (AdminJS)
[private]
console: env image migrate
    @{{compose}} up -d --wait {{console}}

# The Runner, which drives the banks
[private]
crawlers: env image
    @{{compose}} up -d --wait {{crawlers}}

# Banks 1 and 2, the staff inbox and the banks' database
[private]
bank: env image
    @{{compose}} up -d --wait {{bank}}

# The factory box: the software factory (its models need OPENROUTER_API_KEY)
[private]
factory-up: env image
    @{{compose}} --profile factory up -d --wait {{factory}}

# The factory learns a bank (or repairs it), then the gate, under a hard limit (FACTORY_RUN_LIMIT_MINUTES, default 15): just factory example 40017732 1234 5678
[group('Factory')]
factory bank member from to: factory-up
    #!/usr/bin/env bash
    set -uo pipefail
    limit=$(( ${FACTORY_RUN_LIMIT_MINUTES:-15} * 60 ))
    name="gb-factory-run-$$"
    echo "  the run's hard limit: $(( limit / 60 )) minutes"
    ( sleep "$limit"; docker stop -t 5 "$name" >/dev/null 2>&1 && echo "  ✗ stopped at the run's hard limit of $(( limit / 60 )) minutes" ) &
    watchdog=$!
    disown "$watchdog"
    {{compose}} --profile factory-run run --rm --name "$name" factory-run {{bank}} {{member}} {{from}} {{to}}
    status=$?
    pkill -P "$watchdog" 2>/dev/null; kill "$watchdog" 2>/dev/null
    exit "$status"

# Bank 2's vendor redesign, which breaks its learned crawler on purpose: just redesign on (`just up` turns it off)
[group('Factory')]
redesign state:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{state}}" in on) v=1 ;; off) v=0 ;; *) echo "the state is on or off" >&2; exit 2 ;; esac
    printf 'services:\n  bank-example:\n    environment:\n      BANK_REDESIGN: "%s"\n' "$v" \
      | {{compose}} -f - up -d --no-deps --wait bank-example
    echo "  bank 2's redesign is {{state}}"

# A one-frame experiment: the real Scout or Supervisor on one kept frame of a run, a few cents a sample:
# just frame <run> <frame> <scout|supervisor> <samples> <variant.json> (the variant names the run's member and accounts)
[group('Factory')]
frame run frame role samples variant: factory-up
    #!/usr/bin/env bash
    set -euo pipefail
    mount=(); arg=()
    if [ -n "{{variant}}" ]; then
      dir="$(cd "$(dirname "{{variant}}")" && pwd)"
      mount=(-v "$dir:/tmp/variant:ro"); arg=("/tmp/variant/$(basename "{{variant}}")")
    fi
    {{compose}} --profile factory-run run --rm --no-deps ${mount[@]+"${mount[@]}"} --entrypoint node factory-run apps/factory/dist/frame.js {{run}} {{frame}} {{role}} {{samples}} ${arg[@]+"${arg[@]}"}

# Apply database migrations
[private]
migrate: env image
    @{{compose}} up -d --wait postgres
    @{{compose}} run --rm migrate

# Follow every service's logs, or only some groups': just logs crawlers
[private]
logs *groups:
    @{{compose}} --profile '*' logs -f --tail=100 {{ if groups == "" { "" } else { "$(just _services " + groups + ")" } }}

# Open psql on the control database
[private]
db-shell:
    @{{compose}} exec postgres psql -U postgres control

# An access token for curl (8 hours), from the local client just setup made
[private]
api-token:
    @{{compose}} exec -T api node -e "fetch('http://127.0.0.1:8000/oauth/token',{method:'POST',headers:{authorization:'Basic '+Buffer.from(process.env.API_LOCAL_CLIENT_ID+':'+process.env.API_LOCAL_CLIENT_SECRET).toString('base64')},body:new URLSearchParams({grant_type:'client_credentials'})}).then((r)=>r.json()).then((j)=>console.log(j.access_token))"

# The quick checks: typecheck, lint, tests, import boundaries, secrets
[group('Quality')]
check:
    @npm run --silent check
    @just secrets-scan

# The whole suite (what CI runs on every merge to master)
[group('Quality')]
test:
    @npx vitest run

# What GitHub's CI checks, here: schemas, types, lint, import boundaries, the whole suite, secrets
[private]
ci:
    @{{scripts}}/ci.sh

# Only the tests your uncommitted and unmerged changes touch
[private]
test-changed:
    @npx vitest run --changed origin/master --passWithNoTests

# The PII suite: a balance and a transfer on bank 1, then everything they wrote searched for seeded values
[private]
test-pii:
    @npx vitest run tests/pii

# TypeScript, every package
[private]
typecheck:
    @npx tsc -b --pretty

# ESLint and Prettier
[private]
lint:
    @npm run --silent lint

# Format everything with Prettier
[private]
format:
    @npx prettier --write . >/dev/null

# Import boundaries (dependency-cruiser)
[private]
boundaries:
    @npm run --silent depcruise

# Secrets (gitleaks, in its pinned image): the whole history and every uncommitted change
[private]
secrets-scan:
    @{{scripts}}/secrets-scan.sh

# Install Chromium for the browser tests (.run/browser)
[private]
browser:
    @{{scripts}}/browser.sh

# Start again from nothing: deletes every volume, rebuilds the images with no cache; asks first
[group('Housekeeping')]
[confirm('This deletes every database and object store volume, and rebuilds every image. Continue?')]
all:
    @rm -rf apps/*/dist packages/*/dist
    @find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
    @{{compose}} --profile '*' down -v --remove-orphans
    @just build-nc
    @echo "Rebuilt from nothing. Next: just up"

# Start the data again: stops the stack, deletes the databases, ledgers, evidence and sessions; keeps the images and memory models; asks first
[group('Housekeeping')]
[confirm('This deletes the control and memory databases, the bank ledgers, the evidence and the sessions. Continue?')]
reset:
    @{{compose}} --profile '*' down --remove-orphans
    @for v in postgres-data bank-db-data evidence sessions; do \
      n="{{project}}_$v"; if docker volume inspect "$n" >/dev/null 2>&1; then docker volume rm "$n" >/dev/null; fi; \
    done
    @echo "Data deleted; images and memory models kept. Next: just up"

# Each group's services, for down, logs and rebuild.
[private]
_services +groups:
    @for g in {{groups}}; do case "$g" in \
      data) echo -n "{{data}} " ;; backend) echo -n "{{backend}} " ;; console) echo -n "{{console}} " ;; \
      crawlers) echo -n "{{crawlers}} " ;; bank) echo -n "{{bank}} " ;; \
      factory) echo -n "{{factory}} " ;; *) echo "unknown group: $g (data, backend, console, crawlers, bank, factory)" >&2; exit 1 ;; \
      esac; done
