# Generic Bank on Replit

The whole stack runs in a single Replit app too, on the free plan, with no Docker. What compose runs as containers runs here as plain Node processes, side by side in one Replit Workflow. Replit's own Postgres holds our databases and the banks'.

## Start it

1. Make a Replit app from this repository with Replit's Import, from GitHub.
2. Bank 2's factory needs an OpenRouter key. Add it as a Replit Secret named `OPENROUTER_API_KEY` (Tools, then Secrets). Bank 1 doesn't need it.
3. Press **Run**. The first Run installs and builds; later Runs skip that. Once the banks are up, Replit's Preview pane shows the start page, Replit's `just show`: every address and login from `ACCESS.md`, each with a Copy button, and each link opening in a tab of its own.

From there the demos go just as [Demo 1](../../docs/demo-1.md) and [Demo 2](../../docs/demo-2.md) say, at the addresses in `ACCESS.md`. Bank 2's crawler gets built from the Shell while Run is going: `infra/replit/factory.sh example <member> <from> <to>`. `ACCESS.md` has the line filled in, ready to copy.

## What's different here

- **Addresses.** It all sits on the workspace's preview address. The start page is the address itself; the Console is at `:3003`, Swagger UI at `:8000/docs`, bank 1 at `:3002/corelink/`, bank 2 at `:3000`, the inbox at `:3001`. Only you can open them, and only signed in to Replit. The Console opens in a tab of its own for a reason: Replit refuses a sign-in from inside its Preview pane, because it wants an `X-Requested-With` header on a form sent from its frame. The runner, the factory, memory and the banks' admin APIs get no outside port at all.
- **Services.** [`.replit`](../../.replit) runs [`setup.sh`](setup.sh), then starts each service through [`service.sh`](service.sh). Replit gives every Secret to every process. That's why `service.sh` starts each service in a clean environment with only its own secrets, the way compose does, so the OpenRouter key reaches the factory and nothing else.
- **Secrets.** The first Run makes them, in SOPS files encrypted to the workspace's own age key in `.run/age/`. Nothing secret gets committed.
- **The database.** Replit's Postgres 16 with pgvector, instead of our two Postgres containers. [`render-env.sh`](../scripts/render-env.sh) lets its address win over the compose names.
- **The browser.** Replit's own Chromium, through `CHROME_PATH`. The banks keep their names, as `bank-generic.localhost` and `bank-example.localhost`; Chrome sends any `.localhost` name to this machine.
- **Node.** Replit's Node 24. The project asks for 26, but it builds and runs fine on 24.

## Slack

Link Slack to the app and the notifier posts to `#generic-bank` whenever something needs a person, a run fails, or a route waits for review. Each message links to the Console page where you act on it. Linking takes your Slack connection in Replit (Integrations) and attaching it to this app; the simplest way is asking Replit's Agent to attach it and change nothing else. The messages come from the Slack account you linked, and only the notifier ever sees that link. Without Slack linked, the notifier stops at start and everything else runs as before.

## What the free plan won't do

- **Storage.** 2 GiB per app. The build throws its own tools away afterward, like the Node image does, which leaves about 1.1 GB.
- **Time.** 1,200 workspace minutes a month.
- **Deployment.** None. The stack runs while the workspace is open; publishing it takes a paid plan.
