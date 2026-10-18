# The factory: a walkthrough

Nobody wrote a crawler for bank 2. The factory learns it, and repairs it when bank 2 changes its site. Two agents work on the live site: the Scout acts, writing the bank's table as it goes, and the Supervisor judges every action from its picture. What comes out is the same kind of table as [bank 1's](../packages/crawler/src/bank1.ts), run by the same loop, so no model is involved when a customer's task runs. A person approves each table before it serves. Bank 1 is never the factory's; its author fixes it.

Read the files in this order.

## 1. The run: `apps/factory/src/run.ts` (512 lines)

It starts from memory's knowledge pack; with no pack, there's no run. Then three goals in order: the balance, a transfer up to its review (never sent), and the account's activity. For each one, the Scout works the live site in one conversation, and the Supervisor judges each action. A goal not reached ends the run with the Supervisor's diagnosis. The whole run, gate and lessons included, fits in 15 minutes: each goal has 7, and every goal ends 3½ minutes before the hard stop. Lessons go to memory only from a run that reached a goal. A repair starts from the table that broke and where it broke, and changes only what moved.

**Decision:** the run is told a member and two of their accounts, as an API caller would be. **Not chosen:** letting the agents discover members, which would have them browse personal data for no reason.

## 2. The Scout's tools: `apps/factory/src/scout.ts` (1324 lines)

Every tool returns the page once the runtime calls it ready: the masked picture, the visible controls each with an id and a box, and the visible words. The Scout acts on one control at a time, by id or by a position read from the picture, with a one-line reason. **The runtime's own targeting must land on that same control**, or the action is refused and the Scout is told. A control with no name, or a name two controls share, is pressed by its position instead, with an anchor the crawler finds it by again. Typed values are always the task's (the member, the amount, the memo), and the server types the sign-in and a person's code unseen, so no step carries literal data. Words that could move money are never pressed.

As it goes, the Scout writes the table:
- `name_page` names a page by words it shows; code checks they're there and fit no other named page, and adds the other pages' words this one doesn't show. If every word of an earlier page also shows on this one, the earlier page gets one of this page's words as a word it never shows, and the Scout is told;
- code files each action under the page it was taken on;
- `note_answer` records the bank's own refusals;
- `note_trouble` records a page that gets in the way and goes away on its own, like a notice or a promotion. When the crawler sees it, it starts again from home;
- `note_read` records how a value is read. The Scout points at each value by the label before it, and the tool writes the pattern from the page's own lines. Before keeping it, the tool reads the live page with the crawler's own code and the task's accounts, so a read the gate would fail is refused, with the page's lines shown;
- `goal_reached` marks the goal's page; for a transfer, it names the send button by its id, never pressing it.

Every call is evidence: its input (masked), its result or its refusal, a close-up taken after it acted, and the Scout's own reasoning.


**Decision:** the Scout writes the table from actions it actually took, each checked in code. **Not chosen:** having a model draft a profile at the end from its memory of the run. That's what the first factory did, and its claims could be guesses that no action had proved.

**Reused from bank 1:** the runtime (`see`, `press`, `type`, `choose`, `field`, `control`), and the table format with its `readOf`.

## 3. The Supervisor: `apps/factory/src/supervisor.ts` (467 lines)

After each of the Scout's actions, it sees the page that action led to, picture first, and gives a verdict before the Scout may act again: continue, wait, stop or end. It cites a frame, and its words, at most 700 characters, go back to the Scout whole. Code enforces the verdict; an unreadable answer counts as wait, and three in a row stop the run. Each judgment starts fresh from one packet of the same size: the goal and its time, the route so far, its own last three judgments, what the Scout did since, and the page now. `open_frame` reopens any frame of this run or an earlier one, picture and all. When the goal is close, it can add time, never past the run's own end. When a goal isn't reached, it diagnoses from the frames where the run stopped and why.

**Decision:** the Scout drives and the Supervisor judges. **Not chosen:** the Supervisor dictating each step, which is how the first factory worked. That doubled the model calls per action, and the Scout ended up following orders instead of looking at the page.

## 4. Memory's loop: `apps/factory/src/memory.ts` (490 lines) and `apps/memory`

Memory saves evidence, retrieves it, and writes new evidence. Every run is saved with its frames. Both agents get the same knowledge pack: lessons with the frames they cite, and recent attempts. At the end, the Supervisor turns what the run checked into lessons, each citing a frame of this run, and marks which served lessons were relied on or contradicted. A proposed lesson reaches the agents as untested, and a lesson about hidden values is refused: the factory hides them, not the site. Memory's rules decide what that means, with no model: one contradiction disputes a lesson, two retire it, and a promotion confirms it. A lesson says how a site works ("member search sits behind a link on the home page"), never what it calls things. Memory starts empty.

**Decision:** fixed rules over stored evidence decide what memory believes. **Not chosen:** a model judging its own lessons.

## 5. The gate: `apps/factory/src/gate.ts` (148 lines)

A table must work before a person sees it. Code runs it live through the crawler's loop, starting from the run's own signed-in session: the balance, and a transfer up to its review, keeping a frame after every step. Then it runs once more with the confirmation dialog forced.

- **Fails the plain run:** never shown to a person.
- **Breaks under the hazard:** kept as broken, and a repair case opens with that run's frames, just as a break in service would.
- **Passes both:** it waits in the Console. The card shows each row beside the frame it cites, and approving promotes the table for both tasks. Nothing else promotes it.

**Decision:** one live check, one forced hazard, then a person. **Not chosen:** every hazard forced in turn, plus two clean probation runs. The loop that runs a learned table is the same one already tested against every hazard on bank 1.

## Changing an agent

A change to the Scout's or the Supervisor's instructions, tools or view is tested first on the frame where the old behavior failed: `just frame <run> <frame> <scout|supervisor> <samples> <variant.json>` gives that one kept frame to the real agent, through the factory's own code, a few cents and seconds a sample. A change merges when it beats the old behavior over five samples or more. A full run comes after, with a written hypothesis and a person's go, never as the experiment.

The Supervisor thinks briefly. It runs at low effort, and its whole output per judgment, thinking included, is capped as a backstop; one that runs past the cap is asked once more for its verdict alone. It says what is wrong and what to do next, never a tool's exact inputs: the Scout chooses those, and the tool checks them. Every judgment's packet and every view the Scout read are kept beside the run's frames, so any of them can be replayed; a judgment over 30 seconds is listed in the run's report.

## 6. The command: `apps/factory/src/cli.ts` (230 lines)

`just factory <bank> <member> <from> <to>` repairs if the bank has an open repair case, and learns it otherwise; then it runs the gate. It reports the run's cost, the actions judged and refused, the corrections that cite a frame, whether every action kept its frame and every refusal its input, and the lessons sent. It refuses a bank whose table is written by hand.

## Around it

- **The model gateway** (`gateway.ts`, `upstream.ts`, `ledger.ts`): every model call goes through it. It meters each call, refuses one that would pass $25 a run or $150 a week before sending it, and keeps $1 of each run for the lessons.
- **The agent** (`agent.ts`): one pi session per role. Each role's provider, model and effort come from `config/app.env`, so the Scout and the Supervisor can run different models. The default for both is `qwen/qwen3.8-max-prime` through OpenRouter, which is strong on pictures and reasoning.
- **Tests with no model:**
  - [`tests/factory/scout.test.ts`](../tests/factory/scout.test.ts): scripted tools write a table that reads bank 1's ledger, and a mismatched target is refused;
  - [`apps/factory/test/supervisor.test.ts`](../apps/factory/test/supervisor.test.ts): every judgment carries its picture, and an earlier frame opens;
  - [`tests/factory/gate.test.ts`](../tests/factory/gate.test.ts): a failing table never reaches a person.
