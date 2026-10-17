# The overhaul: two banks, very clean

This cuts the whole system down to what the brief needs, and keeps the factory.

- **Bank 1, the arrow:** built deterministically. Evidence from the live bank is turned into prompts, and the prompts into code.
- **Bank 2, the loop:** learned by the factory.
- **The test for the result:** you can walk a reviewer through either part and defend it with the code open. Each says plainly how it was made, and each is quick to change.

The prompts that drive it are in [docs/prompts](../prompts/README.md).

## The target

**Bank 1, the arrow.** The brief's core. Its crawler is written by hand from captured pages, never from the bank's source. It runs on a small runtime that sees the page first, then clicks the rendered control.

- **Tasks:** check balance and transfer funds.
- **Covers:** every outcome, escalation and safety.
- **Hazards (3% of runs):** handled in deterministic code: retries, waits, known dialogs, and the bank's own words matched by pattern.

**Bank 2, the loop.** The factory learns it, and nobody tunes anything against it before its one live run. The factory is developed on bank 1's repair after a redesign, and learns check balance and transfer only.

**Everything else goes,** unless the brief needs it or we chose it on purpose. Those that stay: OAuth2, the Mac fingerprint, durable runs for approvals, the inbox, and memory.

## Keep and cut

| Part | Decision | Why |
|---|---|---|
| Banks 3 and 4: two containers, their profiles, their quirk code and tests | Cut | Two banks cover the brief and the factory |
| Bank 2's hand-written profile, and its promotion | Cut | Bank 2 is the factory's to learn |
| `packages/screen` (2,672 lines) and the CoreLink profile driver (1,710) | Replaced | By a small runtime on Playwright, with bank 1's crawler, if the spike holds |
| Download Statements, the task | Cut | The brief asks for two tasks. The bank keeps its statements pages |
| Mock mode, the scripted recordings, and the CI job that replays them | Cut | They read the bank's config, and passed off a script as a model |
| The factory's word keys, end-of-run draft, substring check and glossary | Cut | Replaced by steps written from actions |
| The hash-chained journal, the demo agent, the fork-ports copy, secret rotation | Cut | Not asked for |
| The memory seed | Cut | No run relied on it, and it cites no frames of ours. Memory starts empty |
| MinIO | Cut | Pictures go on a shared volume |
| The memory service | Keep | The loop's core |
| OAuth2, Swagger UI, `GET /banks`, `GET /tools` | Keep | The typed API |
| Durable runs, the inbox, the allowlist, single-use grants, masking | Keep | Escalation and safety |
| The Mac fingerprint, bank 2's bot screen, pictures of drawn text | Keep | Bank 2 needs them |
| The redesign switch | Keep | The repair demonstration |
| Hazards | Keep, trimmed | The brief's named ones, plus slowness, the 503, the interstitial and the record in use |
| The Console | Keep, trimmed | The inbox, runs with frames, approving a learned crawler, and the dashboard |
| Plan docs and build sheets (24,737 words) | Folded | A two-page README, architecture, 80 to 100, the guide, and two walkthroughs |
| `just` recipes (about 60) | About 12 | `requirements`, `setup`, `up`, `down`, `all`, `open`, `try`, `test`, `check`, `onboard`, `repair`, `help` |

## Tests

**On a pull request, about a minute.** Two jobs run side by side:
- typecheck, lint and gitleaks on the diff;
- the unit tests of the packages touched.

One browser test runs only when the runtime, a crawler or a bank changed. Nothing replays a recorded run, and images are built on master only. A docs-only change runs nothing, and a newer push cancels the older run.

**On master, under 15 minutes, in parallel:**
- the outcome table on bank 1, one hazard at a time;
- the transfer through approval and a single Submit;
- the PII search;
- the factory's tests, with no model.

Long waits run only when asked for.

## The order

1. **A spike, thrown away, about an hour.** It checks Playwright on bank 1's frameset, submit styles, hidden controls, a covered control, masking and dialogs. On bank 2 it checks the second origin, the pictures of text and the bot screen. Exit: a report with a picture for each point. If a point fails, it's decided with a person: fix it, or cut down our own reader instead.
2. **The cut.** Everything marked cut, except the old bank 1 path. Exit: CI green, and a PR check of about a minute, as measured.
3. **Bank 1, by the arrow.** Walk bank 1 and keep every page. Write claims that cite frames, then the crawler from the claims, on the small runtime. Prove it against the ledger, then retire the old path. Exit: the kept tests pass, and a test fails if a word in the crawler isn't in a cited frame, or if the crawler imports the bank's code.
4. **The loop, with no model calls.**
   - The Scout sees first, then clicks, and writes steps from what it did.
   - The Supervisor works in one conversation per run, can reopen any frame, judges and corrects from the picture, and diagnoses failures.
   - Claims become lessons with frames.
   - The gate runs a live check before a person approves.

   Exit: CI green.
5. **Live, one run, after a person's go: repair bank 1 after its redesign.** It's capped at $10. Exit: promoted, or a report.
6. **Live, one run, after a person's go: learn bank 2.** It's capped at $10. Exit: promoted, or a report. The fallback is bank 2 built by the arrow, labelled as such.
7. **Docs.**
   - The README, the architecture and the guide.
   - Two walkthroughs, one for each set of code: each file in reading order, with its line count, what it does, and the decision behind it next to the alternative not chosen.

## Rules

- **Live runs:** after each one, report from its own evidence, record it, and stop. Never read a run to supply its answer, and never steer with prompts or the bank.
- **Pull requests:** small, one worktree each, squashed. Docs pull requests run no tests.
- **Claims in a doc:** each says how it's known.
