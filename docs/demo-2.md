# Demo 2: Bank 2, the factory writes the crawler

Bank 2 runs the same vendor product as bank 1, but configured, branded and laid out differently. Nobody writes its crawler. The factory explores the live site and writes the crawler's table on its own, and a person approves it before it's used. This demo shows bank 2 going from a stub that can't serve anything to answering a balance through the same API as bank 1.

## Before you start

Run `just up`, then `just show`, and authorize in [Swagger UI](http://localhost:8000/docs) as in [Demo 1](demo-1.md). The factory needs an OpenRouter key: `just secret-set factory OPENROUTER_API_KEY`. Each factory run is capped at $25.

## 1. See that bank 2 is a stub

In [Swagger UI](http://localhost:8000/docs), run `GET /banks`. Bank 2, `example`, is listed with `"stub": true`: the bank exists, but no crawler serves it yet.

Run `POST /tasks/check-balance` with `"bank": "example"`. It answers 404 `task_not_available`.

## 2. Let the factory learn it

Look up two of John Doe's bank 2 accounts on the ACCESS page; bank 2 names accounts by their last four. Then run:

```sh
just factory example 40017732 <from> <to>
```

The Scout explores the bank and writes the table as it goes. The Supervisor looks at a picture of the page before each of the Scout's actions, and allows or refuses it. When the bank asks for a sign-in code, copy it from the [simulated inbox](http://localhost:8089) into the Console's [**Inbox**](http://localhost:8080/inbox).

The run ends with a report: what it cost, which actions the Supervisor refused, what it corrected, and the lessons it saved to memory.

## 3. Approve the table

Before anything serves, the new table is tried on the live bank twice: once as normal, and once with a surprise dialog forced. A table that passes waits on the Console's [**Recommendations**](http://localhost:8080/recommendations) page, with each row next to the picture of the page it came from. Read it, and approve it.

## 4. Use bank 2

Run `GET /banks` again. Bank 2 now lists its tasks, and the stub is gone.

Run `POST /tasks/check-balance` with `"bank": "example"`, member `40017732` and one of the account's last fours. It answers 200 with the balance, through the same API as bank 1.
