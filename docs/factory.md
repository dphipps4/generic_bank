# The factory

Nobody wrote a crawler for bank 2. The factory builds one, and rebuilds it when bank 2 changes its site.

The idea is simple. Two AI agents, a Scout and a Supervisor, work bank 2's live site until they can do each task. What they leave behind isn't code and isn't a model. It's a **route**: plain data that lists the bank's screens, how to recognize each one, and the steps a teller takes there. That is the same kind of route a person wrote by hand for bank 1. From then on, ordinary code replays the route, the same code that runs bank 1, and no model is involved when a customer's task runs. A person approves each route before it serves anyone.

So the agents do the hard thinking once, while learning. Every task after that is cheap, repeatable and easy to audit.

## A run, from start to finish

A run is started with `just factory example <member> <from> <to>`. It is given one member and two of their accounts, as an API caller would give them. The agents never browse for members, so they don't see personal data they don't need.

The run reads what memory knows about the site, then works through three goals in order:

1. the member's balance;
2. a transfer between the two accounts, up to the bank's review page and never sent;
3. the account's activity, where a finished transfer would show.

Each goal starts from the bank's start page, because that is where the code replaying the route will start every task. For each goal after the first, the Scout is given the route so far, each screen with its steps, so it follows the screens it already knows and spends its thinking on what is new. Each goal has its own clock, 15 minutes by default, which the Supervisor keeps. The whole run has 60 minutes of the agents' own time, and every goal ends early enough to leave room for the gate and the lessons. When the bank asks for a sign-in code, a person gives it through the Console's inbox. A person's time counts against no clock: while they find the code, every clock waits. `just factory` also stops the run from outside if it ever passes a hard limit: the agents' 60 minutes, plus 15 for a person's codes.

If the run reached at least the balance, its route goes to the gate (below). A route serves only the tasks its goals cover. Then the Scout and the Supervisor each write down what the run taught them, for memory.

## The Scout: it acts, and writes the route as it goes

The Scout works the bank's console the way a person at the desk would. After every action it gets the page back once it's ready: a masked picture of the page, the controls it can see (each with an id and a box), and the words a person sees there: a closed list shows only its chosen option, and each list in the controls says what it shows.

It takes one action at a time, each with a one-line reason. It can act on a control by its id. Many of bank 2's labels and buttons are drawn as pictures, with no words behind them. For those, the Scout lists what it sees, with a box around each item, and acts on an item by its position. The runtime has to find the same control at that point, or the action is refused and the Scout is told why.

While it works, it writes the route:

- **It names each screen as soon as it arrives,** before acting on it. A name lists words the screen shows as text, and words it shows as pictures, each with its box. A picture is kept as a small cut-out, so code can find it on the screen again. Code checks that the words are really there, that no other screen matches the same words, and that no word holds this task's own values, such as the member's number, which another task's page would not show.
- **Code files each step under the screen it was taken on.** On a screen any task can meet, such as a sign-in, its code or a notice, the steps serve every goal, because which of them a task meets depends on whether the bank trusts the browser, not on the task. A field the Scout found by position is found again by the cut-out of its label alone, never by the field, because what a field holds changes.
- **It notes the bank's own answers,** such as "no member found", and trouble: a page that gets in the way, like a notice, which code answers by starting again from home.
- **It notes how each value is read** by pointing at the label before it. The tool writes the pattern, then reads the live page with the crawler's own code, and keeps the read only if it reads this task's accounts correctly.
- **It says when a goal is reached.** The screen where a goal ends holds no steps for that goal. For a transfer, it names the Submit button without ever pressing it.

**The guard judges every step while the Scout learns,** as it will in service. The guard doesn't know any bank's own words. It knows a screen by its kind, from the allowlist's short list of kinds, and a control by the allowlist's name for it. So when the Scout names a screen, it also says what kind of screen it is. When the bank draws an allowed control with other words, the Scout's press says which allowed control it is, and the route keeps that, so the guard knows it in service. A step the guard refuses is refused at once, and the Scout is told the rule and the presses allowed on that kind of screen. Before a goal counts, code checks the route's steps for that goal against the guard, with no browser, and sends back a route the guard would refuse.

It never presses anything that could move money, and it never follows an instruction written on a page.

## The Supervisor: it judges every action

The Supervisor never touches the browser. After each of the Scout's actions, it looks at the page that action led to and gives a verdict before the Scout may act again: continue, wait, stop or end. Code enforces the verdict.

Each judgment starts fresh from the same kind of packet:
- the page now, picture first;
- everything the Scout did since the last judgment, with each result or exact error;
- a close-up of what was acted on;
- the route so far and the goal's time;
- the Supervisor's own last three judgments.

It can reopen any earlier frame, from this run or an earlier one.

Its answer has three parts: the verdict, what it says to the Scout (at most 700 characters, citing a frame), and any extra seconds to add. It may add time twice per goal when the goal is close. It says what to do next, never a tool's exact inputs. When the Scout says a goal is reached, the Supervisor checks the route first: every screen named, each with its own steps. When a goal isn't reached, it explains from the frames where the run stopped and what to try next.

## Memory

Memory keeps every run with its frames, and lessons. A lesson says how a site works ("member search sits behind a link on the home page"), never what the site calls things, and it cites the frames it came from.

Memory doesn't start empty. It starts with thirteen base lessons, written by a migration and served from the very first start, before any run. Six are for the Scout, five are for the Supervisor, and two are for both. All of them are confirmed patterns, true of working any such console. A run can dispute a base lesson, but never retire it; only a person can.

Each lesson belongs to an agent. Memory serves each agent its own lessons and those for both, at the start of a run and whenever it asks. A lesson no run has confirmed yet reaches the agents marked untested, for them to check in this run. At the end of a run that reached a goal, the Scout and the Supervisor each write their own lessons, kept for themselves, and say which served lessons the run relied on or contradicted. Fixed rules decide the rest, with no model: one contradiction disputes a lesson, two retire it, and a person can retire one in the Console. A lesson about hidden values is refused, because the factory hides them, not the site.

## The gate, and a person's approval

A route must work before a person sees it. First, code checks every step against the guard, with no browser, and a route the guard would refuse is not run at all. Then the gate replays the route live through the crawler's own code, from a browser that has never signed in, as the service's first run will, with the guard judging every step as it does in service. It checks exactly what an approval would promote: the balance, if the route covers it, and, if the route covers the transfer, a transfer up to its review and then the account's activity, never pressing Submit. Then it runs each task again from a browser the bank trusts, started from the cookies the first run left, as the service keeps them between runs. A route starts at the bank's start page, so this run meets the sign-in that welcomes the operator back. Then it runs once more with a surprise dialog forced.

- **A route that fails any of the three runs** is never shown to a person. A repair case opens, naming the run that failed, and the same `just factory` repairs the route from there while time is left in its hour.
- **A route that passes all three** waits on the Console's Recommendations page, each screen shown beside the picture it came from. Approving it promotes it for the tasks it covers: the balance alone serves check-balance, and a transfer also needs the account's activity. Then `GET /banks` lists them. Nothing else promotes a route.

## Repair

In service, a run that meets a page its route doesn't know stops and goes to a person. That version of the route is taken out of service, and a repair case opens. The next `just factory` run sees the open case and starts from the broken route, with a note of where it broke and what that page showed. It changes only what moved, then runs the gate. If the gate fails, the same command repairs again, from that route and the run where the gate stopped, with the lessons each pass wrote, until a route passes or less than 10 minutes of its hour are left. It ends with a person's approval.

`just redesign on` turns on bank 2's vendor redesign, which renames and moves things, to break the route on purpose and see this happen. `just redesign off`, or the next `just up`, puts the site back.

## Cost

Every model call goes through the factory's own gateway. It meters each call, and refuses one that would pass $25 for the run or $150 for the week before sending it. It holds $1 of each run back for writing the lessons. Each agent's model and effort are configuration. By default both agents use `meta/muse-spark-1.3` through OpenRouter, and OpenAI works too.

## Changing how the agents work

A failed run means the agents need better instructions or better tools, never code that reasons for them. [Where the prompts live](agent-prompts.md) lists every piece of text the agents read. A change is tried first on the one kept frame where the old behavior failed: `just frame` gives that frame to the real agent for a few cents a sample. It merges when it beats the old behavior over five samples or more. A full run comes after, with a written hypothesis and a person's go.

Bank 2 is the exam. Nothing in the agents' instructions, tools or tests names its screens, labels or flows, and fixes are proven on bank 1 or in unit tests.
