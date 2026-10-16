// Freezes (plan, §G.2, §J.2): a guard trip freezes its bank, and nothing runs there until a person
// clears the freeze here, with a written reason that goes to the audit. Newest first. Clearing is
// also an API call (`POST /freezes/:id/clear`), so tests take the same path a person does.
import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { problem } from '@gb/contracts';
import { waitingTooLong } from './inbox.js';
import { esc, page, type Sql, type Viewer } from './layout.js';

export interface FreezeDeps {
  sql: Sql;
  whoIs(req: FastifyRequest): Viewer | null;
}

const when = (d: Date) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

/** A guard trip is a safety matter: only an admin lets a bank run again. */
const mayClear = (v: Viewer) => v.role === 'admin';

export function freezePages(app: FastifyInstance, deps: FreezeDeps) {
  app.get<{ Querystring: { done?: string; error?: string } }>('/freezes', async (req, reply) => {
    const who = deps.whoIs(req);
    if (!who) return reply.redirect('/admin/login');
    const rows = (
      await deps.sql.query<{
        id: string;
        tenant: string;
        layer: string;
        runId: string | null;
        reason: string;
        frozenAt: Date;
        clearedAt: Date | null;
        clearedBy: string | null;
      }>(
        `SELECT id, tenant, layer, "runId", reason, "frozenAt", "clearedAt", "clearedBy" FROM "Freeze"
          ORDER BY "frozenAt" DESC LIMIT 200`,
      )
    ).rows;
    const cleared = (r: (typeof rows)[number]) =>
      r.clearedAt
        ? `${when(r.clearedAt)}<br><small>${esc(r.clearedBy ?? '')}</small>`
        : mayClear(who)
          ? `<form method="post" action="/freezes/${encodeURIComponent(r.id)}/clear" class="row"><input name="reason" minlength="10" required aria-label="Reason" placeholder="Why (at least ten characters)"><button>Clear</button></form>`
          : '<span class="pill escalated">Frozen</span> <span class="soft">An admin clears it.</span>';
    const body = rows
      .map(
        (r) =>
          `<tr><td>${when(r.frozenAt)}</td><td>${esc(r.tenant)}</td><td>${esc(r.layer)}</td><td>${r.runId ? `<a href="/runs/${esc(r.runId)}"><code>${esc(r.runId)}</code></a>` : ''}</td><td>${esc(r.reason)}</td><td>${cleared(r)}</td></tr>`,
      )
      .join('');
    const q = req.query;
    const note = q.done
      ? '<p class="note ok">Cleared: the bank runs tasks again.</p>'
      : q.error
        ? `<p class="note bad">${esc(q.error)}</p>`
        : '';
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Freezes',
          `<h1>Freezes</h1>${note}${
            body
              ? `<table><tr><th>Frozen (UTC)</th><th>Bank</th><th>Layer</th><th>Run</th><th>Reason</th><th>Cleared</th></tr>${body}</table>`
              : '<p class="empty">No bank has been frozen.</p>'
          }`,
          { active: '/freezes', admin: who.email, waiting: await waitingTooLong(deps.sql) },
        ),
      );
  });

  void app.register(async (scope) => {
    if (!scope.hasContentTypeParser('application/x-www-form-urlencoded'))
      await scope.register(formbody);
    scope.post<{ Params: { id: string } }>('/freezes/:id/clear', async (req, reply) => {
      const fromForm = (req.headers['content-type'] ?? '').startsWith(
        'application/x-www-form-urlencoded',
      );
      const fail = (status: number, code: string, reason: string) =>
        fromForm
          ? reply.redirect(`/freezes?error=${encodeURIComponent(reason)}`, 303)
          : reply
              .code(status)
              .type('application/problem+json')
              .send(problem(status, code, reason));
      const who = deps.whoIs(req);
      if (!who) return fail(401, 'not_signed_in', 'sign in first');
      if (!mayClear(who)) return fail(403, 'insufficient_role', 'only an admin clears a freeze');
      const reason = String((req.body as { reason?: unknown } | null)?.reason ?? '').trim();
      if (reason.length < 10)
        return fail(400, 'invalid_input', 'a reason of at least ten characters');
      const r = await deps.sql.query(
        `UPDATE "Freeze" SET "clearedAt" = now(), "clearedBy" = $2 WHERE id = $1 AND "clearedAt" IS NULL RETURNING id`,
        [req.params.id, who.email],
      );
      if (!r.rows.length) return fail(409, 'conflict', 'there is no such freeze, or it is cleared');
      await deps.sql.query(
        `INSERT INTO "AuditEntry" (id, actor, action, target, reason) VALUES ($1, $2, 'freeze.clear', $3, $4)`,
        [`a_${randomBytes(8).toString('hex')}`, who.email, req.params.id, reason],
      );
      return fromForm ? reply.redirect('/freezes?done=clear', 303) : reply.send({ ok: true });
    });
  });
}
