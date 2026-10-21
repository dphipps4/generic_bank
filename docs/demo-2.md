# Demo 2: Bank 2, a crawler the factory builds

Bank 2 runs the same vendor product as bank 1, but configured, branded and laid out differently, and many of its labels and buttons are drawn as pictures. Nobody wrote its crawler. In this demo, bank 2 starts as a stub that can't serve anything. The factory's two agents learn the live site and produce a route: plain data listing bank 2's screens, how to recognize each one, and a teller's steps there. A person approves the route, and from then on ordinary code replays it, with no model, and bank 2 answers a balance through the same API as bank 1.

## Before you start

Start from empty data, so nothing about bank 2 is known yet:

```sh
just reset     # asks first; deletes the databases, ledgers, evidence and sessions, keeps the images
just up
just show
```

Authorize in [Swagger UI](http://localhost:8000/docs) as in [Demo 1](demo-1.md).

The factory's agents need a model, through OpenRouter. Give it your key once, unseen, then start the stack again so the factory picks it up:

```sh
just secret-set factory OPENROUTER_API_KEY
just up
```

The factory caps its own spending at $25 a run.

## 1. See that bank 2 is a stub

In Swagger UI, run `GET /banks`. Bank 2, `example`, is listed with `"stub": true` and no tasks: the bank exists, but no route serves it yet.

Run `POST /tasks/check-balance` with `"bank": "example"`. It answers 404 `task_not_available`, and lists the banks that can.

## 2. Let the factory learn it

On the ACCESS page, find John Doe in bank 2's table. Bank 2 names accounts by their last four digits. Use his checking and savings accounts:

```sh
just factory example 40017732 8176 9433
```

The Scout works the live site, one action at a time, and writes the route as it goes. The Supervisor looks at a picture of the page after each action, and allows the next one or corrects the Scout. They reach three goals in turn: the balance, a transfer up to its review page (never sent), and the account's activity.

Bank 2 asks for a sign-in code by email, up to three times: once for the run, and once for each of the gate's two checks below, since each starts from a browser that has never signed in. Each time, copy the code from the [simulated inbox](http://localhost:8089) into the Console's [**Inbox**](http://localhost:8080/inbox) within five minutes.

The run has a hard limit of 60 minutes of the agents' own time. The time you spend fetching a code doesn't count.

Before anyone sees the route, the gate replays it with no model, live: once from a new browser, once from a browser the bank trusts, and once with a surprise dialog forced. The run ends with a report: what it cost, how many actions the Supervisor judged and how many the tools refused, the corrections that cite a frame, the gate's three results, and the lessons saved to memory.

## 3. Approve the route

A route that passed the gate waits on the Console's [**Recommendations**](http://localhost:8080/recommendations) page. Each screen is shown with the words and pictures that identify it, the steps taken there, and the picture of the page it came from. Read it, and approve it with a reason of at least ten characters.

## 4. Use bank 2

Run `GET /banks` again. Bank 2 now lists its tasks, and the stub is gone.

Run `POST /tasks/check-balance` with `"bank": "example"`, member `40017732` and account `8176`. The service has never signed in to bank 2, so the first call answers 202 `awaiting_staff_code`. Enter the code from the inbox as before, then run `GET /tasks/{runId}`: it answers 200 with the balance, read by the route the factory built.

## 5. Optional: break it, and repair it

Bank 2 has a vendor redesign: new names, a notice after sign-in, and its menu moved. Turn it on:

```sh
just redesign on
```

Run the balance again. The crawler meets a page its route doesn't know, so it stops and answers 409 `unknown_screen`, with the frames of what it saw, for a person. That version of the route is taken out of service, bank 2's tasks disappear from `GET /banks`, and the Console's dashboard shows a repair case.

Run `just factory example 40017732 8176 9433` again. It sees the open repair case and starts from the broken route, with a note of where it broke. When the gate passes, approve the repaired route as before, and the balance answers again.

`just redesign off` puts the old site back, and so does the next `just up`. The repaired route no longer knows the old site, so that is another repair, or `just reset` to start over.
