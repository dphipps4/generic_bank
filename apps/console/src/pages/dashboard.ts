// The Dashboard: where a person lands after signing in. What waits for a person, which banks are
// frozen, what each bank serves, the latest runs, and the pages and tools a person reaches next.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { waitingTooLong } from './inbox.js';
import { esc, inNav, page, type Sql, type Viewer } from './layout.js';

export interface DashboardDeps {
  sql: Sql;
  whoIs(req: FastifyRequest): Viewer | null;
  /** The host ports of the Task API and the staff inbox, for links a browser can follow. */
  apiPort: number;
  inboxPort: number;
}

const when = (d: Date) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

const KIND: Record<string, string> = {
  staff_code: 'Staff codes',
  approval: 'Approvals',
  supervisor_code: 'Supervisor codes',
  escalation: 'Escalations',
};

/**
 * The root and AdminJS's own dashboard (its demo page, where signing in lands) both go to the
 * Dashboard. Every /admin/resources page is AdminJS's as before.
 */
export function landOnDashboard(app: FastifyInstance) {
  app.get('/', async (_req, reply) => reply.redirect('/dashboard'));
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && (path === '/admin' || path === '/admin/'))
      return reply.redirect('/dashboard');
  });
}

export function dashboardPages(app: FastifyInstance, deps: DashboardDeps) {
  app.get('/dashboard', async (req, reply) => {
    const who = deps.whoIs(req);
    if (!who) return reply.redirect('/admin/login');
    const q = <R>(text: string) => deps.sql.query<R>(text).then((r) => r.rows);
    const [waiting, frozen, banks, served, repairs, runs, today, recs] = await Promise.all([
      q<{ kind: string; n: number }>(
        `SELECT kind, count(*)::int AS n FROM "HumanTask" WHERE status = 'open' GROUP BY kind`,
      ),
      q<{ tenant: string; frozenAt: Date; reason: string }>(
        `SELECT tenant, "frozenAt", reason FROM "Freeze" WHERE "clearedAt" IS NULL ORDER BY "frozenAt" DESC`,
      ),
      q<{ id: string; brand: string }>(`SELECT id, brand FROM "Bank" ORDER BY position, id`),
      q<{ tenant: string; task: string }>(
        `SELECT tenant, task FROM "Driver" WHERE state = 'promoted' ORDER BY task`,
      ),
      q<{ tenant: string; n: number }>(
        `SELECT tenant, count(*)::int AS n FROM "RepairCase" WHERE status = 'open' GROUP BY tenant`,
      ),
      q<{
        id: string;
        task: string;
        bank: string;
        status: string;
        resultCode: string | null;
        startedAt: Date;
      }>(
        `SELECT id, task, bank, status, "resultCode", "startedAt" FROM "TaskRun" ORDER BY "startedAt" DESC LIMIT 10`,
      ),
      q<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM "TaskRun" WHERE "startedAt" > now() - interval '24 hours' GROUP BY status ORDER BY status`,
      ),
      q<{ n: number }>(`SELECT count(*)::int AS n FROM "Recommendation" WHERE status = 'open'`),
    ]);

    const open = waiting.reduce((a, r) => a + r.n, 0);
    const reviews = recs[0]?.n ?? 0;
    const fact = (label: string, value: string, href?: string) =>
      `<div class="fact"><span>${label}</span>${href ? `<a href="${href}">${value}</a>` : value}</div>`;
    const facts = `<div class="facts">${[
      fact(
        'Waiting for a person',
        open
          ? waiting.map((w) => `${w.n} ${esc(KIND[w.kind] ?? w.kind).toLowerCase()}`).join(', ')
          : 'nothing',
        '/inbox',
      ),
      fact('Frozen banks', frozen.length ? String(frozen.length) : 'none', '/freezes'),
      fact('Recommendations to review', reviews ? String(reviews) : 'none', '/recommendations'),
      fact(
        'Runs in the last 24 hours',
        today.length
          ? today
              .map((t) => `${t.n} <span class="pill ${esc(t.status)}">${esc(t.status)}</span>`)
              .join(' ')
          : 'none',
        '/runs',
      ),
    ].join('')}</div>`;

    const frozenAt = new Map(frozen.map((f) => [f.tenant, f]));
    const bankRows = banks
      .map((b) => {
        const tasks = served.filter((s) => s.tenant === b.id).map((s) => esc(s.task));
        const f = frozenAt.get(b.id);
        const repair = repairs.find((r) => r.tenant === b.id)?.n ?? 0;
        return `<tr><td><b>${esc(b.brand)}</b> <span class="soft">${esc(b.id)}</span></td><td>${
          f
            ? `<span class="pill escalated">frozen</span> <span class="soft">${esc(f.reason)}</span>`
            : tasks.length
              ? tasks.join(', ')
              : '<span class="soft">none yet</span>'
        }</td><td>${repair ? `${repair} open` : ''}</td></tr>`;
      })
      .join('');

    const runRows = runs
      .map(
        (r) =>
          `<tr><td>${when(r.startedAt)}</td><td>${esc(r.bank)}</td><td>${esc(r.task)}</td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span> ${r.resultCode ? `<code>${esc(r.resultCode)}</code>` : ''}</td><td><a href="/runs/${encodeURIComponent(r.id)}"><code>${esc(r.id)}</code></a></td></tr>`,
      )
      .join('');

    // Links a browser follows from this machine: the host it reached the Console by, other ports.
    const host = String(req.headers.host ?? 'localhost').replace(/:\d+$/, '');
    const shortcuts = [
      `<a href="http://${esc(host)}:${deps.apiPort}/docs">Task API (Swagger UI)</a>`,
      `<a href="http://${esc(host)}:${deps.inboxPort}">Staff inbox (sign-in codes)</a>`,
      ...(inNav('/lab') ? ['<a href="/lab">Hazard lab</a>'] : []),
      '<a href="/admin/resources/TaskRun">Data (every table)</a>',
    ];

    return reply.type('text/html; charset=utf-8').send(
      page(
        'Dashboard',
        `<h1>Dashboard</h1>${facts}
<h2>Banks</h2><table><tr><th>Bank</th><th>Tasks it serves</th><th>Repairs</th></tr>${bankRows}</table>
<h2>Latest runs</h2>${
          runRows
            ? `<table><tr><th>Started (UTC)</th><th>Bank</th><th>Task</th><th>Result</th><th>Run</th></tr>${runRows}</table>`
            : '<p class="empty">No runs yet. ACCESS.md has a curl to start one.</p>'
        }
<h2>Shortcuts</h2><p>${shortcuts.join(' · ')}</p>`,
        { active: '/dashboard', admin: who.email, waiting: await waitingTooLong(deps.sql) },
      ),
    );
  });
}
