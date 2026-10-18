# The architecture

![The system](diagrams/system.svg)

## The boundaries, and why they sit there

- **The API knows no bank's UI.** A caller gives typed inputs (a bank, a member, an account) and gets a typed result. Which bank serves which task is the registry's answer (`GET /banks`), so a newly approved table appears there with no new endpoint.
- **The runner holds the browser, and nothing else does.** One durable run per task: its inputs are sealed in our own table, its steps and frames are recorded as it goes, and it settles exactly one result. A run that resumes after a crash starts a fresh browser and signs in again; a transfer resumes from what it wrote down, never from memory.
- **The crawler knows a bank only by its table.** The loop is the same for every bank, and a bank is data: its pages, their words, and what a teller does there. An import rule keeps the crawler from the bank's code, and the runtime from everything but the browser.
- **No model runs a customer's task.** Models only ever work in the factory, behind a metering gateway, and all they produce is a table. A person approves it before it serves.
- **People act through the Console, and the Console only.** Codes, approvals, takeovers, freezes and learned tables are all decided there, and each decision is also an API call, so the tests take the same path a person does.

## The data

All of it lives in one Postgres database, with migrations in [`packages/db`](../packages/db/prisma/schema.prisma). The pictures go on a shared volume.

- **A task run** (`TaskRun`): its inputs, sealed; its status and result; its steps (`Step`), one per page the crawler saw; and its frames (`TrailFrame`), each a masked picture with the page's visible tree and controls.
- **A person's part** (`HumanTask`): a code to enter, a transfer to approve, or a stopped run to take over. Each has a deadline, and a person's answer is sealed until the run reads it. An approval issues one `ApprovalGrant`, which the single press of Submit spends.
- **The registry** (`Driver`, `DriverVersion`, `RegistryEvent`): which version of a bank's crawler serves each task. A learned version holds its table; a fault demotes it, and a `RepairCase` opens. A guard trip freezes the bank (`Freeze`) until a person clears it.
- **The factory** (`FactoryRun`, `ModelCall`, `Recommendation`): each run, each model call with its cost, and the table waiting for a person, with the gate's runs beside it.
- **Memory**, a service of its own: runs and attempts with their frames, lessons citing those frames, and the facts a promotion proves.
- **The API's own security** (`ApiClient`, `TokenFamily`, `ApiToken`): OAuth2 client credentials and rotating refresh tokens. Only hashes are stored.

## Where the risky parts live

- **The press that moves money.** It's never in a table row, and it's pressed once, only under a grant a person's approval issued, which binds the values the review page showed. Its intent is written to the trail before the press, so a run that stops after it reads the account's history and never presses again ([`transfer.ts`](../apps/runner/src/transfer.ts)).
- **Every other action.** Each passes the job's allowlist before it reaches the browser, judged by the page's name in the table and the control's drawn name, and never by anything the page says. Words that change an account ("Close account", "Waive fee") are refused on every page ([`allowlist.ts`](../packages/guardrails/src/allowlist.ts)).
- **Personal data.** The runtime paints every number, amount, name and secret out of the picture, the page text and the address before a frame is kept ([`mask.ts`](../packages/runtime/src/mask.ts)). It learns the member's name the first time the bank shows it, and masks it from then on. The model sees only masked frames.
- **Unknown pages.** Nothing guesses at a page no row knows. The run stops as 409 with its frames, the version comes out of service, and a person decides what happens next.
- **Model spend.** The gateway refuses a call that would pass $25 a run or $150 a week before it is sent.
