# Prompts to build Generic Bank, in hindsight

If I were starting over from the brief alone, these are the prompts I'd use, cut to what the system needs. There are two parts with two sets of code. You should be able to walk a reviewer through each one and defend it.

| | [Part 1: bank 1, the arrow](bank1.md) | [Part 2: the factory, the loop](factory.md) |
|---|---|---|
| What it is | The brief's system: two banks, the runtime, bank 1's crawler, the API, safety | Your addition: learn a bank, and repair a crawler after a site changes |
| How it's made | Evidence, then prompts, then deterministic code. A person corrects it | The Scout acts, the Supervisor judges the evidence, memory keeps the lessons |
| Its code | `apps/bank`, `apps/api`, `apps/runner`, `apps/console`, the runtime, bank 1's crawler | `apps/factory`, `apps/memory` |
| What it reuses | | Part 1's runtime, the API's registry, the Console's inbox |
| Proved by | Bank 1 against the ledger | A repair of bank 1, then learning bank 2 |

Part 1 comes first. Part 2 waits until bank 1 is proven.

## What these replace

| The original prompts said | Now |
|---|---|
| Study the earlier project; borrow almost everything | Part 2 states what makes it work: a picture with every action, acting by position, a Supervisor that judges every action from the picture, one shared memory, lessons that cite evidence and retire, only visible nodes, the agent writing the crawler from what it sees, no glossary, no replay |
| Four banks: one built by hand, one generated, two learned live | Two: bank 1 by the arrow, bank 2 learned by the loop and held out |
| Every step needs evidence; frames on page load | Part 1, prompt 5 |
| The Scout navigates; the Supervisor recommends. Later: the Scout understands each page, the Supervisor validates the evidence | Part 2, prompts 3 and 4 |
| Statements, "if available and easy" | Cut: the brief asks for two tasks |
| The 45-minute PR; a suite run twice | Part 1, prompt 1: two jobs side by side, about a minute. The slowest PR job today is the 5-minute replay of a scripted run, which is cut |
| Let them fail, learn, and record memory | Part 2, prompt 7: the stop rule |

## Cut, because nothing needs them

- Banks 3 and 4.
- Download Statements.
- Our own browser plumbing.
- The profile word keys, the end-of-run draft and the glossary.
- Mock mode and the scripted recordings.
- The memory seed.
- MinIO.
- The hash-chained journal.
- The demo agent.
- The second copy of the stack.
- Secret rotation.
- The build sheets and most of the plan docs.
- About 48 of the 60 `just` recipes.
- Suites of hundreds of tests.
- Font, voice and canvas fingerprinting.
- OCR, Vault, Temporal, and a local certificate authority.
