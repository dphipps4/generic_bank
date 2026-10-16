# Generic Bank

This is a take-home implementation of an API for bank websites that have no API of their own: an
AI agent calls it to check a balance, transfer money (only once a person approves) or download
statements, and a crawler does the work by operating the bank's staff screens the way a person
would. Behind it is a software factory where AI agents study a bank they haven't seen, like banks
3 and 4, and write the crawler for it as plain deterministic code, so no model runs when a
customer's task does.

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
make up                         # everything: data, memory, API, Console, crawler, all four banks, factory
make help                       # every target
```

`make setup` generates every secret it can. A value someone else issues (today only the Claude
and OpenAI API keys, which may stay blank: the factory then runs in mock mode) is explained by
`make setup` and entered with `make secrets-edit FILE=…`, which opens the encrypted file in sops.

Each factory role's model is set in `config/app.env`: `FACTORY_SCOUT_MODEL` and
`FACTORY_SUPERVISOR_MODEL` (default `claude-opus-5-5`), `FACTORY_SCOUT_EFFORT` and
`FACTORY_SUPERVISOR_EFFORT` (default `low` and `high`), and `FACTORY_SCOUT_PROVIDER` and
`FACTORY_SUPERVISOR_PROVIDER` (default `anthropic`; `openai` is the other). A model with no
price in `apps/factory/src/models.ts` is refused.

`make up` starts everything there is: all four banks, the staff inbox, the factory and memory
included. Then **[ACCESS.md](ACCESS.md)** lists every page, API and health check you can reach,
the logins (which `make up` writes to `secrets/credentials.txt`), and things to try, faults
included.

Try a fault:

```sh
curl -i http://localhost:8082/             # HTTP/1.1 403 Forbidden ... Access denied
curl -i http://localhost:8081/corelink/    # HTTP/1.1 200 OK
```

Banks 2 to 4 turn away anything not shaped like a browser, as a real bank's bot screen does.
Bank 1, the 2003 site, does not.

## A second copy, side by side

Clone or fork into another folder and run `make fork-ports` there before `make setup`. The copy
is named after its folder, so it gets its own containers, volumes and images, and its ports are
all moved up by 10000 (its Console is on http://localhost:18080).

## Develop

```sh
make requirements-dev           # make requirements, plus Node 22
make dev-setup                  # once: Node dependencies, the Prisma client, Chromium for the tests
make check                      # the quick checks: types, lint, tests, import boundaries, secrets
make ci                         # everything GitHub's CI runs, on this machine (slow); no Actions needed
make api-docs                   # write the API reference from the contracts and open it in Chrome
```

CI on GitHub costs nothing for a public repository or its forks, and `make ci` runs the same
jobs locally for anyone without it.

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
