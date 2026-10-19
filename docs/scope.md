# How it meets the task and minimum scope

This page goes through what the brief asks for and how the system does it. [Appendix A](brief.md) lists the same points with the code and the test behind each one.

## Two typed tasks, end to end

`POST /tasks/check-balance` and `POST /tasks/transfer` each take typed inputs and return one structured result. An agent can discover them with `GET /banks` and `GET /tools`. Both run all the way through bank 1's web UI, and a test proves each one.

## Driving the messy legacy UI

Bank 1 looks like a staff console from 2003. It uses framesets and nested tables, has no test IDs, puts each label in a table cell of its own, and draws some buttons as styled text. The runtime copes the way a person would:

- It waits until the page is ready: the picture holds still twice running, nothing says "loading", and there's something to act on.
- It finds a field by the label drawn next to it, and a button by the name drawn on it. If two buttons share a name, it takes the one nearest the section it means.
- It clicks with the real mouse, and refuses if something is covering the control.

Bank 1's route was written from [a recorded walk through its pages](evidence/bank-1/README.md), and every row points to the picture it came from. A test checks every row's words against that picture.

## Keeping outcomes apart

Each kind of outcome reaches the caller differently. [Appendix B](results.md) lists all of them.

| Kind | Example | The caller gets |
|---|---|---|
| The bank's own answer | "No member found with that number." | 422, `no_such_member` |
| Recovered inside the run | a dialog, a promo, a swallowed click, a session that ended early | 200; the run's steps show what happened |
| Hard failure | the bank is down, or shows an error page | 503 with `retryable: true`, or 502 |
| Handed to a person | an unknown page, stuck, an unclear transfer | 409 `escalated` |

On every page, the crawler first checks for the bank's own answers, by their exact words. If something goes wrong, it goes back to the home page and starts again, at most twice, and never after pressing Submit. If that doesn't work, the run fails. The outcome tests prove one of each kind. To try the error paths yourself, the Console's **Hazard lab** forces any of the banks' 18 kinds of trouble on a real run, with the expected result beside each.

## Escalating when stuck

A run stops and hands off to a person when:

- it reaches a page no row recognizes, and the page is still there after one fresh start from home;
- it sees the same page three times in a row;
- after a transfer, the account's history doesn't show it exactly once;
- the guard refuses an action;
- bank 1 asks for a supervisor's approval, which happens for transfers over $2,500.

The API answers 409 with an `escalationId`. The escalation shows up in the Console's Inbox, linked to the run, with every step and a masked picture of every page up to where it stopped. A person can resume the run, finish it by hand and record the result, or cancel it.

## Safety with regulated data

- **An allowlist.** Each task has a short list of allowed actions, each naming a kind of screen, a verb and a control. Every action is checked against it before it happens. Some controls are refused everywhere: Pay now, Add payee, Change address, Waive fee and Close account. The first refusal freezes that bank until an admin clears it.
- **Actions that can't be undone.** A transfer stops on the bank's review page and waits. A person's approval issues a grant that works once, lasts five minutes, and only matches what the review page showed. Submit is pressed once. If the bank's answer is unclear, the crawler looks for the transfer in the account's history instead of pressing again. Sending the same `idempotencyKey` twice returns the same run.
- **Nothing sensitive is kept.** One masking rule covers everything stored or shown to a model: pictures, page text, addresses, run inputs and the Console. Money is hidden whole, and so is every name and secret the run knows. A member or account number keeps only its last four digits (`████7732`). A run's inputs and the sign-in codes are stored sealed. The PII suite runs both tasks, then searches every database row, stored file and log line for every seeded value.

## Evidence

Every page a run sees becomes a step, saved with its masked picture and its visible words. The Console shows each run step by step, with its pictures.

## Scale

A bank is a route, and each run is durable and stands on its own, so the design can grow. There's no scaling machinery here: one runner, on one laptop, handling two runs at a time.

## The extension: reuse across tenants

Bank 2 runs the same vendor product as bank 1, configured and branded differently, with many labels drawn as pictures. Until it's learned, `GET /banks` marks it as a stub. The factory's two AI agents learn it on the live site. A Scout acts and writes the route as it goes, a Supervisor judges each action from a picture of the page, and the guard judges every step as it will in service. The result is plain data, a route of the same shape as bank 1's, replayed by the same code with no model. Before anyone sees it, code replays it live twice, once with a surprise dialog forced. Then a person approves it. [The factory](factory.md) explains how.
