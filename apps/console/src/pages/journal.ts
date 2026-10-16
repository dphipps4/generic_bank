// The journal, in the Console (plan, §2): every intended and performed action, newest first, and
// a button that walks every chain and says where, if anywhere, it breaks. Read-only: nothing in the
// journal can be changed from here.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyJournal } from '@gb/runs';
import { waitingTooLong } from './inbox.js';
import { esc, page, type Sql, type Viewer } from './layout.js';

export interface JournalDeps {
  sql: Sql;
  whoIs(req: FastifyRequest): Viewer | null;
}

const when = (d: Date) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

export function journalPages(app: FastifyInstance, deps: JournalDeps) {
  app.get<{ Querystring: { verified?: string } }>('/journal', async (req, reply) => {
    const who = deps.whoIs(req);
    if (!who) return reply.redirect('/admin/login');
    const rows = (
      await deps.sql.query<{
        runId: string;
        seq: number;
        intent: string;
        action: string | null;
        result: string | null;
        rowHash: string;
        at: Date;
      }>(
        `SELECT "runId", seq, intent, action, result, "rowHash", at FROM "JournalEntry"
          ORDER BY at DESC, seq DESC LIMIT 200`,
      )
    ).rows;
    const verdict = req.query.verified ? await verifyJournal(deps.sql) : null;
    const note = !verdict
      ? ''
      : verdict.ok
        ? `<p class="note ok">Every chain is whole: ${verdict.runs} ${verdict.runs === 1 ? 'run' : 'runs'}, ${verdict.entries} ${verdict.entries === 1 ? 'entry' : 'entries'}.</p>`
        : `<p class="note bad">The chain breaks in run <a href="/runs/${esc(verdict.runId)}"><code>${esc(verdict.runId)}</code></a> at entry ${verdict.seq}: ${esc(verdict.reason)}.</p>`;
    const body = rows
      .map(
        (r) =>
          `<tr><td>${when(r.at)}</td><td><a href="/runs/${esc(r.runId)}"><code>${esc(r.runId)}</code></a> #${r.seq}</td><td>${esc(r.intent)}</td><td>${esc(r.action ?? '')}</td><td>${esc(r.result ?? '')}</td><td><code>${esc(r.rowHash.slice(0, 12))}</code></td></tr>`,
      )
      .join('');
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Journal',
          `<h1>Journal</h1>${note}<form method="get" action="/journal" class="row"><input type="hidden" name="verified" value="1"><button>Verify every chain</button></form>${
            body
              ? `<table><tr><th>When (UTC)</th><th>Run</th><th>Intended</th><th>Done</th><th>Result</th><th>Hash</th></tr>${body}</table>`
              : '<p class="empty">Nothing has been journaled yet.</p>'
          }`,
          { active: '/journal', admin: who.email, waiting: await waitingTooLong(deps.sql) },
        ),
      );
  });
}
