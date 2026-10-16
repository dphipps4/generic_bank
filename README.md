# Generic Bank

This is a take-home implementation of an API for bank websites that have no API of their own. Your
AI agent, or any other program, calls it to check a balance, transfer money (only once a human
approves) or download statements, and a crawler does the work by operating the bank's staff screens
the way a person would. Behind it is a software factory where AI agents study a bank they haven't
seen, like banks 3 and 4, and write the crawler for it as plain deterministic code, so no model runs
when a customer's task does.

Everything runs locally with docker compose, and every step is a [just](https://just.systems) recipe.

## Requirements (macOS)

You need macOS 14 or newer, and an 8 GB Mac is enough. Install git to clone this, and
[Docker Desktop](https://www.docker.com/products/docker-desktop/) (Engine 27+, Compose 2.29+)
with 5 GB of memory set aside for it. To develop, add [Node 26](https://nodejs.org/en/download)
for the tests, the type checker and the linter.

```sh
infra/scripts/bootstrap.sh      # installs just, the pinned release, its checksum verified
just requirements               # checks all of the above, with versions, and fails until they are right
```

Already use Homebrew? `brew install just` and `brew install --cask docker` work just as well.

You don't need Xcode or Homebrew, and nothing else goes on the Mac. SOPS, age, jq, the plan
renderer, Postgres, MinIO and Chromium all run in containers.

## Read the plan

```sh
just plan                       # renders docs/plan as HTML pages and opens them
```

The pages land in `.run/plan/`. A container renders them, so this works before anything else is
set up.

## Run it

```sh
just setup                      # once, after git clone: checks the Mac, creates secrets, builds the images
just up                         # everything: data, memory, API, Console, crawler, all four banks, factory
just all                        # start again from nothing: deletes the data and rebuilds the images; then just up
just                            # every recipe
```

`just setup` generates every secret it can. The only ones it can't are the Claude and OpenAI API
keys, because someone else issues them. `just setup` explains them, and you enter one with
`just secret-set factory ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`). Both can stay blank; the
factory then runs in mock mode.

Each factory role's model is set in one place, `config/app.env`: `FACTORY_SCOUT_MODEL` and
`FACTORY_SUPERVISOR_MODEL`, `FACTORY_SCOUT_EFFORT` and `FACTORY_SUPERVISOR_EFFORT`, and
`FACTORY_SCOUT_PROVIDER` and `FACTORY_SUPERVISOR_PROVIDER` (`anthropic` or `openai`).

`just up` starts everything: all four banks, the staff inbox, the factory and memory. From there,
**[ACCESS.md](ACCESS.md)** lists every page, API and health check you can reach, the logins
(`just up` writes them to `secrets/credentials.txt`), and things to try, faults included.

Try a fault:

```sh
curl -i http://localhost:8082/             # HTTP/1.1 403 Forbidden ... Access denied
curl -i http://localhost:8081/corelink/    # HTTP/1.1 200 OK
```

Banks 2 to 4 turn away anything that doesn't look like a browser, the way a real bank's bot
screen does. Bank 1, the 2003 site, lets it through.

## Models

Only the software factory calls a model. The crawler that runs customer tasks never does. Every
factory call goes through a metering gateway, which holds spending to the caps ($25 a run, $150 a
rolling week).

| Role | What it does | Default model | Effort |
|---|---|---|---|
| Scout | Navigates the bank, one simple step at a time | `claude-sonnet-5-5` | low |
| Supervisor | Looks at every frame, reasons, directs the Scout, drafts the bank's profile | `claude-opus-5-5` | high |

With no API key, the factory runs in **mock mode**: recorded answers stand in for the model, so
nothing is sent to one and nothing is spent.

To use a key, enter it once (sops keeps it encrypted):

```sh
just secret-set factory ANTHROPIC_API_KEY
```

To change a role's model or effort, edit it in `config/app.env`, then run `just factory`:

```sh
FACTORY_SUPERVISOR_MODEL=claude-opus-5-5
FACTORY_SUPERVISOR_EFFORT=high
FACTORY_SCOUT_EFFORT=medium
```

The agents run on [pi](https://pi.dev), which talks to many providers, so switching provider is a
config change, not a code change. To run a role on OpenAI, enter the key, then name the provider
and model:

```sh
just secret-set factory OPENAI_API_KEY
```

```sh
FACTORY_SCOUT_PROVIDER=openai
FACTORY_SCOUT_MODEL=<an OpenAI model id>
```

Add the model's price to `apps/factory/src/models.ts` so the caps count it; a model with no price
there runs, but costs nothing on the meter.

## A second copy, side by side

Clone or fork into another folder and run `just fork-ports` there before `just setup`. The copy
takes its folder's name, so it gets its own containers, volumes and images. Its ports all move up
by 10000 (its Console is on http://localhost:18080).

## Develop

```sh
just requirements-dev           # just requirements, plus Node 26
just dev-setup                  # once: Node dependencies, the Prisma client, Chromium for the tests
just check                      # the quick checks: types, lint, tests, import boundaries, secrets
just ci                         # what GitHub's CI checks, on this machine; no Actions needed
just api-docs                   # write the API reference from the contracts and open it in Chrome
```

GitHub's CI is free for a public repository and its forks. If you don't have it, `just ci` runs
the same jobs on your machine.

## Documents

- [The plan](docs/plan/GENERIC_BANK_PLAN.md): what is built and why, Part 1 and Part 2, with
  appendices for every part of the system.
- [The requirements report](docs/plan/REQUIREMENTS.md): every point of the brief, how it is met,
  and the code and tests that prove it.
- [From 80% to 100%](docs/plan/80-to-100.md): what AI wrote, what we changed or threw away, and
  what running this unattended still needs.
- [The architecture](docs/plan/architecture.md): the boxes, the data, and where the risky parts
  live.
- [The technology choices](docs/plan/techstack.md): each tool, why it was chosen, and what it was
  chosen over.
- [The build sheets](docs/build/): each milestone's pull requests, in order.
