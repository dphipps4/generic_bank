# Generic Bank: every action is a make target. `make` alone lists them.
#
# The stack runs locally on docker compose. Secrets live in SOPS files under config/, encrypted
# to this machine's age key; `make env` renders one env file per service, each holding only the
# secrets that service may see (infra/secrets/scope.json).

SHELL := /bin/bash
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

include config/app.env
# A second copy of the stack (a fork in another folder) moves its ports in config/local.env, which
# is never committed: make fork-ports writes one.
-include config/local.env
export

# The compose project, and the image tags, are named after this folder, so a second copy has its
# own containers, volumes and images. This folder, generic_bank, is the project generic-bank.
export GB_PROJECT      := $(shell basename "$(CURDIR)" | tr 'A-Z_' 'a-z-' | tr -cd 'a-z0-9-')
export GB_IMAGE        := generic-bank/node:$(GB_PROJECT)
export GB_RUNNER_IMAGE := generic-bank/runner:$(GB_PROJECT)
LOCAL_ENV := $(if $(wildcard config/local.env),--env-file config/local.env)
COMPOSE   := docker compose -f infra/compose/compose.yaml --env-file config/app.env $(LOCAL_ENV) -p $(GB_PROJECT)
SCRIPTS   := infra/scripts

# Service groups. Each has its own up, -down, -logs and -rebuild targets.
DATA      := postgres vault minio memory
BACKEND   := api
CONSOLE   := console
CRAWLERS  := runner
BANK      := bank-db bank-generic bank-example bank-inbox
BANK_MORE := bank-sample bank-placeholder
FACTORY   := factory
ALL       := $(DATA) $(BACKEND) $(CONSOLE) $(CRAWLERS) $(BANK)

B := \033[1m
G := \033[32m
D := \033[2m
N := \033[0m

##@ Start here

help: ## List every target
	@awk 'BEGIN {FS = ":.*## "} \
	  /^##@/ { printf "\n$(B)%s$(N)\n", substr($$0, 5) } \
	  /^[a-zA-Z0-9_%-]+:.*## / { printf "  $(G)%-22s$(N) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo

requirements: ## Check this Mac can build and run the stack (explicit versions); fails if not
	@$(SCRIPTS)/requirements.sh

requirements-dev: ## The same, plus Node 22 for developing and running the tests
	@$(SCRIPTS)/requirements.sh --dev

doctor: requirements ## The same as make requirements

plan: plan-html ## Render the plan as HTML pages and open them
	@open .run/plan/GENERIC_BANK_PLAN.html 2>/dev/null || echo "  open .run/plan/GENERIC_BANK_PLAN.html in a browser"

plan-html: ## Render every document in docs/plan as an HTML page into .run/plan (in a container)
	@$(SCRIPTS)/tool.sh node infra/docs/render-plan.cjs

setup: requirements tools secrets-init build env ## Once, after git clone: check the Mac, create secrets, build the images
	@echo
	@printf '%b\n' "$(B)Ready.$(N) Next: $(G)make up$(N), then open http://localhost:$(CONSOLE_PORT)"
	@printf '%b\n' "Console sign-in: $(CONSOLE_ADMIN_EMAIL), password: $(G)make console-password$(N)"

dev-setup: requirements-dev install browser ## Once, to develop: Node dependencies, the Prisma client, Chromium for the tests

install: ## Install Node dependencies and generate the Prisma client
	@npm ci --no-audit --no-fund
	@npm run --silent db:generate

fork-ports: ## For a second copy in another folder: move every port by OFFSET (default 10000) in config/local.env
	@$(SCRIPTS)/fork-ports.sh "$(or $(OFFSET),10000)"

tools: ## Build the tools image (sops, age, jq, the plan renderer), if its Dockerfile changed
	@$(SCRIPTS)/tool.sh true

##@ Secrets (SOPS + age)

secrets-init: ## Create this machine's age key, .sops.yaml and the encrypted secrets files
	@$(SCRIPTS)/secrets-init.sh

env: ## Render one env file per service into .run/env/ (least privilege)
	@$(SCRIPTS)/render-env.sh

secrets-edit: ## Edit secrets (in vi, in the tools image): make secrets-edit FILE=local|ops|factory
	@$(SCRIPTS)/tool.sh sops config/$(or $(FILE),local).secrets.enc.env

secret-set: ## Set one secret unseen: make secret-set FILE=factory KEY=ANTHROPIC_API_KEY [FROM=path]
	@$(SCRIPTS)/secret-set.sh "$(FILE)" "$(KEY)" "$(FROM)"

secret-rotate: ## Rotate one generated secret: make secret-rotate FILE=local KEY=API_TOKEN_HASH_KEY
	@$(SCRIPTS)/secret-rotate.sh "$(FILE)" "$(KEY)"

secrets-keys: ## List the secret names in each file (never the values)
	@for f in local factory ops; do printf "%b\n" "$(B)$$f$(N)"; \
	  $(SCRIPTS)/tool.sh sops decrypt --input-type dotenv --output-type dotenv config/$$f.secrets.enc.env | cut -d= -f1 | sed 's/^/  /'; done

console-password: ## Show the Console's first admin password
	@$(SCRIPTS)/tool.sh sops decrypt --input-type dotenv --output-type dotenv config/local.secrets.enc.env \
	  | grep '^CONSOLE_ADMIN_PASSWORD=' | cut -d= -f2-

##@ Build

# A hash of everything that goes into the image. The image carries it as a label, so a stale
# image is noticed and rebuilt instead of quietly running yesterday's code.
SOURCE_STAMP = $(shell find apps packages infra/docker package.json package-lock.json tsconfig*.json \
  -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.tsbuildinfo' 2>/dev/null \
  | LC_ALL=C sort | xargs shasum | shasum | cut -c1-16)

build: ## Build the Node image every service runs, and the Runner's (the same plus headless Chromium)
	@docker build -f infra/docker/node.Dockerfile --label gb.source=$(SOURCE_STAMP) -t $(GB_IMAGE) .
	@docker build -f infra/docker/runner.Dockerfile --build-arg BASE=$(GB_IMAGE) --label gb.source=$(SOURCE_STAMP) -t $(GB_RUNNER_IMAGE) .

build-nc: ## Build the images from scratch (no cache)
	@docker build --no-cache -f infra/docker/node.Dockerfile --label gb.source=$(SOURCE_STAMP) -t $(GB_IMAGE) .
	@docker build --no-cache -f infra/docker/runner.Dockerfile --build-arg BASE=$(GB_IMAGE) --label gb.source=$(SOURCE_STAMP) -t $(GB_RUNNER_IMAGE) .

image: ## Build the image if it is missing or older than the source
	@have="$$(docker image inspect -f '{{ index .Config.Labels "gb.source" }}' $(GB_RUNNER_IMAGE) 2>/dev/null)"; \
	if [ "$$have" != "$(SOURCE_STAMP)" ]; then echo "==> The image is out of date with the source; building"; $(MAKE) --no-print-directory build; fi

##@ Run

up: env image ## Start the base stack: data, back end, console, crawlers, banks 1 and 2
	@$(MAKE) data
	@$(MAKE) backend console crawlers bank
	@$(MAKE) urls

down: ## Stop everything (data is kept)
	@$(COMPOSE) --profile '*' down

restart: down up ## Stop and start the base stack

ps: ## Show what is running and its health
	@$(COMPOSE) --profile '*' ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

urls: ## Print where everything is
	@echo
	@echo "  Console        http://localhost:$(CONSOLE_PORT)"
	@echo "  Task API       http://localhost:$(API_PORT)/healthz"
	@echo "  Generic Bank   http://localhost:$(BANK_GENERIC_PORT)/corelink/"
	@echo "  Example CU     http://localhost:$(BANK_EXAMPLE_PORT)/"
	@echo "  Staff inbox    http://localhost:$(BANK_INBOX_PORT)  (sign-in and approval codes)"
	@echo

data: env image ## Box B: Postgres, Vault, MinIO, Memory
	@$(COMPOSE) up -d --wait postgres vault minio
	@$(SCRIPTS)/vault.sh ensure
	@$(COMPOSE) up -d --wait memory

backend: env image migrate ## Box A back end: the Task API (and its migrations)
	@$(COMPOSE) up -d --wait $(BACKEND)

console: env image migrate ## The admin console (AdminJS)
	@$(COMPOSE) up -d --wait $(CONSOLE)

crawlers: env image ## The Runner, which drives the banks
	@$(COMPOSE) up -d --wait $(CRAWLERS)

bank: env image ## Banks 1 and 2 and their database
	@$(COMPOSE) up -d --wait $(BANK)

bank-more: env image ## Banks 3 and 4, kept for the factory to crawl later
	@$(COMPOSE) --profile more-banks up -d --wait $(BANK_MORE)
	@echo "  Sample Savings Bank   http://localhost:$(BANK_SAMPLE_PORT)/online/branch/"
	@echo "  Placeholder FCU       http://127.0.0.1:$(BANK_PLACEHOLDER_PORT)/cu/ib/"

factory: env image ## Box D: the software factory (mock mode until ANTHROPIC_API_KEY is set)
	@$(COMPOSE) --profile factory up -d --wait $(FACTORY)

migrate: env image ## Apply database migrations
	@$(COMPOSE) up -d --wait postgres
	@$(COMPOSE) run --rm migrate

%-down: ## Stop one group: make console-down, make bank-down, ...
	@$(COMPOSE) --profile '*' rm -sf $($(call group,$*))

%-logs: ## Follow one group's logs: make crawlers-logs, ...
	@$(COMPOSE) --profile '*' logs -f --tail=100 $($(call group,$*))

%-rebuild: ## Rebuild the image and restart one group: make backend-rebuild, ...
	@$(MAKE) build
	@$(COMPOSE) --profile '*' up -d --wait --force-recreate $($(call group,$*))

logs: ## Follow every service's logs
	@$(COMPOSE) --profile '*' logs -f --tail=50

vault-status: ## Show whether Vault is initialized and unsealed
	@$(SCRIPTS)/vault.sh status

db-shell: ## Open psql on the control database
	@$(COMPOSE) exec postgres psql -U postgres control

try: ## A task under forced hazards: make try HAZARD=late-rows [TASK=check-balance] [MEMBER=…] [ACCOUNT=…] [BANK_ID=generic]
	@$(COMPOSE) exec -T -e CONSOLE_PORT=$(CONSOLE_PORT) api node apps/api/dist/try-cli.js \
	  "$(TASK)" "$(HAZARD)" "$(MEMBER)" "$(ACCOUNT)" "$(BANK_ID)"

##@ Quality

check: ## Everything CI runs: typecheck, lint, tests, import boundaries, secrets
	@npm run --silent check
	@$(MAKE) secrets-scan

test: ## The whole suite (what CI runs on every merge to master)
	@npx vitest run

test-changed: ## Only the tests your uncommitted and unmerged changes touch
	@npx vitest run --changed origin/master --passWithNoTests

test-pii: ## The PII suite: every task on banks 1 and 2, then everything they wrote searched for seeded values
	@npx vitest run tests/pii

test-long: ## The long suite: runs that sit through the banks' real hazards for minutes
	@npx vitest run --config vitest.long.config.ts

typecheck: ## TypeScript, every package
	@npx tsc -b --pretty

lint: ## ESLint and Prettier
	@npm run --silent lint

format: ## Format everything with Prettier
	@npx prettier --write . >/dev/null

boundaries: ## Import boundaries (dependency-cruiser)
	@npm run --silent depcruise

secrets-scan: ## Secrets (gitleaks, in its pinned image): the whole history and every uncommitted change
	@$(SCRIPTS)/secrets-scan.sh

##@ Later milestones (named now so the plan and the Makefile agree)

demo evals check-prompts memory-seed memory-export memory-import export import trace observe docs: ## Not built yet: each says which milestone brings it
	@case "$@" in \
	  demo) m=M4 ;; evals) m=M7 ;; check-prompts) m=M9 ;; \
	  memory-seed|memory-export|memory-import) m=M6 ;; export|import) m=M6 ;; \
	  trace|observe) m=M5 ;; docs) m=M10 ;; esac; \
	echo "make $@ is not built yet: it arrives in milestone $$m."; exit 1

##@ Housekeeping

reset: ## Delete all local data (volumes) and start again from nothing. Asks first.
	@read -p "This deletes every database, Vault and object store volume. Type yes: " a; [ "$$a" = yes ]
	@$(COMPOSE) --profile '*' down -v

clean: ## Remove build output (dist, tsbuildinfo, .run)
	@rm -rf apps/*/dist packages/*/dist **/*.tsbuildinfo .run

.PHONY: help requirements requirements-dev plan plan-html setup dev-setup fork-ports tools doctor install secrets-init env secrets-edit secret-set secret-rotate secrets-keys \
  console-password build build-nc image up down restart ps urls data backend console crawlers bank \
  bank-more factory migrate logs vault-status db-shell check test test-changed test-pii test-long typecheck lint format boundaries secrets-scan \
  demo try evals check-prompts memory-seed memory-export memory-import export import trace observe \
  docs reset clean

# group name -> variable holding its services (data -> DATA, bank-more -> BANK_MORE)
group = $(shell echo $(1) | tr 'a-z-' 'A-Z_')

browser: ## Install headless Chromium for the browser tests (.run/browser)
	@infra/scripts/browser.sh

api-docs: ## Write the API reference from the contracts, serve it and open it in Chrome
	@npx tsc -b && node apps/api/dist/openapi-cli.js > docs/api/openapi.json && echo "  wrote docs/api/openapi.json"
	@node infra/scripts/serve-docs.mjs docs/api $(API_DOCS_PORT)

api-token: ## A fresh access token for Swagger UI or curl (15 minutes)
	@$(COMPOSE) exec -T api node apps/api/dist/token-cli.js

