// The inbox (plan, §G.2, §F.3): every open human task, oldest deadline first, with how long the agent
// has been waiting and how often it has asked. A person answers here, and every answer is also an
// API call (`POST /human-tasks/:id/:action`), so tests drive the same path a person does. A code is
// sealed the moment it arrives and is never shown again, not here and not in the audit.
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ACTIONS, HumanAction, type HumanTaskKind, problem } from '@gb/contracts';
import { actOnHumanTask } from '@gb/runs';
import { esc, page, type Sql, type Viewer } from './layout.js';

export interface InboxDeps {
  sql: Sql;
  /** Seals a person's answer for the Runner. It opens no run's inputs. */
  answerKey: string;
  whoIs(req: FastifyRequest): Viewer | null;
}

/** An approval or a code waiting longer than this is called out on every page (plan, §G.4). */
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
  cancel: 'The run is cancelled.',
};

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
        contextMasked: { prompt?: string } | null;
        openedAt: Date;
        deadline: Date;
        asks: number;
        lastAskedAt: Date | null;
      }>(
        `SELECT h.id, h.kind, h."runId", r.task, r.bank, h."contextMasked", h."openedAt", h.deadline,
                h.asks, h."lastAskedAt"
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
      const cancel = `<details><summary>Cancel the run</summary><form method="post" action="${at('cancel')}" class="row"><input name="reason" minlength="10" required aria-label="Reason" placeholder="Why (at least ten characters)"><button class="quiet">Cancel</button></form></details>`;
      return answer + cancel;
    };

    const rows = tasks
      .map((t) => {
        const left = new Date(t.deadline).getTime() - now;
        return `<tr><td><span class="pill needs_human">${KIND_LABEL[t.kind]}</span></td>
<td>${esc(t.contextMasked?.prompt ?? '')}<br><small><a href="/runs/${esc(t.runId)}">${esc(t.task)} on ${esc(t.bank)}</a></small></td>
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
        const action = HumanAction.safeParse(req.params.action);
        if (!action.success) return fail(reply, fromForm, 404, 'there is no such action');
        const r = await actOnHumanTask(
          deps.sql,
          req.params.id,
          action.data,
          req.body,
          who.email,
          deps.answerKey,
        );
        if (!r.ok) return fail(reply, fromForm, r.status, r.reason);
        return fromForm
          ? reply.redirect(`/inbox?done=${action.data}`, 303)
          : reply.send({ ok: true });
      },
    );
  });
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
