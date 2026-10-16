// Runs, in the Console: the list, and one run screen by screen, with its steps, its human tasks and
// its masked frames (plan, §9). Nothing here is unmasked: the frames were masked before they were
// stored, and the inputs were stored masked.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FrameStore } from '@gb/evidence';
import { messageFor, type ResultCode } from '@gb/contracts';
import { waitingTooLong } from './inbox.js';
import { esc, page, type Sql, type Viewer } from './layout.js';

export type { Sql, Viewer };

export interface PagesDeps {
  sql: Sql;
  store: FrameStore;
  /** The signed-in person, or null: the same sign-in as AdminJS. */
  whoIs(req: FastifyRequest): Viewer | null;
}

const when = (d: Date | string | null) =>
  d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '';
const pill = (s: string) => `<span class="pill ${esc(s)}">${esc(s.replace('_', ' '))}</span>`;

export function runPages(app: FastifyInstance, deps: PagesDeps) {
  const signedIn = (req: FastifyRequest, reply: FastifyReply) => {
    const who = deps.whoIs(req);
    if (!who) {
      void reply.redirect('/admin/login');
      return null;
    }
    return who.email;
  };

  app.get('/runs', async (req, reply) => {
    const who = signedIn(req, reply);
    if (!who) return;
    const r = await deps.sql.query<{
      id: string;
      task: string;
      bank: string;
      status: string;
      resultCode: string | null;
      startedAt: Date;
      settledAt: Date | null;
      steps: number;
    }>(
      `SELECT r.id, r.task, r.bank, r.status, r."resultCode", r."startedAt", r."settledAt",
              (SELECT count(*)::int FROM "Step" s WHERE s."runId" = r.id) AS steps
         FROM "TaskRun" r ORDER BY r."startedAt" DESC LIMIT 100`,
    );
    const rows = r.rows
      .map(
        (x) =>
          `<tr><td><a href="/runs/${esc(x.id)}"><code>${esc(x.id)}</code></a></td><td>${esc(x.task)}</td><td>${esc(x.bank)}</td><td>${pill(x.status)} ${x.resultCode ? `<code>${esc(x.resultCode)}</code>` : ''}</td><td>${x.steps}</td><td>${when(x.startedAt)}</td><td>${x.settledAt ? `${Math.round((new Date(x.settledAt).getTime() - new Date(x.startedAt).getTime()) / 1000)} s` : ''}</td></tr>`,
      )
      .join('');
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Runs',
          `<h1>Runs</h1>${rows ? `<table><tr><th>Run</th><th>Task</th><th>Bank</th><th>Result</th><th>Steps</th><th>Started (UTC)</th><th>Took</th></tr>${rows}</table>` : '<p class="empty">No runs yet.</p>'}`,
          { active: '/runs', admin: who, waiting: await waitingTooLong(deps.sql) },
        ),
      );
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const who = signedIn(req, reply);
    if (!who) return;
    const run = (
      await deps.sql.query<{
        id: string;
        task: string;
        bank: string;
        status: string;
        resultCode: string | null;
        retryable: boolean | null;
        inputsMasked: unknown;
        startedAt: Date;
        settledAt: Date | null;
        clientId: string | null;
      }>(
        'SELECT id, task, bank, status, "resultCode", retryable, "inputsMasked", "startedAt", "settledAt", "clientId" FROM "TaskRun" WHERE id = $1',
        [req.params.id],
      )
    ).rows[0];
    if (!run)
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(page('No such run', '<h1>No such run</h1>', { admin: who }));
    const steps = (
      await deps.sql.query<{
        seq: number;
        name: string;
        screen: string | null;
        action: string | null;
        outcome: string | null;
        ms: number | null;
      }>(
        'SELECT seq, name, screen, action, outcome, ms FROM "Step" WHERE "runId" = $1 ORDER BY seq',
        [run.id],
      )
    ).rows;
    const frames = (
      await deps.sql.query<{
        seq: number;
        stepSeq: number;
        imageKey: string | null;
        withheldReason: string | null;
        path: string;
        at: Date;
      }>(
        'SELECT seq, "stepSeq", "imageKey", "withheldReason", path, at FROM "TrailFrame" WHERE "runId" = $1 ORDER BY seq',
        [run.id],
      )
    ).rows;
    const tasks = (
      await deps.sql.query<{
        id: string;
        kind: string;
        status: string;
        openedAt: Date;
        answeredAt: Date | null;
        answeredBy: string | null;
      }>(
        'SELECT id, kind, status, "openedAt", "answeredAt", "answeredBy" FROM "HumanTask" WHERE "runId" = $1 ORDER BY "openedAt"',
        [run.id],
      )
    ).rows;
    const stepName = new Map(steps.map((s) => [s.seq, s]));
    const message = run.resultCode
      ? (() => {
          try {
            return messageFor(run.resultCode as ResultCode);
          } catch {
            return '';
          }
        })()
      : '';
    const facts = [
      ['Task', run.task],
      ['Bank', run.bank],
      [
        'Result',
        `${pill(run.status)}${run.resultCode ? ` <code>${esc(run.resultCode)}</code>` : ''}`,
      ],
      ['What the caller was told', esc(message) || '—'],
      ['Inputs (masked)', `<code>${esc(JSON.stringify(run.inputsMasked))}</code>`],
      ['Started (UTC)', when(run.startedAt)],
      ['Settled (UTC)', when(run.settledAt) || 'not yet'],
      ['API client', `<code>${esc(run.clientId ?? '')}</code>`],
    ]
      .map(
        ([k, v]) =>
          `<div class="fact"><span>${k}</span>${k === 'Result' || k === 'Inputs (masked)' || k === 'API client' ? v : esc(v)}</div>`,
      )
      .join('');
    const stepRows = steps
      .map(
        (s) =>
          `<tr><td>${s.seq}</td><td>${esc(s.name)}</td><td><code>${esc(s.screen ?? '')}</code></td><td>${esc(s.action ?? '')}</td><td>${esc(s.outcome ?? '')}</td><td>${s.ms ?? ''} ms</td></tr>`,
      )
      .join('');
    const taskRows = tasks
      .map(
        (t) =>
          `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.kind.replace('_', ' '))}</td><td>${pill(t.status)}</td><td>${when(t.openedAt)}</td><td>${t.answeredAt ? `${when(t.answeredAt)} by ${esc(t.answeredBy)}` : ''}</td></tr>`,
      )
      .join('');
    const frameList = frames.map((f) => {
      const st = stepName.get(f.stepSeq);
      return {
        seq: f.seq,
        image: f.imageKey !== null,
        withheld: f.withheldReason,
        caption: `${f.seq}. ${st?.name ?? ''}${st?.screen ? ` (${st.screen})` : ''} · ${f.path} · ${when(f.at)}`,
      };
    });
    return reply.type('text/html; charset=utf-8').send(
      page(
        `Run ${run.id}`,
        `<h1>Run <code>${esc(run.id)}</code></h1><div class="facts">${facts}</div>
<h2>Steps</h2>${stepRows ? `<table><tr><th>#</th><th>Step</th><th>Screen</th><th>Action</th><th>Outcome</th><th>Took</th></tr>${stepRows}</table>` : '<p class="empty">No steps yet.</p>'}
<h2>People asked</h2>${taskRows ? `<table><tr><th>Task</th><th>Kind</th><th>Status</th><th>Opened</th><th>Answered</th></tr>${taskRows}</table>` : '<p class="empty">Nobody was asked anything.</p>'}
<h2>Screens (masked)</h2>${frameList.length ? framesButton(run.id, frameList) + FRAMES_POPUP : '<p class="empty">No frames.</p>'}`,
        { active: '/runs', admin: who, waiting: await waitingTooLong(deps.sql) },
      ),
    );
  });

  // A frame's masked picture (.png) or masked screen model (.json), from the store; only for a
  // signed-in person.
  app.get<{ Params: { id: string; seq: string } }>('/runs/:id/frames/:seq', async (req, reply) => {
    if (!signedIn(req, reply)) return;
    const json = String(req.params.seq).endsWith('.json');
    const seq = Number(String(req.params.seq).replace(/\.(png|json)$/, ''));
    const f = (
      await deps.sql.query<{ imageKey: string | null; screenModelKey: string | null }>(
        'SELECT "imageKey", "screenModelKey" FROM "TrailFrame" WHERE "runId" = $1 AND seq = $2',
        [req.params.id, seq],
      )
    ).rows[0];
    const key = json ? f?.screenModelKey : f?.imageKey;
    const body = key ? await deps.store.get(key) : null;
    if (!body) return reply.code(404).send();
    return reply
      .header('cache-control', 'private, max-age=3600')
      .type(json ? 'application/json' : 'image/png')
      .send(body);
  });
}

/** A run's frames for the Frames button: one entry per frame, the picture loaded only when shown. */
export async function framesOf(sql: Sql, runId: string) {
  const rows = (
    await sql.query<{
      seq: number;
      imageKey: string | null;
      withheldReason: string | null;
      path: string;
      at: Date;
      name: string | null;
      screen: string | null;
    }>(
      `SELECT f.seq, f."imageKey", f."withheldReason", f.path, f.at, s.name, s.screen
         FROM "TrailFrame" f LEFT JOIN "Step" s ON s."runId" = f."runId" AND s.seq = f."stepSeq"
        WHERE f."runId" = $1 ORDER BY f.seq`,
      [runId],
    )
  ).rows;
  return rows.map((f) => ({
    seq: f.seq,
    image: f.imageKey !== null,
    withheld: f.withheldReason,
    caption: `${f.seq}. ${f.name ?? ''}${f.screen ? ` (${f.screen})` : ''} · ${f.path} · ${when(f.at)}`,
  }));
}

/** A button that opens a run's frames in the page's frames popup ({@link FRAMES_POPUP}). */
export function framesButton(
  runId: string,
  frames: { seq: number; image: boolean; withheld: string | null; caption: string }[],
): string {
  return `<button type="button" class="btn" onclick="openFrames(this)" data-base="/runs/${esc(runId)}/frames/" data-frames="${esc(JSON.stringify(frames))}">Frames (${frames.length})</button>`;
}

/**
 * The popup the Frames buttons open, once per page: one frame at a time, the masked picture, its
 * step and screen, and a link to the masked screen model. Only the frame on show is loaded.
 */
export const FRAMES_POPUP = `<dialog id="frames" class="frames-pop"><div class="bar"><button type="button" class="btn" onclick="stepFrame(-1)">&larr;</button><span id="frame-cap"></span><button type="button" class="btn" onclick="stepFrame(1)">&rarr;</button><a id="frame-json" target="_blank">screen model</a><button type="button" class="btn" onclick="this.closest('dialog').close()">Close</button></div><div id="frame-body"></div></dialog>
<script>
let fl = [], fi = 0, fb = '';
function openFrames(b) { fl = JSON.parse(b.dataset.frames); fb = b.dataset.base; fi = fl.length - 1; showFrame(); document.getElementById('frames').showModal(); }
function stepFrame(d) { fi = Math.max(0, Math.min(fl.length - 1, fi + d)); showFrame(); }
function showFrame() {
  const f = fl[fi];
  document.getElementById('frame-cap').textContent = f.caption;
  document.getElementById('frame-json').href = fb + f.seq + '.json';
  const body = document.getElementById('frame-body');
  body.textContent = '';
  if (f.image) { const i = document.createElement('img'); i.src = fb + f.seq + '.png'; i.alt = 'Frame ' + f.seq + ', masked'; body.append(i); }
  else { const w = document.createElement('div'); w.className = 'withheld'; w.textContent = 'Withheld: ' + (f.withheld || 'no image'); body.append(w); }
}
</script>`;
