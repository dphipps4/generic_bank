# Generic Bank

This is a take-home implementation of an API for bank websites that have no API of their own. Your
AI agent, or any other program, calls it to check a balance, transfer money (only once a person
approves) or download statements, and a crawler does the work by operating the bank's staff screens
the way a person would. Behind it is a software factory where AI agents study a bank they haven't
seen, like bank 2, and write the crawler for it as plain deterministic code, so no model runs
when a customer's task does.

Everything runs locally with docker compose, and every step is a [just](https://just.systems) recipe.

## Requirements (macOS)

You need macOS 14 or newer, and an 8 GB Mac is enough. Install git to clone this, and
[Docker Desktop](https://www.docker.com/products/docker-desktop/) (Engine 27+, Compose 2.29+)
with 5.25 GB of memory set aside for it. To develop, add [Node 26](https://nodejs.org/en/download)
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
just up                         # everything: data, memory, API, Console, crawler, both banks, factory
just open                       # Swagger UI, the Console and the staff inbox, in the browser
just down                       # stop everything; the data stays
just help                       # every recipe, grouped, with what each does
```

`just setup` generates every secret it can. The only one it can't is the OpenRouter key, because
OpenRouter issues it. Run `just secret-set factory OPENROUTER_API_KEY` and paste the key when it
asks; what you paste stays hidden. The factory needs it: without it, every model call is refused.

Each factory role's model and effort are set in one place, `config/app.env`: `FACTORY_SCOUT_MODEL`
and `FACTORY_SUPERVISOR_MODEL`, `FACTORY_SCOUT_EFFORT` and `FACTORY_SUPERVISOR_EFFORT`.

`just up` starts everything: both banks, the staff inbox, the factory and memory. From there,
**[ACCESS.md](ACCESS.md)** lists every page, API and health check you can reach, the logins
(`just up` writes them to `secrets/credentials.txt`), and things to try, faults included.

Try a fault:

```sh
curl -i http://localhost:8082/             # HTTP/1.1 403 Forbidden ... Access denied
curl -i http://localhost:8081/corelink/    # HTTP/1.1 200 OK
```

Bank 2 turns away anything that doesn't look like a browser, the way a real bank's bot
screen does. Bank 1, the 2003 site, lets it through.

## Models

Only the software factory calls a model. The crawler that runs customer tasks never does. Every
factory call goes through a metering gateway, which holds spending to the caps ($25 a run, $150 a
rolling week).

| Role | What it does | Default model | Effort |
|---|---|---|---|
| Scout | Navigates the bank, one simple step at a time | `qwen/qwen3.8-max-prime` | low |
| Supervisor | Looks at every frame, reasons, directs the Scout, drafts the bank's profile | `qwen/qwen3.8-max-prime` | high |

The factory needs `OPENROUTER_API_KEY`. Without it, the factory still starts, but it refuses every
model call and names the missing key. Nothing stands in for the model.

Enter the key once (sops keeps it encrypted). It asks for the key, then `just factory`
restarts the factory with it:

```sh
just secret-set factory OPENROUTER_API_KEY
just factory
```

To change a role's model or effort, edit it in `config/app.env`, then run `just factory`:

```sh
FACTORY_SCOUT_MODEL=qwen/qwen3.8-flash
FACTORY_SCOUT_EFFORT=medium
```

Every model is reached through OpenRouter, with the one key. Any model in its catalog works, from
Qwen, Google, OpenAI and others, named as OpenRouter lists it, maker first. The caps price each one
from that catalog.

## A second copy, side by side

Clone or fork into another folder and run `just fork-ports` there before `just setup`. The copy
takes its folder's name and a short hash of where it is, so it gets its own containers, volumes and
images, even beside another folder of the same name. Its ports all move up by 10000 (its Console is
on http://localhost:18080).

## Develop

```sh
just dev
```

It installs Node 26, the dependencies and Chromium, runs everything GitHub's CI checks, then opens
the API reference in Chrome and serves it until Ctrl-C. Each step is a recipe of its own too;
`just help` lists them.

To start again from nothing, `just all` deletes every database and rebuilds every image. It asks
first. Then run `just up`.

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
- [The end-to-end test](docs/plan/end-to-end-test.md): a fresh clone through all three tasks,
  step by step, with what you should see at each.
- [The repair demo](docs/plan/manual_test.md): a bank redesigns, the crawler breaks, and the
  factory repairs it.
- [The build sheets](docs/build/): each milestone's pull requests, in order.
