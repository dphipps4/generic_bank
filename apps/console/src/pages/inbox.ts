// The inbox (plan, §2, §6): every open human task, oldest deadline first, with how long the agent
// has been waiting and how often it has asked. A person answers here, and every answer is also an
// API call (`POST /human-tasks/:id/:action`), so tests drive the same path a person does. A code is
// sealed the moment it arrives and is never shown again, not here and not in the audit. An approval
// shows what is being approved, as the crawler read it off the bank's review page, and its masked
// picture. An escalation is resumed, finished by hand or cancelled (plan, §3).
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ACTIONS, HumanAction, type HumanTaskKind, problem, refusal } from '@gb/contracts';
import { actOnHumanTask, type ApprovalContext } from '@gb/runs';
import { esc, page, type Sql, type Viewer } from './layout.js';

export interface InboxDeps {
  sql: Sql;
  /** Seals a person's answer for the Runner. It opens no run's inputs. */
  answerKey: string;
  whoIs(req: FastifyRequest): Viewer | null;
  /** Hands a resumed run back to the Runner (the workflow queue); without it, nothing resumes. */
  restart?: (runId: string, taskId: string) => Promise<void>;
}

/** An approval or a code waiting longer than this is called out on every page (plan, §2). */
export const WAITING_TOO_LONG_MS = 5 * 60_000;

export async function waitingTooLong(sql: Sql, now = new Date()): Promise<number> {
  const r = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "HumanTask" WHERE status = 'open' AND "openedAt" < $1`,
    [new Date(now.getTime() - WAITING_TOO_LONG_MS)],
  );
  return r.rows[0]?.n ?? 0;
}

const KIND_LABEL: Record<HumanTaskKind, string> = {
  staff_code: 'Staff code',
  supervisor_code: 'Supervisor code',
  approval: 'Approval',
  escalation: 'Escalation',
};

const NOTICE: Partial<Record<HumanAction, string>> = {
  answer: 'The code went to the run. It is typed into the bank and not kept.',
  approve: 'Approved: the transfer will be submitted once, under a grant valid for five minutes.',
  reject: 'Rejected: the run ends and nothing is submitted.',
  take_over: 'Taken over: finish it by hand in the bank.',
  cancel: 'The run is cancelled.',
  resume: 'Resumed: the run signs in again and carries on; the agent sees it running.',
  finish: 'Recorded: the agent sees the task finished by hand, with your result.',
};

/** The written reason every action but a code carries (plan, §2). */
const REASONED: Partial<Record<HumanAction, { label: string; summary?: string; quiet?: boolean }>> =
  {
    approve: { label: 'Approve' },
    reject: { label: 'Reject', summary: 'Reject the transfer', quiet: true },
    take_over: { label: 'Take over', summary: 'Take over, by hand in the bank', quiet: true },
    resume: { label: 'Resume' },
    finish: { label: 'Finish by hand', summary: 'Finish by hand, and record the result' },
    cancel: { label: 'Cancel', summary: 'Cancel the run', quiet: true },
  };

export const dollars = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// What an approval asks a person to approve: the review page's values and its masked picture.
function review(t: { runId: string; contextMasked: Partial<ApprovalContext> | null }): string {
  const r = t.contextMasked?.review;
  if (!r) return '';
  const f = t.contextMasked?.frame;
  const pic =
    f && f.runId === t.runId
      ? `<a href="/runs/${esc(f.runId)}/frames/${f.seq}.png"><img class="thumb" src="/runs/${esc(f.runId)}/frames/${f.seq}.png" alt="The review page, masked" loading="lazy"></a>`
      : '';
  return `<dl class="review"><dt>From</dt><dd><code>${esc(r.from)}</code></dd><dt>To</dt><dd><code>${esc(r.to)}</code></dd><dt>Amount</dt><dd><b>${esc(dollars(r.amountCents))}</b></dd><dt>Memo</dt><dd>${esc(r.memo)}</dd></dl>${pic}`;
}

/** "4 min", "1 h 12 min": how long, for a person reading a list. */
export function duration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Only approvers and admins change anything; a viewer reads. */
const mayAct = (v: Viewer) => v.role === 'approver' || v.role === 'admin';

export function inboxPages(app: FastifyInstance, deps: InboxDeps) {
  app.get<{ Querystring: { done?: string; error?: string } }>('/inbox', async (req, reply) => {
    const who = deps.whoIs(req);
    if (!who) return reply.redirect('/admin/login');
    const now = Date.now();
    const tasks = (
      await deps.sql.query<{
        id: string;
        kind: HumanTaskKind;
        runId: string;
        task: string;
        bank: string;
        contextMasked: Partial<ApprovalContext> | null;
        resolvable: boolean;
        openedAt: Date;
        deadline: Date;
        asks: number;
        lastAskedAt: Date | null;
      }>(
        `SELECT h.id, h.kind, h."runId", r.task, r.bank, h."contextMasked", h.resolvable, h."openedAt",
                h.deadline, h.asks, h."lastAskedAt"
           FROM "HumanTask" h JOIN "TaskRun" r ON r.id = h."runId"
          WHERE h.status = 'open'
          ORDER BY h.deadline ASC, h."openedAt" ASC`,
      )
    ).rows;

    const actions = (t: (typeof tasks)[number]) => {
      if (!mayAct(who)) return '<span class="soft">Approvers answer here.</span>';
      const at = (a: HumanAction) => `/human-tasks/${encodeURIComponent(t.id)}/${a}`;
      const answer = ACTIONS[t.kind].includes('answer')
        ? `<form method="post" action="${at('answer')}" class="row"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" maxlength="8" required aria-label="Code" placeholder="Code"><button>Enter code</button></form>`
        : '';
      const reasoned = ACTIONS[t.kind]
        .filter((a) => REASONED[a] && !refusal({ ...t, status: 'open' }, a))
        .map((a) => {
          const o = REASONED[a]!;
          // A transfer finished by hand carries the bank's confirmation number, if it was made.
          const extra =
            a === 'finish' && t.task === 'transfer'
              ? '<input name="confirmation" aria-label="Confirmation" placeholder="Confirmation number, if made">'
              : '';
          const form = `<form method="post" action="${at(a)}" class="row"><input name="reason" minlength="10" required aria-label="Reason" placeholder="Why (at least ten characters)">${extra}<button${o.quiet ? ' class="quiet"' : ''}>${o.label}</button></form>`;
          return o.summary ? `<details><summary>${o.summary}</summary>${form}</details>` : form;
        })
        .join('');
      return answer + reasoned;
    };

    const rows = tasks
      .map((t) => {
        const left = new Date(t.deadline).getTime() - now;
        return `<tr><td><span class="pill ${t.kind === 'escalation' ? 'escalated' : 'needs_human'}">${KIND_LABEL[t.kind]}</span></td>
<td>${esc(t.contextMasked?.prompt ?? '')}${review(t)}${t.resolvable ? '' : '<br><small>It cannot resume: the bank is frozen until it is cleared on <a href="/freezes">Freezes</a>.</small>'}<br><small><a href="/runs/${esc(t.runId)}">${esc(t.task)} on ${esc(t.bank)}</a></small></td>
<td>${duration(now - new Date(t.openedAt).getTime())}${t.asks ? `<br><small>asked ${t.asks} ${t.asks === 1 ? 'time' : 'times'}</small>` : ''}</td>
<td>${left > 0 ? duration(left) : '<b>due now</b>'}</td>
<td>${actions(t)}</td></tr>`;
      })
      .join('');

    const q = req.query;
    const done =
      q.done && HumanAction.safeParse(q.done).success ? NOTICE[q.done as HumanAction] : '';
    const notice = done
      ? `<p class="note ok">${esc(done)}</p>`
      : q.error
        ? `<p class="note bad">${esc(q.error)}</p>`
        : '';
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Inbox',
          `<h1>Inbox</h1>${notice}${
            rows
              ? `<table><tr><th>Asked for</th><th>What</th><th>Agent waiting</th><th>Time left</th><th></th></tr>${rows}</table>`
              : '<p class="empty">Nothing is waiting for a person.</p>'
          }`,
          { active: '/inbox', admin: who.email, waiting: await waitingTooLong(deps.sql) },
        ),
      );
  });

  // Answers arrive from the page's forms and as JSON from the API; both take the same path.
  void app.register(async (scope) => {
    if (!scope.hasContentTypeParser('application/x-www-form-urlencoded'))
      await scope.register(formbody);
    scope.post<{ Params: { id: string; action: string } }>(
      '/human-tasks/:id/:action',
      async (req, reply) => {
        const fromForm = (req.headers['content-type'] ?? '').startsWith(
          'application/x-www-form-urlencoded',
        );
        const who = deps.whoIs(req);
        if (!who) return fail(reply, fromForm, 401, 'sign in first');
        if (!mayAct(who)) return fail(reply, fromForm, 403, 'only approvers can answer');
        // The plan's paths spell it take-over; the contract, take_over.
        const action = HumanAction.safeParse(req.params.action.replace('-', '_'));
        if (!action.success) return fail(reply, fromForm, 404, 'there is no such action');
        const r = await actOnHumanTask(
          deps.sql,
          req.params.id,
          action.data,
          fromForm && action.data === 'finish' ? finishForm(req.body) : req.body,
          who.email,
          deps.answerKey,
          deps.restart ? { restart: deps.restart } : {},
        );
        if (!r.ok) return fail(reply, fromForm, r.status, r.reason);
        return fromForm
          ? reply.redirect(`/inbox?done=${action.data}`, 303)
          : reply.send({ ok: true });
      },
    );
  });
}

/** The finish form's fields as the contract's body: a confirmation number is a transfer's result. */
function finishForm(body: unknown) {
  const b = (body ?? {}) as Record<string, string>;
  const confirmation = b.confirmation?.trim();
  return {
    reason: b.reason,
    // The person read it in the bank; the system did not read it back from the history.
    ...(confirmation ? { data: { confirmation, seenInHistory: false } } : {}),
  };
}

function fail(reply: FastifyReply, fromForm: boolean, status: number, reason: string) {
  if (fromForm) return reply.redirect(`/inbox?error=${encodeURIComponent(reason)}`, 303);
  return reply
    .code(status)
    .type('application/problem+json')
    .send(problem(status, PROBLEM[status] ?? 'refused', reason));
}

const PROBLEM: Record<number, string> = {
  400: 'invalid_input',
  401: 'not_signed_in',
  403: 'insufficient_role',
  404: 'not_found',
  409: 'conflict',
};
