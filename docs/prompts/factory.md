# Prompts, part 2: the factory, the loop

These prompts build the factory: two agents and a memory that learn a bank no one wrote a crawler for, and repair a crawler after a bank changes its site. It's separate code from [part 1](bank1.md). It uses only part 1's runtime, which runs the crawlers it writes, the API's registry, which lists them, and the Console's inbox, where a person approves them. The brief doesn't ask for any of this. Start it once bank 1 is proven.

## 1. What the factory is

> Build the factory in its own code: `apps/factory` and `apps/memory`.
>
> - **Its output:** a crawler, in the same step format bank 1 uses, run by part 1's runtime.
> - **Agents:** two, on pi, through OpenRouter. The model is config; the default is Max Prime for both.
> - **Cost:** every call goes through our meter. The caps are in code ($10 a run, $150 a week), and it fails closed.
> - **Live only:** it crawls the live site every time. Nothing is replayed.
>
> Bank 2 is held out. Nothing is tuned against it until its one live run. Develop against bank 1's redesign.

## 2. Memory

> Build one memory service on Postgres, behind one door: a token for each role, signed writes, and a privacy screen. It starts empty. It keeps:
>
> - runs and attempts, with their frames;
> - lessons that cite frames by run, ref and the PNG's hash, each with a confidence;
> - facts, written only when a promotion proves them.
>
> A lesson says how a site works ("member search sits behind a link on the home page"), never what it calls things.
>
> The loop: save evidence, retrieve it, write new evidence.
> - **Save:** every run and attempt, with its frames.
> - **Retrieve:** both agents get the same pack: lessons with their citations, recent attempts with their frames, and the crawlers already promoted. Any later run can open any cited frame, picture and all.
> - **Write new:** each lesson is checked against the live page and marked relied on or contradicted, citing this run's frame.
>
> Fixed rules decide: one contradiction disputes, two retire, a promotion confirms, a demotion disputes. Lessons are written at every ending, crashes included, from a budget held back for it.

## 3. The Scout

> The Scout owns the job and works like a person. It reads memory first.
>
> - **It never acts until the page is fully rendered.** Code refuses an action on a page still loading.
> - **It sees:** after every action it gets the picture, the one before it, and the visible controls with their boxes.
> - **It decides from the picture,** and clicks by id, or by a position read from the picture, which must land on a visible control. The runtime's own targeting must find that same control at once; if it doesn't, the Scout is told. Each action carries a one-line why.
> - **It writes the crawler as it goes:** each step comes from an action it took, in the page's own words, citing its frame. It also states claims with frames.
>
> There's no word list, and no bank's words ever appear in a prompt.

## 4. The Supervisor

> The Supervisor is independent.
>
> - **It judges every action from the picture before the next one:** continue, wait or stop, citing what it sees. Code enforces the answer, and an unreadable answer counts as wait.
> - **It keeps the whole run in view:** one conversation per run. It can reopen any frame of this run or an earlier one.
> - **It corrects the Scout** by citing a frame.
> - **On a failure, it diagnoses from the frames:** where the run stopped, what the page showed, and why. Never from a reason computed in code.
> - **At the end, and at every failed ending,** it turns the checked claims into lessons with frames, and marks which served lessons were relied on or contradicted.

## 5. The gate

> 1. Code runs the new crawler live first, from a fresh sign-in and a remembered one, against the ledger.
> 2. A person approves it, seeing each step beside its picture.
> 3. Each kept hazard is forced alone.
> 4. Two clean runs.
> 5. Promotion: `GET /banks` lists it.

## 6. Repair

> In service, an unknown screen or a missing control demotes the version. The run escalates with its frames, and a case opens.
>
> Repair is the same crawl. It starts from the broken crawler, the bank's lessons, and the failing frames with the Supervisor's diagnosis. It changes only what moved, and records which lessons held.

## 7. Proof

> These tests run with no model:
> - every model turn carries its picture;
> - an earlier frame opens;
> - a mismatched step is refused;
> - a failing crawler never reaches a person's approval;
> - no factory code or fake imports the bank's source.
>
> Then two live runs, one at a time, each only after my go:
> 1. repair bank 1 after its redesign;
> 2. learn bank 2.
>
> Each must be promoted with nothing but a person's approval. For each, report the cost, the actions the targeting confirmed or refused, the corrections that cite a frame, and the lessons relied on.
>
> On a failure, report from the run's own evidence, record it, and stop.
> - Don't read the run to supply the answer.
> - Don't change a prompt or the bank to steer it.
> - Don't patch in a loop.

## 8. Docs

> Add a few lines to the README: how the loop works, what it learned, and the cost per bank as measured. In 80 to 100: the models we tried, and the lessons from the runs.
>
> **The walkthrough:** the factory's code, file by file, in the order a reviewer should read it. Start at the run, then the Scout's tools, then the Supervisor, then memory's loop, then the gate. Each file gets its line count, what it does, and the decision behind it, with the alternative we didn't choose. Mark where it reuses part 1, and nothing else.
