# Generic Bank

A typed API that an AI agent calls to check balances, download statements and request
transfers at legacy banks that have no API. The system does the work by operating each bank's
website the way a person would, hands the work to a person when it cannot proceed safely, and
never moves money without a person's approval. A software factory learns each new bank.

Everything runs locally with docker compose, and every step is a make target.

## Requirements (macOS)

macOS 14 or newer; an 8 GB Mac is enough.

```sh
xcode-select --install          # git and make
brew install --cask docker      # Docker Desktop (Engine 27+, Compose 2.29+); give it 5 GB of memory
brew install node@22            # only to develop: the tests, the type checker and the linter
make requirements               # checks all of the above, with versions, and fails until they are right
```

Nothing else is installed on the Mac. SOPS, age, jq, the plan renderer, Postgres, Vault, MinIO
and Chromium all run in containers.

## Read the plan

```sh
make plan                       # renders docs/plan as HTML pages and opens them
```

The pages are written to `.run/plan/`, rendered in a container, so this works before anything
else is set up.

## Run it

```sh
make setup                      # once, after git clone: checks the Mac, creates secrets, builds the images
make up                         # the data box, the API, the Console, the crawler and two banks
make help                       # every target
```

`make setup` generates every secret it can. A value someone else issues (today only the Claude
API key, which may stay blank: the factory then runs in mock mode) is explained by `make setup`
and entered with `make secrets-edit FILE=…`, which opens the encrypted file in sops.

Then open the Console at http://localhost:8080 (sign in as `admin@generic-bank.local`; the
password is printed by `make console-password`).

Try a fault:

```sh
curl -i http://localhost:8082/             # HTTP/1.1 403 Forbidden ... Access denied
curl -i http://localhost:8081/corelink/    # HTTP/1.1 200 OK
```

Banks 2 to 4 turn away anything not shaped like a browser, as a real bank's bot screen does.
Bank 1, the 2003 site, does not.

## Models

Only the software factory and the demo agent call a model; the crawler that runs customer tasks
never does. The factory's calls all go through its metering gateway, which enforces the spend
caps ($25 a run, $150 a rolling week) and refuses a model it has no price for.

| Role | What it does | Default model | Effort |
|---|---|---|---|
| Scout | Navigates the bank, one simple step at a time | `claude-opus-5-5` | low |
| Supervisor | Looks at every frame, reasons, directs the Scout, drafts the bank's profile | `claude-opus-5-5` | high |
| Demo agent | A member assistant whose only tools are the Task API's | `claude-opus-5-5` | default |

With no API key, the factory and the demo agent run in **mock mode**: recorded or scripted
answers stand in for the model, nothing reaches a model, and nothing is spent.

To use a key, enter it once (it is stored encrypted with sops):

```sh
make secret-set FILE=factory KEY=ANTHROPIC_API_KEY
```

To change a role's model or effort, set it in `config/local.env` (not committed), then
`make factory`:

```sh
FACTORY_SUPERVISOR_MODEL=claude-opus-5-5
FACTORY_SUPERVISOR_EFFORT=high
FACTORY_SCOUT_EFFORT=medium
```

The agents run on [pi](https://pi.dev), which talks to many providers, so another provider is
configuration, not code. To run a role on OpenAI, enter its key and name the provider and model:

```sh
make secret-set FILE=factory KEY=OPENAI_API_KEY
```

```sh
FACTORY_SCOUT_PROVIDER=openai
FACTORY_SCOUT_MODEL=<an OpenAI model id>
```

Add the model's price to `apps/factory/src/models.ts` first: the gateway refuses any model it
cannot meter.

## A second copy, side by side

Clone or fork into another folder and run `make fork-ports` there before `make setup`. The copy
is named after its folder, so it gets its own containers, volumes and images, and its ports are
all moved up by 10000 (its Console is on http://localhost:18080).

## Develop

```sh
make requirements-dev           # make requirements, plus Node 22
make dev-setup                  # once: Node dependencies, the Prisma client, Chromium for the tests
make check                      # everything CI runs: types, lint, tests, import boundaries
make api-docs                   # write the API reference from the contracts and open it in Chrome
```

## Documents

- [The plan](docs/plan/GENERIC_BANK_PLAN.md): what is built and why, Part 1 and Part 2, with
  appendices for every part of the system.
- [The requirements report](docs/plan/REQUIREMENTS.md): every point of the brief, how it is met,
  and the code and tests that prove it.
- [The architecture](docs/plan/architecture.md): the boxes, the data, and where the risky parts
  live.
- [The technology choices](docs/plan/techstack.md): each tool, why it was chosen, and what it was
  chosen over.
- [The build sheets](docs/build/): each milestone's pull requests, in order.
