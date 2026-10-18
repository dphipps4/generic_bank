# The factory: a walkthrough

Nobody wrote a crawler for bank 2. The factory writes one, and repairs it when bank 2 changes its site.

Two agents do the work on the live site. The Scout looks around, does each task once by hand, and then writes the crawler: plain code and data that do the task without any reasoning. The Supervisor watches every action through its picture and holds the crawler up against the evidence.

Once written, the crawler runs through the same task functions as [bank 1's](../packages/crawler/src/bank1.ts) table, with the guard on every action. So when a customer's task runs, no model is involved at all. A person approves each crawler before it serves.

Bank 1 keeps its own table, written by hand. The factory may learn bank 1 for practice, but that crawler is never recommended.

Read the files in this order.

## 1. The run: `apps/factory/src/run.ts` (361 lines)

A run starts from memory's knowledge pack. No pack, no run.

Then there's one piece of work. The Scout writes a crawler that covers the balance, a transfer up to its review (never sent), and the account's activity. Every part has to pass a try before the crawler counts as ready.

The whole run fits in 15 minutes, gate and lessons included, because the work stops 3½ minutes before the hard stop. Only a run where some part passed sends lessons to memory. A repair starts from the crawler that broke, and from where it broke, and changes only what moved.

**Decision:** the run is told a member and two of their accounts, as an API caller would be. **Not chosen:** letting the agents discover members, which would have them browse personal data for no reason.

## 2. The Scout's tools: `apps/factory/src/scout.ts` (615 lines)

Every browser tool hands back the page once the runtime calls it ready: the masked picture, the visible controls (each with an id and a box), and the visible words. The Scout acts on one control at a time, by its id or by a position it reads off the picture, and gives a one-line reason.

What gets typed is always the task's own value: the member, the amount, the memo. The server types the sign-in and a person's code, and the Scout never sees them.

A tool refuses only for safety or timing. Maybe the Supervisor said wait or stop, or a position lands on no control, or the action could send money or change an account. A tool never refuses what the Scout says about a page.

The Scout writes the crawler with three more tools:
- `write_crawler` keeps the whole crawler, once code has checked it can run safely: it acts only through `site`, holds none of the task's own values, and defines every part (`balance`, `transfer`, `review`, `history`, `name`, and the `send` control it never presses);
- `try_crawler` runs one part live with no model, in a page of its own and with the guard on, keeps a frame of each step, and says what code found: the task's account and an amount of money, a review holding the task's accounts, amount and memo, or the activity reached;
- `crawler_ready` says every part passed its latest try; the Supervisor checks the crawler once more before it counts.

The crawler's own `name` function says where the member's name shows, and from then on the name is hidden. Until it exists, a page showing the member's number isn't kept.

Every call is evidence: its input (masked), its result or its refusal, a close-up taken after it acted, and the Scout's own reasoning.

**Decision:** the agents write code and data, and trying it decides what's true. **Not chosen:** having the Scout fill in a fixed table format through tools that checked each description. Those tools refused most of what the Scout said.

## 3. The Supervisor: `apps/factory/src/supervisor.ts` (437 lines)

The Supervisor is the Scout's judge, coach and investigator. It never touches the browser, and it never writes the crawler.

After each action it sees the page that action led to, picture first, and gives a verdict before the Scout may act again: continue, wait, stop or end. Its other jobs:
- **The clock.** It gives close work more time, and ends a Scout that's going in circles.
- **The crawler.** When the Scout writes it, the Supervisor checks each step against the frames.
- **A failed try.** It reads the try's frames, says where it went wrong and why (as a hypothesis), and says what to change, in plain words.
- **Ready.** When the Scout says the crawler is ready, it checks it one more time and accepts it with stop.

Its words cite a frame, run to 700 characters at most, and reach the Scout whole. Code enforces the verdict. An unreadable answer counts as wait, and three in a row stop the run.

Each judgment starts fresh from one packet: the goal and its time, the last three judgments, what the Scout did since, the crawler and its tries when they changed, and the page now. `open_frame` reopens any frame of this run or an earlier one.

**Decision:** the Scout drives and the Supervisor judges. **Not chosen:** the Supervisor dictating each step, which is how the first factory worked. That doubled the model calls per action, and the Scout ended up following orders instead of looking at the page.

## 4. Memory's loop: `apps/factory/src/memory.ts` (490 lines) and `apps/memory`

Memory saves evidence, retrieves it, and writes new evidence. Every run is saved with its frames. Both agents get the same knowledge pack: lessons with the frames they cite, and recent attempts. At the end, the Supervisor turns what the run checked into lessons, each citing a frame of this run, and marks which served lessons were relied on or contradicted. A proposed lesson reaches the agents as untested, and a lesson about hidden values is refused: the factory hides them, not the site. Memory's rules decide what that means, with no model: one contradiction disputes a lesson, two retire it, and a promotion confirms it. A lesson says how a site works ("member search sits behind a link on the home page"), never what it calls things. Memory starts empty.

**Decision:** fixed rules over stored evidence decide what memory believes. **Not chosen:** a model judging its own lessons.

## 5. The gate: `apps/factory/src/gate.ts` (185 lines)

A crawler has to work before a person ever sees it. Code runs it live, from a browser that has never signed in, just like the service's first run will, with the guard on every action. It does the balance, a transfer up to its review, and the account's activity, and keeps a frame after every step. The review has to show the task's accounts, $1.00 and the memo. Then it all runs once more with the confirmation dialog forced.

- **Fails the plain run:** never shown to a person.
- **Breaks under the hazard:** kept as broken, and a repair case opens with that run's frames, just as a break in service would.
- **Passes both:** it waits in the Console, and approving promotes it. Nothing else promotes it.

**Decision:** one live check, one forced hazard, then a person. **Not chosen:** every hazard forced in turn, plus two clean probation runs.

## Changing an agent

A change to the Scout's or the Supervisor's instructions, tools or view is tested first on the frame where the old behavior failed: `just frame <run> <frame> <scout|supervisor> <samples> <variant.json>` gives that one kept frame to the real agent, through the factory's own code, a few cents and seconds a sample. A change merges when it beats the old behavior over five samples or more. A full run comes after, with a written hypothesis and a person's go, never as the experiment.

The Supervisor thinks briefly. It runs at low effort, and its whole output per judgment, thinking included, is capped as a backstop; one that runs past the cap is asked once more for its verdict alone. It says what is wrong and what to do next, never a tool's exact inputs: the Scout chooses those, and the tool checks them. Every judgment's packet and every view the Scout read are kept beside the run's frames, so any of them can be replayed; a judgment over 30 seconds is listed in the run's report.

## 6. The command: `apps/factory/src/cli.ts` (236 lines)

`just factory <bank> <member> <from> <to> [practice]` repairs if the bank has an open repair case, and learns it otherwise; then it runs the gate. It reports the run's cost, the actions judged and refused, the corrections that cite a frame, whether every action kept its frame and every refusal its input, and the lessons sent. For a bank whose table is written by hand it refuses, unless told `practice`: then the factory learns that bank from scratch, never shown its table, and the gate checks the crawler without recommending it.

## Around it

- **The model gateway** (`gateway.ts`, `upstream.ts`, `ledger.ts`): every model call goes through it. It meters each call, refuses one that would pass $25 a run or $150 a week before sending it, and keeps $1 of each run for the lessons.
- **The agent** (`agent.ts`): one pi session per role. Each role's provider, model and effort come from `config/app.env`, so the Scout and the Supervisor can run different models. The default for both is `qwen/qwen3.8-max-prime` through OpenRouter, which is strong on pictures and reasoning.
- **Tests with no model:**
  - [`tests/factory/scout.test.ts`](../tests/factory/scout.test.ts): scripted tools write bank 1's crawler, refuse an unsafe one, and try it with no model;
  - [`apps/factory/test/supervisor.test.ts`](../apps/factory/test/supervisor.test.ts): every judgment carries its picture, and an earlier frame opens;
  - [`tests/factory/gate.test.ts`](../tests/factory/gate.test.ts): a failing table never reaches a person.
