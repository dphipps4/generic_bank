# The prompts that build Generic Bank

These are the prompts that build the system from the brief alone. There are two parts with two sets of code. You should be able to walk a reviewer through each one and defend it.

| | [Part 1: bank 1, the arrow](bank1.md) | [Part 2: the factory, the loop](factory.md) |
|---|---|---|
| What it is | The brief's system: two banks, the runtime, bank 1's crawler, the API, safety | Beyond the brief: learn a bank, and repair a crawler after a site changes |
| How it's made | Evidence, then prompts, then deterministic code. A person corrects it | The Scout acts, the Supervisor judges the evidence, memory keeps the lessons |
| Its code | `apps/bank`, `apps/api`, `apps/runner`, `apps/console`, the runtime, bank 1's crawler | `apps/factory`, `apps/memory` |
| What it reuses | | Part 1's runtime, the API's registry, the Console's inbox |
| Proved by | Bank 1 against the ledger | A repair of bank 1, then learning bank 2 |

Part 1 comes first. Part 2 waits until bank 1 is proven.
