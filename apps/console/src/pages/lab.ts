// The hazard lab (plan, §S.2): an admin picks a bank, a task, a member and any hazards, and starts a
// real run through the Task API, with the hazards forced on it. Every hazard is one click away, with
// the result it must give beside it. Those results are the outcome table's own (`OUTCOMES`), so the
// lab never promises what the tests do not prove. The page exists only on a stack whose banks obey
// forced hazards.
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  describeExpected,
  expectedFor,
  type HazardName,
  isHazard,
  OUTCOMES,
  type OutcomeTask,
} from '@gb/contracts';
import { type OAuth, TASK_SCOPES } from '@gb/oauth';
import { waitingTooLong } from './inbox.js';
import { esc, page, type Sql, type Viewer } from './layout.js';

export interface LabRun {
  task: OutcomeTask;
  input: Record<string, unknown>;
  hazards: HazardName[];
  /** The admin starting it, for the audit. */
  by: string;
}
export type Started = { ok: true; runId: string } | { ok: false; detail: string };

export interface LabDeps {
  sql: Sql;
  whoIs(req: FastifyRequest): Viewer | null;
  /** Starts the run through the Task API's lab door. */
  start(run: LabRun): Promise<Started>;
}

const TASK_NAMES: Record<OutcomeTask, string> = { 'check-balance': 'Check Balance' };

const outcome = (e: { status: string; code?: string | null } | null) =>
  e
    ? `<span class="pill ${esc(e.status)}">${esc(e.status.replace('_', ' '))}</span>${e.code ? ` <code>${esc(e.code)}</code>` : ''}`
    : '<span class="soft">no single expected result</span>';

const many = (v: unknown): string[] =>
  v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String);

export function labPages(app: FastifyInstance, deps: LabDeps) {
  app.get<{
    Querystring: { run?: string; task?: string; member?: string; hazards?: string; error?: string };
  }>('/lab', async (req, reply) => {
    const who = deps.whoIs(req);
    if (!who) return reply.redirect('/admin/login');
    const wrap = async (body: string) =>
      reply.type('text/html; charset=utf-8').send(
        page('Hazard lab', `<h1>Hazard lab</h1>${body}`, {
          active: '/lab',
          admin: who.email,
          waiting: await waitingTooLong(deps.sql),
        }),
      );
    if (who.role !== 'admin')
      return wrap('<p class="note bad">Only an admin starts runs in the hazard lab.</p>');

    const q = req.query;
    const banks = (
      await deps.sql.query<{ id: string; brand: string }>(
        'SELECT id, brand FROM "Bank" ORDER BY position, id',
      )
    ).rows;
    const task: OutcomeTask = 'check-balance';
    const o = OUTCOMES[task];

    let note = q.error ? `<p class="note bad">${esc(q.error)}</p>` : '';
    if (q.run) {
      const m = o.members[Number(q.member)] ?? o.members[0]!;
      const forced = (q.hazards ?? '').split(',').filter(isHazard);
      const e = expectedFor(task, m, forced);
      note = `<p class="note ok">Started run <a href="/runs/${esc(q.run)}"><code>${esc(q.run)}</code></a>: ${esc(m.name.toLowerCase())}, ${forced.length ? `forced <code>${forced.map(esc).join('</code>, <code>')}</code>` : 'nothing forced'}. Expected: <b>${e ? esc(describeExpected(e)) : 'no single result'}</b>. Its staff code is asked for in the <a href="/inbox">Inbox</a>.</p>`;
    }

    const bankPick = banks
      .map(
        (b) =>
          `<option value="${esc(b.id)}"${b.id === 'generic' ? ' selected' : ''}>${esc(b.brand)} (${esc(b.id)})</option>`,
      )
      .join('');
    const members = o.members
      .map(
        (m, i) =>
          `<tr><td><input type="radio" name="member" value="${i}" id="m${i}"${i === 0 ? ' checked' : ''}></td><td><label for="m${i}">${esc(m.name)}</label><br><small class="soft">member <code>${esc(m.memberId)}</code>, account <code>${esc(m.account)}</code></small></td><td>${outcome(m.expected)}</td></tr>`,
      )
      .join('');
    const hazards = o.hazards
      .map(
        (h) =>
          `<tr data-hazard="${esc(h.hazard)}"><td><input type="checkbox" name="hazards" value="${esc(h.hazard)}" id="h-${esc(h.hazard)}"></td><td><label for="h-${esc(h.hazard)}"><code>${esc(h.hazard)}</code></label></td><td>${esc(h.does)}</td><td>${outcome(h.expected)}</td></tr>`,
      )
      .join('');
    const recent = (
      await deps.sql.query<{
        id: string;
        task: string;
        bank: string;
        status: string;
        resultCode: string | null;
        forced: string[];
      }>(
        `SELECT id, task, bank, status, "resultCode", "inputsMasked"->'forcedHazards' AS forced
           FROM "TaskRun" WHERE "inputsMasked" ? 'forcedHazards'
          ORDER BY "startedAt" DESC LIMIT 15`,
      )
    ).rows
      .map(
        (r) =>
          `<tr><td><a href="/runs/${esc(r.id)}"><code>${esc(r.id)}</code></a></td><td>${esc(r.task)} on ${esc(r.bank)}</td><td>${r.forced.length ? r.forced.map((h) => `<code>${esc(h)}</code>`).join(' ') : '<span class="soft">none</span>'}</td><td>${outcome({ status: r.status, code: r.resultCode })}</td></tr>`,
      )
      .join('');

    return wrap(`${note}<p class="soft">Each result beside a hazard is the one the outcome table proves on Generic Bank, with the hazard forced alone on the healthy member. Forced hazards reach the bank in a header signed by the Runner.</p>
<form method="post" action="/lab">
<h2>Bank and task</h2>
<div class="row"><select name="bank" aria-label="Bank">${bankPick}</select> <select name="task" aria-label="Task">${(Object.keys(OUTCOMES) as OutcomeTask[]).map((t) => `<option value="${t}">${TASK_NAMES[t]}</option>`).join('')}</select></div>
<h2>Member</h2>
<table><tr><th></th><th>Member</th><th>Expected with nothing forced</th></tr>${members}</table>
<h2>Hazards</h2>
<table><tr><th></th><th>Hazard</th><th>What the bank does</th><th>Expected, forced alone</th></tr>${hazards}</table>
<p><button>Start the run</button></p>
</form>
<h2>Recent lab runs</h2>
${recent ? `<table><tr><th>Run</th><th>Task</th><th>Forced</th><th>Result</th></tr>${recent}</table>` : '<p class="empty">No lab runs yet.</p>'}`);
  });

  void app.register(async (scope) => {
    if (!scope.hasContentTypeParser('application/x-www-form-urlencoded'))
      await scope.register(formbody);
    scope.post('/lab', async (req, reply) => {
      const who = deps.whoIs(req);
      if (!who) return reply.redirect('/admin/login', 303);
      const back = (error: string) =>
        reply.redirect(`/lab?error=${encodeURIComponent(error)}`, 303);
      if (who.role !== 'admin') return back('Only an admin starts runs in the hazard lab.');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const task = String(b.task ?? 'check-balance');
      if (!(task in OUTCOMES)) return back('The lab has no expected results for that task.');
      const o = OUTCOMES[task as OutcomeTask];
      const i = Number(b.member ?? 0);
      const member = o.members[i];
      const hazards = many(b.hazards);
      if (!member) return back('Choose a member.');
      if (!hazards.every(isHazard)) return back('That is not a hazard the bank knows.');
      const r = await deps.start({
        task: task as OutcomeTask,
        input: {
          bank: String(b.bank ?? 'generic'),
          memberId: member.memberId,
          account: member.account,
        },
        hazards,
        by: who.email,
      });
      if (!r.ok) return back(r.detail);
      return reply.redirect(
        `/lab?run=${encodeURIComponent(r.runId)}&member=${i}&hazards=${encodeURIComponent(hazards.join(','))}`,
        303,
      );
    });
  });
}

/** The lab's own API client, created on first use; each run gets a fresh token issued to the admin. */
export function throughTheApi(deps: {
  sql: Sql;
  tokens: Pick<OAuth, 'createClient' | 'issueDirect'>;
  apiUrl: string;
}): LabDeps['start'] {
  const NAME = 'Hazard lab (Console)';
  return async (run) => {
    const found = await deps.sql.query<{ clientId: string }>(
      'SELECT "clientId" FROM "ApiClient" WHERE name = $1 AND "revokedAt" IS NULL LIMIT 1',
      [NAME],
    );
    const clientId =
      found.rows[0]?.clientId ??
      (await deps.tokens.createClient({ name: NAME, scopes: [...TASK_SCOPES], createdBy: run.by }))
        .clientId;
    const token = (await deps.tokens.issueDirect(clientId, run.by)).access_token;
    let r: Response;
    try {
      r = await fetch(new URL('/lab/runs', deps.apiUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ task: run.task, input: run.input, hazards: run.hazards }),
      });
    } catch {
      return { ok: false, detail: 'The Task API did not answer.' };
    }
    const body = (await r.json().catch(() => ({}))) as { runId?: string; detail?: string };
    if (r.status === 202 && body.runId) return { ok: true, runId: body.runId };
    return {
      ok: false,
      detail:
        r.status === 404 && !body.detail
          ? 'The Task API has no hazard lab: its HAZARDS_FORCEABLE is not true.'
          : (body.detail ?? `The Task API answered ${r.status}.`),
    };
  };
}
