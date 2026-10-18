# The demo

About fifteen minutes. Run `just up`, then `just show`: Swagger UI, the Console, both banks and the simulated inbox open in tabs. Every login and member number is in `ACCESS.md`.

## 1. Authorize in Swagger UI

Press **Authorize**, and enter the client id and secret from ACCESS.md under Logins. Swagger UI gets the token itself.

Each section is a short list. A call opens on a click and shows only what it really answered. Its link, **Every response this call can give**, opens a page of each status with a real example.

<img src="demo/swagger.png" width="420" alt="Swagger UI with check-balance open"> <img src="demo/responses.png" width="300" alt="Every response a task can give">

## 2. A balance, in one call

Open `POST /tasks/check-balance`, press **Try it out**, keep the example (John Doe, `40017732`, Everyday Checking), and press **Execute**.

The first time, the bank asks for a code. Copy it from the simulated inbox (**Copy code**) and enter it in the Console's **Inbox**. The call answers **200 with the balance**. After that, the bank remembers the workstation for 30 days, so the next call needs no code.

<img src="evidence/bank-1/happy/05.png" width="300" alt="The bank asks for a code"> <img src="evidence/bank-1/happy/11.png" width="300" alt="The member summary the balance is read from">

## 3. A transfer, a person's approval, and the evidence

Open `POST /tasks/transfer`, keep the example, and press **Execute**. It answers **202**: the crawler stopped on the bank's review page, and nothing moves until a person approves. (The same `idempotencyKey` again returns the same run, never a second transfer; change it to transfer again.)

In the Console's **Inbox**, the approval shows From, To, Amount and Memo as the crawler read them, beside the masked picture of the review page. Approve it with a reason. Then `GET /tasks/{runId}` answers 200 with the bank's confirmation number. The Console's **Runs** page shows each step ("did → then the page") and, under **Frames**, every page the crawler saw, masked.

<img src="evidence/bank-1/transfer/17.png" width="300" alt="The review page a person approves"> <img src="evidence/bank-1/transfer/20.png" width="300" alt="The activity where the transfer is found by its memo">

## 4. Three hazards on bank 1

In the Console's **Hazard lab**, each hazard has **Copy arguments**. Add them to the end of a bank 1 address to see the hazard yourself, or press **Start the run** to watch the crawler meet it. Each lab run lands on the result printed beside it.

| Hazard | What the bank does | What the crawler does |
|---|---|---|
| `promo` | A promotion where home should be | Treats it as home |
| `confirm-dialog` | "This member has 2 unread alerts. View them now?" | Dismisses it, and records it |
| `swallowed-click` | Search's first click does nothing | The same page comes back, so its row runs again |

<img src="evidence/bank-1/hazard-promo/07.png" width="300" alt="The promo in place of home"> <img src="evidence/bank-1/hazard-confirm-dialog/11.png" width="300" alt="The alerts dialog">

## 5. The guard refuses "Close account"

The member summary offers **Close account**. The crawler never presses it: every action passes the job's allowlist first, and words that change an account are refused on every page. The first refusal freezes the bank until an admin clears it.

```sh
npx vitest run packages/guardrails -t "refuses every trap"
```

## 6. Bank 2: a stub, then the factory learns it

`GET /banks` lists bank 2 with `"stub": true`: it exists, but nothing serves it yet. A balance there answers 404 `task_not_available`.

```sh
just factory example 40017732 <from> <to>
```

Use two of John Doe's bank 2 accounts, by last four, from ACCESS.md. The Scout explores the bank, and the Supervisor judges each action from its picture before it happens. Enter the codes in the Console's Inbox as before. The table it writes is checked live, once healthy and once with a dialog forced. Then it waits on the Console's **Recommendations** page, each row beside its picture.

Approve it, and bank 2 is in service: `GET /banks` drops the stub, and the balance call from step 2 works with `"bank": "example"` and an account's last four.
