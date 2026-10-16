// Recommendations (plan, §7): the bank's profile as the Supervisor drafted it from a factory
// run's frames. The review card shows each claim, whether it was seen on its frames or is a guess,
// and a Frames button that opens the frames it cites. A person approves or rejects it with a
// written reason that goes to the audit. A guess is never approved by default: approving a
// recommendation with guesses needs each guess ticked. Deciding is also an API call
// (`POST /recommendations/:id/:action`), so tests take the same path a person does.
import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { problem } from '@gb/contracts';
import { waitingTooLong } from './inbox.js';
import { esc, page, type Sql, type Viewer } from './layout.js';
import { FRAMES_POPUP, framesButton, framesOf } from './runs.js';

export interface RecommendationDeps {
  sql: Sql;
  whoIs(req: FastifyRequest): Viewer | null;
}

/** A claim as the Supervisor's recommend tool kept it. */
interface Claim {
  about: string;
  value: string;
  basis: 'seen' | 'guess';
  /** Frames of the run, such as f3. */
  frames: string[];
}

interface Row {
  id: string;
  factoryRunId: string;
  tenant: string;
  claims: Claim[];
  status: string;
  createdAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
}

const when = (d: Date) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

/** Only approvers and admins decide; a viewer reads. */
const mayAct = (v: Viewer) => v.role === 'approver' || v.role === 'admin';

const ACTIONS = ['approve', 'reject'] as const;
type Action = (typeof ACTIONS)[number];

const NOTICE: Record<Action, string> = {
  approve: 'Approved, every guess in it ticked.',
  reject: 'Rejected: the profile is not used.',
};

const BADGE = {
  seen: '<span class="pill seen">seen</span>',
  guess: '<span class="pill guess">guess</span>',
};

/** One recommendation as its review card. */
async function card(sql: Sql, r: Row, who: Viewer): Promise<string> {
  const frames = await framesOf(sql, r.factoryRunId);
  const open = r.status === 'open' && mayAct(who);
  const form = `approve-${r.id}`;
  const claims = r.claims
    .map((c, i) => {
      const cited = new Set(c.frames.map((f) => Number(f.slice(1))));
      const shown = frames.filter((f) => cited.has(f.seq));
      const tick =
        c.basis === 'guess' && open
          ? `<label class="tick"><input type="checkbox" name="tick" value="${i + 1}" form="${esc(form)}"> I accept this guess</label>`
          : '';
      return `<tr><td>${i + 1}</td><td><code>${esc(c.about)}</code></td><td>${esc(c.value)}</td><td>${BADGE[c.basis]}</td><td>${shown.length ? framesButton(r.factoryRunId, shown) : '<span class="soft">none</span>'}</td><td>${tick}</td></tr>`;
    })
    .join('');
  const at = (a: Action) => `/recommendations/${encodeURIComponent(r.id)}/${a}`;
  const reason = `<input name="reason" minlength="10" required aria-label="Reason" placeholder="Why (at least ten characters)">`;
  const guesses = r.claims.filter((c) => c.basis === 'guess').length;
  const decide =
    r.status !== 'open'
      ? `<p><span class="pill ${r.status === 'approved' ? 'succeeded' : 'failed'}">${esc(r.status)}</span> by ${esc(r.decidedBy)} at ${when(r.decidedAt!)}: ${esc(r.reason)}</p>`
      : !mayAct(who)
        ? '<p class="soft">Approvers decide here.</p>'
        : `${guesses ? `<p class="soft">${guesses === 1 ? 'One claim is a guess' : `${guesses} claims are guesses`}: approving needs each guess ticked.</p>` : ''}<form id="${esc(form)}" method="post" action="${at('approve')}" class="row">${reason}<button>Approve</button></form><details><summary>Reject the recommendation</summary><form method="post" action="${at('reject')}" class="row">${reason}<button class="quiet">Reject</button></form></details>`;
  return `<section class="card"><h2>${esc(r.tenant)} · <a href="/runs/${esc(r.factoryRunId)}"><code>${esc(r.factoryRunId)}</code></a> · ${when(r.createdAt)}</h2>
<table><tr><th>#</th><th>About</th><th>Claim</th><th>Basis</th><th>Evidence</th><th></th></tr>${claims}</table>${decide}</section>`;
}

export function recommendationPages(app: FastifyInstance, deps: RecommendationDeps) {
  app.get<{ Querystring: { done?: string; error?: string } }>(
    '/recommendations',
    async (req, reply) => {
      const who = deps.whoIs(req);
      if (!who) return reply.redirect('/admin/login');
      const rows = (
        await deps.sql.query<Row>(
          `SELECT id, "factoryRunId", tenant, claims, status, "createdAt", "decidedBy", "decidedAt", reason
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
          `<h1>Recommendations</h1>${note}${cards ? cards + FRAMES_POPUP : '<p class="empty">The Supervisor has recommended nothing yet.</p>'}`,
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
        if (!mayAct(who)) return fail(403, 'insufficient_role', 'only approvers decide');
        const action = req.params.action as Action;
        if (!ACTIONS.includes(action)) return fail(404, 'not_found', 'there is no such action');
        const body = (req.body ?? {}) as { reason?: unknown; tick?: unknown };
        const reason = String(body.reason ?? '').trim();
        if (reason.length < 10)
          return fail(400, 'invalid_input', 'a reason of at least ten characters');
        const r = (
          await deps.sql.query<Pick<Row, 'claims' | 'status'>>(
            'SELECT claims, status FROM "Recommendation" WHERE id = $1',
            [req.params.id],
          )
        ).rows[0];
        if (!r || r.status !== 'open')
          return fail(409, 'conflict', 'there is no such recommendation, or it is decided');
        if (action === 'approve') {
          // Each guess, by its claim's number, ticked by the person approving.
          const ticked = new Set([body.tick ?? []].flat().map(Number));
          const unticked = r.claims.flatMap((c, i) =>
            c.basis === 'guess' && !ticked.has(i + 1) ? [`${i + 1} (${c.about})`] : [],
          );
          if (unticked.length)
            return fail(
              400,
              'invalid_input',
              `a guess is approved only when it is ticked; not ticked: claim ${unticked.join(', ')}`,
            );
        }
        const status = action === 'approve' ? 'approved' : 'rejected';
        const done = await deps.sql.query(
          `UPDATE "Recommendation" SET status = $2, "decidedBy" = $3, "decidedAt" = now(), reason = $4
            WHERE id = $1 AND status = 'open' RETURNING id`,
          [req.params.id, status, who.email, reason],
        );
        if (!done.rows.length)
          return fail(409, 'conflict', 'there is no such recommendation, or it is decided');
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
