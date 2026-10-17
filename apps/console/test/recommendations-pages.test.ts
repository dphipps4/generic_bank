import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '@gb/evidence';
import { addFrame, addStep } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import type { Viewer } from '../src/pages/layout.js';
import { recommendationPages } from '../src/pages/recommendations.js';
import { runPages } from '../src/pages/runs.js';

// The review card for a learned table: each page as a row with a Frames button for the frame it
// cites, the reads, the bank's answers and the gate's runs; Approve and Reject, each with a written
// reason that goes to the audit. Approving promotes the table for both tasks: the registry serves
// it. Only approvers and admins decide.

const RUN = 'fr_card';
let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof Fastify>;
let who: Viewer | null = { email: 'ada@generic-bank.local', role: 'approver' };
const store = memoryStore();

const TABLE = {
  bank: 'bank2',
  home: '',
  rows: [
    {
      page: 'sign-in',
      shows: ['User ID'],
      do: { balance: [{ type: 'User ID', value: '$operator' }, { press: 'Log in' }] },
      frame: 'f1',
    },
    {
      page: 'home',
      shows: ['Find a member'],
      do: { balance: [{ press: 'Find a member' }] },
      frame: 'f2',
    },
    { page: 'summary', shows: ['Balances'], do: {}, frame: 'f3' },
  ],
  ends: { balance: 'summary' },
  answers: [{ says: 'No such member', code: 'no_such_member', frame: 'f3' }],
  trouble: [],
  submit: { press: '', frame: '' },
  reads: { balance: '{name} {last4} {available} {current}', name: ['Member $member · {name}'] },
};
const CHECK = [
  { runId: `${RUN}-check`, hazard: null, ok: true, said: 'the balance read 100 cents' },
  {
    runId: `${RUN}-confirm-dialog`,
    hazard: 'confirm-dialog',
    ok: true,
    said: 'the review read $1.00',
  },
];

beforeAll(async () => {
  db = await controlDb();
  app = Fastify();
  const whoIs = () => who;
  recommendationPages(app, { sql: db, whoIs });
  runPages(app, { sql: db, store, whoIs });
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ($1, 'bank2', 'check-balance', 'build', 'SCOUT', 'running')`,
    [RUN],
  );
  await db.query(
    `INSERT INTO "TaskRun" (id, task, bank, "inputsMasked", status) VALUES ($1, 'check-balance', 'bank2', '{}', 'running')`,
    [RUN],
  );
  for (const [seq, path] of [
    [1, '/corelink/signin'],
    [2, '/corelink/home'],
    [3, '/corelink/members/********'],
  ] as const) {
    await addStep(db, RUN, seq, { name: 'browser_click', screen: null, ms: 100 });
    await store.put(`runs/${RUN}/00${seq}.png`, Buffer.from(`\x89PNG frame ${seq}`), 'image/png');
    await addFrame(db, RUN, seq, {
      stepSeq: seq,
      imageKey: `runs/${RUN}/00${seq}.png`,
      modelKey: null,
      host: 'bank2:8082',
      path,
    });
  }
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

let id: string;
beforeEach(async () => {
  id = `rec_${Math.random().toString(16).slice(2, 10)}`;
  await db.query(`DELETE FROM "Recommendation"`);
  await db.query(
    `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, "table", "check") VALUES ($1, $2, 'bank2', $3, $4)`,
    [id, RUN, JSON.stringify(TABLE), JSON.stringify(CHECK)],
  );
  who = { email: 'ada@generic-bank.local', role: 'approver' };
});

const act = (action: string, body: unknown) =>
  app.inject({ method: 'POST', url: `/recommendations/${id}/${action}`, payload: body as object });
const status = async () =>
  (await db.query<{ status: string }>('SELECT status FROM "Recommendation" WHERE id = $1', [id]))
    .rows[0]!.status;
const audit = async () =>
  (await db.query('SELECT actor, action, reason FROM "AuditEntry" WHERE target = $1', [id])).rows;
/** Each claim's row on the card, in order. */
const rowsOf = (html: string) => html.match(/<tr><td>\d+<\/td>.*?<\/tr>/g) ?? [];
const framesIn = (row: string) =>
  (
    JSON.parse(
      /data-frames="([^"]*)"/.exec(row)![1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&'),
    ) as { seq: number }[]
  ).map((f) => f.seq);

/** The version serving a task at bank2, and the table it holds. */
const served = async (task: string) =>
  (
    await db.query<{ table: unknown }>(
      `SELECT v."table" FROM "Driver" d JOIN "DriverVersion" v ON v.id = d."activeVersionId"
        WHERE d.tenant = 'bank2' AND d.task = $1 AND d.state = 'promoted'`,
      [task],
    )
  ).rows[0]?.table;

describe('the review card', () => {
  it('shows each page as a row, with a Frames button for the frame it cites', async () => {
    const html = (await app.inject({ url: '/recommendations' })).body;
    const rows = rowsOf(html);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('"User ID"');
    expect(rows[0]).toContain('type $operator into &quot;User ID&quot;; press &quot;Log in&quot;');
    expect(rows[2]).toContain('a goal ends here');
    expect(rows.map(framesIn)).toEqual([[1], [2], [3]]);
    expect(rows[1]).toContain(`data-base="/runs/${RUN}/frames/"`);
    expect(html).toContain('<dialog id="frames"');
    const pic = await app.inject({ url: `/runs/${RUN}/frames/3.png` });
    expect(pic.statusCode).toBe(200);
    expect(pic.body).toContain('frame 3');
    // The reads, the bank's answers and the gate's runs.
    expect(html).toContain('<code>{name} {last4} {available} {current}</code>');
    expect(html).toContain('"No such member" means <code>no_such_member</code>');
    expect(html).toContain(
      'with confirm-dialog forced: <span class="pill succeeded">passed</span>',
    );
  });

  it('promotes the table for both tasks once approved, and audits it', async () => {
    expect(await served('check-balance')).toBeUndefined();
    expect((await act('approve', { reason: 'every row matches its frame' })).json()).toEqual({
      ok: true,
      status: 'approved',
    });
    expect(await status()).toBe('approved');
    expect(await served('check-balance')).toEqual(TABLE);
    expect(await served('transfer')).toEqual(TABLE);
    expect(await audit()).toEqual([
      {
        actor: 'ada@generic-bank.local',
        action: 'recommendation.approve',
        reason: 'every row matches its frame',
      },
    ]);
    // Decided once.
    expect((await act('reject', { reason: 'changed my mind about it' })).statusCode).toBe(409);
    expect((await app.inject({ url: '/recommendations' })).body).toContain(
      'approved</span> by ada@generic-bank.local',
    );
  });

  it('approves and rejects from the forms, each with a reason, and says so', async () => {
    const form = (action: string, payload: string) =>
      app.inject({
        method: 'POST',
        url: `/recommendations/${id}/${action}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload,
      });
    let r = await form('reject', 'reason=short');
    expect(decodeURIComponent(r.headers.location as string)).toContain(
      'a reason of at least ten characters',
    );
    r = await form('reject', 'reason=the+summary+row+is+wrong');
    expect(r.headers.location).toBe('/recommendations?done=reject');
    expect((await app.inject({ url: r.headers.location })).body).toContain(
      'Rejected: the table is not used.',
    );
    expect(await status()).toBe('rejected');
  });

  it('lets no one but an approver or an admin decide', async () => {
    who = { email: 'vic@generic-bank.local', role: 'viewer' };
    const html = (await app.inject({ url: '/recommendations' })).body;
    expect(html).toContain('Approvers decide here.');
    expect(html).not.toContain(`action="/recommendations/${id}/approve"`);
    expect((await act('approve', { reason: 'the frames show it all' })).statusCode).toBe(403);
    who = null;
    expect((await act('reject', { reason: 'the frames show it all' })).statusCode).toBe(401);
    expect(await status()).toBe('open');
    expect(await audit()).toEqual([]);
  });
});
