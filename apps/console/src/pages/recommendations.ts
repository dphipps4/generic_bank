// Recommendations (prompts, part 2, §5): a table the factory learned for a bank, after the gate's
// live runs. The card shows each page as a row: the words that show it, the steps taken there for
// each goal, and a Frames button that opens the frame it cites; then how values are read, the
// bank's answers, and what the gate's runs read. A person approves or rejects it with a written
// reason that goes to the audit; approving promotes the table for both tasks, and nothing else
// does. Deciding is also an API call (`POST /recommendations/:id/:action`), so tests take the same
// path a person does.
import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { problem } from '@gb/contracts';
import { promoteTable } from '@gb/runs';
import { waitingTooLong } from './inbox.js';
import { esc, page, type Sql, type Viewer } from './layout.js';
import { FRAMES_POPUP, framesButton, framesOf } from './runs.js';

export interface RecommendationDeps {
  sql: Sql;
  whoIs(req: FastifyRequest): Viewer | null;
}

/** A learned table, as the card reads it. */
interface Table {
  rows: {
    page: string;
    /** The guard's kind for this screen. */
    screen?: string;
    shows: string[];
    never?: string[];
    do: Record<string, unknown[]>;
    frame: string;
  }[];
  answers: { says: string; code: string; frame: string }[];
  reads: Record<string, string | string[]>;
  /** The guard's name for each control the bank draws with other words. */
  names?: Record<string, string[]>;
  ends: Record<string, string>;
  submit: { press: string; frame: string };
}

interface Row {
  id: string;
  factoryRunId: string;
  tenant: string;
  table: Table | null;
  check: { hazard: string | null; ok: boolean; said: string }[] | null;
  status: string;
  createdAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
}

const when = (d: Date) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

/** Only an admin decides; a viewer reads. */
const mayAct = (v: Viewer) => v.role === 'admin';

const ACTIONS = ['approve', 'reject'] as const;
type Action = (typeof ACTIONS)[number];

const NOTICE: Record<Action, string> = {
  approve: 'Approved: the table serves both tasks at its bank.',
  reject: 'Rejected: the table is not used.',
};

/** A step as a person reads it. */
const stepText = (s: unknown) => {
  const x = s as Record<string, string>;
  return 'type' in x
    ? `type ${x.value} into "${x.type}"`
    : 'choose' in x
      ? `choose ${x.containing} in "${x.choose}"`
      : `press "${x.press}"${x.near ? ` near ${x.near}` : ''}`;
};

/** One recommendation as its review card. */
async function card(sql: Sql, r: Row, who: Viewer): Promise<string> {
  const frames = await framesOf(sql, r.factoryRunId);
  const button = (ref: string) => {
    const f = frames.filter((x) => x.seq === Number(ref.slice(1)));
    return f.length ? framesButton(r.factoryRunId, f) : '<span class="soft">none</span>';
  };
  const t = r.table;
  const rows = (t?.rows ?? [])
    .map(
      (row, i) =>
        `<tr><td>${i + 1}</td><td>${esc(row.page)}<br><span class="soft">${row.screen ? `the guard's ${esc(row.screen)}` : 'no kind: the guard refuses its steps'}</span></td><td>${row.shows.map((w) => `"${esc(w)}"`).join(', ')}${row.never?.length ? `<br><span class="soft">never ${row.never.map((w) => `"${esc(w)}"`).join(', ')}</span>` : ''}</td><td>${
          Object.entries(row.do)
            .map(
              ([goal, steps]) =>
                `<b>${esc(goal)}</b>: ${steps.map((s) => esc(stepText(s))).join('; ')}`,
            )
            .join('<br>') || '<span class="soft">a goal ends here</span>'
        }</td><td>${button(row.frame)}</td></tr>`,
    )
    .join('');
  const reads = Object.entries(t?.reads ?? {})
    .map(
      ([what, v]) =>
        `<li>${esc(what)}: ${[v]
          .flat()
          .map((x) => `<code>${esc(x)}</code>`)
          .join(', ')}</li>`,
    )
    .join('');
  const names = Object.entries(t?.names ?? {})
    .map(
      ([listed, drawn]) =>
        `<li>"${esc(listed)}" is drawn ${drawn.map((d) => `"${esc(d)}"`).join(' or ')}</li>`,
    )
    .join('');
  const answers = (t?.answers ?? [])
    .map((a) => `<li>"${esc(a.says)}" means <code>${esc(a.code)}</code> ${button(a.frame)}</li>`)
    .join('');
  const check = (r.check ?? [])
    .map(
      (c) =>
        `<li>${c.hazard ? `with ${esc(c.hazard)} forced` : 'plain'}: <span class="pill ${c.ok ? 'succeeded' : 'failed'}">${c.ok ? 'passed' : 'failed'}</span> ${esc(c.said)}</li>`,
    )
    .join('');
  const open = r.status === 'open' && mayAct(who);
  const at = (a: Action) => `/recommendations/${encodeURIComponent(r.id)}/${a}`;
  const reason = `<input name="reason" minlength="10" required aria-label="Reason" placeholder="Why (at least ten characters)">`;
  const decide =
    r.status !== 'open'
      ? `<p><span class="pill ${r.status === 'approved' ? 'succeeded' : 'failed'}">${esc(r.status)}</span>${r.decidedBy ? ` by ${esc(r.decidedBy)} at ${when(r.decidedAt!)}: ${esc(r.reason)}` : ''}</p>`
      : !open
        ? '<p class="soft">An admin decides here.</p>'
        : `<form method="post" action="${at('approve')}" class="row">${reason}<button>Approve</button></form><details><summary>Reject the table</summary><form method="post" action="${at('reject')}" class="row">${reason}<button class="quiet">Reject</button></form></details>`;
  return `<section class="card"><h2>${esc(r.tenant)} · <a href="/runs/${esc(r.factoryRunId)}"><code>${esc(r.factoryRunId)}</code></a> · ${when(r.createdAt)}</h2>
<p>The gate's runs:</p><ul>${check || '<li class="soft">none</li>'}</ul>
<table><tr><th>#</th><th>Page</th><th>Shown by</th><th>Steps</th><th>Evidence</th></tr>${rows}</table>
${reads ? `<p>Values are read as:</p><ul>${reads}</ul>` : ''}${names ? `<p>The guard knows these controls by the bank's words:</p><ul>${names}</ul>` : ''}${answers ? `<p>The bank's answers:</p><ul>${answers}</ul>` : ''}${t?.submit?.press ? `<p>The transfer is sent by "${esc(t.submit.press)}", pressed only under a person's approval of each transfer. ${button(t.submit.frame)}</p>` : ''}${decide}</section>`;
}

export function recommendationPages(app: FastifyInstance, deps: RecommendationDeps) {
  app.get<{ Querystring: { done?: string; error?: string } }>(
    '/recommendations',
    async (req, reply) => {
      const who = deps.whoIs(req);
      if (!who) return reply.redirect('/admin/login');
      const rows = (
        await deps.sql.query<Row>(
          `SELECT id, "factoryRunId", tenant, "table", "check", status, "createdAt", "decidedBy", "decidedAt", reason
             FROM "Recommendation" ORDER BY (status = 'open') DESC, "createdAt" DESC LIMIT 50`,
        )
      ).rows;
      const cards = (await Promise.all(rows.map((r) => card(deps.sql, r, who)))).join('');
      const q = req.query;
      const note =
        q.done && q.done in NOTICE
          ? `<p class="note ok">${esc(NOTICE[q.done as Action])}</p>`
          : q.error
            ? `<p class="note bad">${esc(q.error)}</p>`
            : '';
      return reply.type('text/html; charset=utf-8').send(
        page(
          'Recommendations',
          `<h1>Recommendations</h1>${note}${cards ? cards + FRAMES_POPUP : '<p class="empty">The factory has recommended nothing yet.</p>'}`,
          {
            active: '/recommendations',
            admin: who.email,
            waiting: await waitingTooLong(deps.sql),
          },
        ),
      );
    },
  );

  void app.register(async (scope) => {
    if (!scope.hasContentTypeParser('application/x-www-form-urlencoded'))
      await scope.register(formbody);
    scope.post<{ Params: { id: string; action: string } }>(
      '/recommendations/:id/:action',
      async (req, reply) => {
        const fromForm = (req.headers['content-type'] ?? '').startsWith(
          'application/x-www-form-urlencoded',
        );
        const fail = (status: number, code: string, reason: string) =>
          fromForm
            ? reply.redirect(`/recommendations?error=${encodeURIComponent(reason)}`, 303)
            : reply
                .code(status)
                .type('application/problem+json')
                .send(problem(status, code, reason));
        const who = deps.whoIs(req);
        if (!who) return fail(401, 'not_signed_in', 'sign in first');
        if (!mayAct(who)) return fail(403, 'insufficient_role', 'only an admin decides');
        const action = req.params.action as Action;
        if (!ACTIONS.includes(action)) return fail(404, 'not_found', 'there is no such action');
        const body = (req.body ?? {}) as { reason?: unknown };
        const reason = String(body.reason ?? '').trim();
        if (reason.length < 10)
          return fail(400, 'invalid_input', 'a reason of at least ten characters');
        const r = (
          await deps.sql.query<Pick<Row, 'table' | 'status' | 'tenant' | 'factoryRunId'>>(
            'SELECT "table", status, tenant, "factoryRunId" FROM "Recommendation" WHERE id = $1',
            [req.params.id],
          )
        ).rows[0];
        if (!r || r.status !== 'open' || !r.table)
          return fail(409, 'conflict', 'there is no such recommendation, or it is decided');
        const status = action === 'approve' ? 'approved' : 'rejected';
        const done = await deps.sql.query(
          `UPDATE "Recommendation" SET status = $2, "decidedBy" = $3, "decidedAt" = now(), reason = $4
            WHERE id = $1 AND status = 'open' RETURNING id`,
          [req.params.id, status, who.email, reason],
        );
        if (!done.rows.length)
          return fail(409, 'conflict', 'there is no such recommendation, or it is decided');
        if (action === 'approve')
          await promoteTable(deps.sql, {
            tenant: r.tenant,
            table: r.table,
            factoryRunId: r.factoryRunId,
            by: who.email,
            reason,
          });
        await deps.sql.query(
          `INSERT INTO "AuditEntry" (id, actor, action, target, reason) VALUES ($1, $2, $3, $4, $5)`,
          [
            `a_${randomBytes(8).toString('hex')}`,
            who.email,
            `recommendation.${action}`,
            req.params.id,
            reason,
          ],
        );
        return fromForm
          ? reply.redirect(`/recommendations?done=${action}`, 303)
          : reply.send({ ok: true, status });
      },
    );
  });
}
