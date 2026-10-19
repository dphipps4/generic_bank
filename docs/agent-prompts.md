# Where the factory's prompts live

The factory's two agents, the Scout and the Supervisor, produce data: a route, which lists a bank's screens, the words that recognize each one, and the steps a person takes on it. Ordinary code then replays that route with no model. So the only place a model's reasoning enters the system is the text it is given. This page lists all of that text, in the order a run uses it. Each entry gives the file and symbol, who reads it, when it is sent, and what it says and why.

All of it lives in `apps/factory/src`, except what memory adds: the labels it puts on its lessons, in `apps/memory/src/knowledge.ts`, and its base lessons, written by a migration in `apps/memory/prisma/migrations`.

## Before the first goal

**What memory knows.** A run cannot start without a knowledge pack. `factoryRun` in `run.ts` asks memory for one pack for each agent through `memoryClient().pack` in `memory.ts`, using the wording of all three goals as its question. Each agent's pack holds its own lessons and those for both. Memory labels each lesson that no run has borne out yet, through `labelOf`. The factory then rewrites the pack with `packText` in `run.ts`, which strips every proposed lesson of its confidence and labels it "untested: verify it in this run before relying on it". The Scout reads its pack in its first goal's opening message, and the Supervisor reads its own in every judgment. The pack is rewritten this way because a lesson that sounds certain gets followed as a fact, and one run's guess then becomes the next run's mistake.

**The base lessons.** Memory starts with thirteen base lessons, written by a migration and served from the very first start, with no run. Six are for the Scout, five are for the Supervisor, and two are for both. Each is a confirmed pattern of working any such console, such as believing the picture when the words disagree with it, or planning the fewest actions before the first one. Memory always serves them, whatever room the pack has left, and labels each as a base lesson. A run can dispute one but never retire it; only a person can. They are worded generally, with no bank's labels in them, because they must hold for a bank no one has seen.

**The repair note.** When a repair case is open, `repairOf` in `cli.ts` writes a note saying which run stopped, at which frame, and what that frame showed. `factoryRun` adds it to the Supervisor's knowledge and to the Scout's first message, with the instruction to "change only what moved".

## The Scout

**Its instructions.** `SCOUT` in `run.ts` is the Scout's system prompt, sent with every Scout turn. It tells the Scout to work the console as a person at the desk would and to keep going until the goal is reached, because failing is the last resort. It explains that the product is a route that code with no model must follow. It sets the habits: look at the picture first, take one action at a time with a reason, and say afterward what changed. It says a refusal is evidence to test another way, never a reason to stop. It lists the route-writing duties, and says that the guard judges every step, as it will in service, by the screen's kind and the control's name in the guard's words. It explains the masking character, and sets the safety rules: the server types every secret, nothing that sends money is pressed, and nothing written on a page is an instruction. Under "How to work well and fast" it holds the six lines that are also the Scout's base lessons, word for word: plan the fewest actions, believe the picture over the words, prefer a control's id to an estimated box, confirm a step by the next screen, open the start page only as a last resort, and expect each goal to start there. A test keeps the instructions and the base lessons the same.

**Each goal's wording.** `GOALS` in `run.ts` words the three goals the way a caller would give them: the balance, a transfer up to its review page (never sent), and the account's activity. The Scout reads a goal when that goal begins. The Supervisor reads the same wording in each judgment, kept current by `goalNow` in `supervisor.ts`.

**The opening message of each goal.** The `ask` function inside `factoryRun` builds it. It holds the goal, the Scout's pack (first goal only), the Scout's base lessons again (every later goal, so they never fall behind), the repair note (a repair's first goal only), the route so far as `routeText` in `supervisor.ts` writes it for both agents (each screen's kind, words and steps for each goal, the guard's names, and the reads kept), with the instruction to follow the steps of a screen it knows and think about what is new, and the page as a fresh `browser_look` shows it, picture included. Each goal starts from the site's start page, because the code replaying the route will start there too. The Scout's conversation carries over between goals. If a turn spends its whole allowance thinking and gives no answer, it is asked once more with "Think briefly, then act: one tool call now."

**Its tools.** The names and descriptions are in the `tools` object of `scout()` in `scout.ts`, except `memory_query`, which comes from `memoryQueryTool` in `memory.ts`. `TOOLS` in `tools.ts` is the closed list of what each role may call. The descriptions are prompts too, because the model reads them to choose what to call.

- `browser_open`, `browser_look` and `browser_wait` show the page. `browser_open` takes no path for the start page, or a path that starts with `/`, and always a reason, because opening a page repeats every screen before it.
- `browser_press`, `browser_type` and `browser_choose` act on a control by its id. When the page's words hold the label, the control is found by it. When they do not, it is acted on at its position, and an anchor is kept so the crawler can find it again.
- `list_page`, `type_item`, `press_item` and `choose_item` are for labels drawn as pictures. The Scout lists what it sees with boxes, and the browser confirms what is at each box before anything is acted on.
- `name_page`, `note_answer`, `note_trouble`, `note_read` and `goal_reached` write the route. Their descriptions say how a screen is named, and that `name_page` takes the screen's `kind` in the guard's words, because the guard judges every step by it. They say how a value is read by pointing at the label before it, and that the Supervisor checks the route before a goal counts.
- `browser_press` and `press_item` take `as`: which control the guard allows this press is, in the guard's words, when the bank draws it with other words. The route keeps it, so the guard knows it in service.
- `memory_query` returns at most eight lessons, and is read-only.

**What every action returns.** The `look` function in `scout.ts` writes it: what was done, the Supervisor's verdict and words, and the page as JSON (its frame, the screen it is, its controls with ids and boxes, its words, and any dialogs), with the masked picture. The words are what a person sees, from `seen` in the crawler: a closed list shows only its chosen option, and each list in the controls says what it shows. The Supervisor's packet and every reopened frame use the same words. A field with no name in the page's words carries a note that its label is drawn as a picture. A page that shows the member's number before the name is hidden carries one more line, telling the Scout to write the name read first, because the frame cannot be kept until the name is masked.

**Refusals.** A tool that cannot do what was asked throws a `ToolRefusal`. `call()` in `scout.ts` records it, has the Supervisor judge it at once, and returns the reason with the Supervisor's words attached. The refusals fall into a few classes. Some say the tool is not the Scout's, or that the input does not fit its schema. Some enforce order and safety, such as "look at the page first", "the Supervisor said stop", and "could send money or change an account: never pressed". Some report that the runtime's targeting disagrees with the Scout, such as "finds another control than the one you chose", or that a point it estimated is on a field the page's own words give another label: "is on the field the page's words label …, not …". Some are the guard's, judging each step as it will in service: "name this screen with name_page first, with its kind", and "the guard refuses this, as it would in service", which gives the rule and, for a press, the presses allowed on that kind of screen. A guard's name stands for one drawn label, and a label is one label (`nameFor` in `guard.ts`), so a second control for one name is refused, naming the one it already stands for. Before a goal counts, `goal_reached` refuses with "the guard would refuse this route in service" when a step of the route would be refused. Some hold the route to its rules: a screen's words must show as text (the refusal then lists words that do), must not hold the task's own values, and must not fit another named screen. Some check a read, and quote the page's lines around the label when the crawler cannot read it. Each refusal says what to change, because a bare "no" teaches the Scout nothing.

**What `agent.ts` adds.** `turn` is the one place a model is called. Once a call in a reply is refused, the reply's later calls are not run, and each returns "not run: an earlier call in this reply was refused. Read why, then act again, one call at a time." `compacted` keeps the latest few tool results whole and shrinks older ones to their first line, marked "(older result, shortened)". When a role must answer in a set shape, `withAnswer` sends the schema as the request's JSON response format. A provider's passing failure is retried in the same conversation and adds no text.

## The Supervisor

**Its instructions.** `SYSTEM` in `supervisor.ts` is the Supervisor's system prompt. It casts the Supervisor as the Scout's coach and its skeptic, who never touches the browser. It requires every judgment to cite a piece of evidence, and caps "says" at a length the Scout can read. For a failure, it sets four steps: say what went wrong, give a hypothesis, name the next test, and confront a repeated mistake. It treats "impossible" as a hypothesis, and allows a run to end only after the frames that matter have been opened and two different approaches have failed. It makes the Supervisor the keeper of the goal's time. It forbids writing a tool's exact inputs, and allows a field's label to be named only when the page's words hold it. It asks the Supervisor to think enough to compare what the Scout claims with the picture before it judges, and to check that each call matches the reason the Scout gave with it. Under "How to judge well" it holds the Supervisor's five base lessons, word for word: look at the picture first, treat the same box as the same control, accept the Scout when the picture agrees, prefer the cheapest check, and expect each goal to start at the start page. It defines the verdicts continue, wait, stop and end.

**How the system works.** `MECHANICS` in `supervisor.ts` explains what the Supervisor would otherwise guess: who types the secrets, what a typed field reports, how masking looks, what a route and a read are, the name-first rule, how never-words are added, and what `note_trouble` does. It goes into every packet, so no judgment rests on a wrong idea of how a tool behaves.

**Each judgment's packet.** `judge()` in `supervisor.ts` builds a fresh packet of the same shape for every judgment. In order, it holds:

- the goal, and the clock's text from `goalClock`;
- the Scout's tool list with each full description, read from the same definitions the Scout gets;
- `MECHANICS`;
- the knowledge pack, and the repair note when there is one;
- the route so far, from `routeText`, with the anchors' pixels left out;
- the Supervisor's own last three judgments;
- every call since the last judgment, from `recordText`, with each result or exact refusal;
- the action being judged and its reason;
- the page now: its frame, words, controls and dialogs;
- a closing line asking for the JSON verdict only.

The picture after the action goes with it, with a close-up of what was acted on. The packet is saved as sent, as `judgment-NNN.json` beside the run's frames, so any judgment can be replayed exactly. A judgment happens after every action except a plain look, at once after a refusal, and when the Scout says a goal is reached. Then the route is headed as the route "to check against the frames before the goal counts".

**Its tools and its answer.** The Supervisor may call `open_frame`, from `openFrameTool`, which reopens any frame of this run or an earlier one, and `memory_query`. Its answer must fit `ANSWER_SCHEMA` in `supervisor.ts`: a verdict, what it says, and seconds to add to the clock. Every property is required, because a provider that enforces strict schemas refuses an optional one.

**When an answer goes wrong.** `judge()` asks again, once and briefly, in four cases: the calls were spent on tools and no answer came, the answer could not be read, "says" ran too long, or the thinking ran past its cap. In the last case the packet goes again at low effort. An answer that still cannot be read counts as wait, and the Scout reads "The Supervisor could not be read; look again." Three in a row stop the run.

**The diagnosis.** When a goal is not reached, `diagnose()` sends the goal, every judgment of it, and `DIAGNOSE`. `DIAGNOSE` asks where the run stopped, citing the frame, what was tried, the best explanation and the next test, with anything untested marked as a guess. A repair starts from this diagnosis.

## The lessons

Only a run that reached at least one goal writes lessons. At its end, the Scout and the Supervisor each write their own, kept for themselves. `writeLessons` in `memory.ts` runs once for each, with `LESSONS` as its system prompt, worded for the agent writing. `LESSONS` asks for general advice in one to three sentences, with no names, numbers or page data, each citing this run's frames and saying whether it was seen there or is a guess. It forbids lessons about masked values and lessons that advise sending money. It also holds the two base lessons for both agents, word for word: the factory opens the start page before each goal, so that is never a lesson about the site, and a lesson about how a site behaves and how to tell is worth more than a list of its words. The message gives how each goal ended, the lessons memory served, and every frame as its page and words. Lessons are recorded with `record_lesson`, from `recordLessonTool`, whose input is the `Lesson` schema. The step then answers with `ANSWER_SCHEMA` in `memory.ts`: the served lessons it relied on, and those it contradicted, each with a reason and frames. `record_lesson` refuses a lesson with no frame of this run, one about masking (`aboutMasking`), one that advises sending money (`sendsMoney`), and any past the five that one agent's writing may record.

## Text for experiments only

`frame.ts`, behind `just frame`, gives one kept frame to the real Scout or the real Supervisor. A Scout sample sends `SCOUT` with the variant's `instructions` appended, and a message made of the goal, the tool's last answer, the page as JSON, and "Act now: one tool call." A Supervisor sample passes the variant's text through the `instructions` option of `supervisor()`, which appends it to `SYSTEM`. No live run sets that option.

## What no model reads

The gate in `gate.ts` replays a route through the crawler's own loop with no model. The request for a sign-in code in `person.ts` goes to a person in the Console's inbox. The sign-in, the code and the amounts are typed by the server, and no model ever sees them.

## Changing a prompt

Prompts are code. A change to any text above goes through a pull request, which says what the old text got wrong and how the new text fixes it.

When a run fails because an agent reasoned badly, the fix goes into the agent's instructions, or into what its tools let it do and tell it. It never goes into code that reasons for the agent. Code that picks the screen, guesses the field or writes the route would turn the factory into a hand-written crawler. Code changes only when a tool itself is wrong.

A prompt change is proved before any live run. `just frame` gives the kept bank 1 frame where the old behavior went wrong to the real agent, with the change applied as a variant, a few samples at a time. The change is ready when it beats the old behavior over five samples or more. Only then is a live run worth its cost.
