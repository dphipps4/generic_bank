import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '@gb/evidence';
import { addFrame, addStep } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import type { Viewer } from '../src/pages/layout.js';
import { recommendationPages } from '../src/pages/recommendations.js';
import { runPages } from '../src/pages/runs.js';

// The review card: each claim with its seen or guess badge and a Frames button that opens the
// frames it cites; Approve and Reject, each with a written reason that goes to the audit. A guess
// is approved only when it is ticked. Only approvers and admins decide.

const RUN = 'fr_card';
let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof Fastify>;
let who: Viewer | null = { email: 'ada@generic-bank.local', role: 'approver' };
const store = memoryStore();

const CLAIMS = [
  { about: 'words.signIn', value: 'Sign In', basis: 'seen', frames: ['f1'] },
  { about: 'words.memberSearch', value: 'Member Search', basis: 'seen', frames: ['f2', 'f3'] },
  {
    about: 'refusals.insufficient_funds',
    value: 'The amount is more than the available balance.',
    basis: 'guess',
    frames: ['f3'],
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
    `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, claims) VALUES ($1, $2, 'bank2', $3)`,
    [id, RUN, JSON.stringify(CLAIMS)],
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

describe('the review card', () => {
  it('shows each claim, seen or guess, with a Frames button for the frames it cites', async () => {
    const html = (await app.inject({ url: '/recommendations' })).body;
    const rows = rowsOf(html);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('<code>words.signIn</code>');
    expect(rows[0]).toContain('<span class="pill seen">seen</span>');
    expect(rows[2]).toContain('The amount is more than the available balance.');
    expect(rows[2]).toContain('<span class="pill guess">guess</span>');
    // Each button holds the frames its claim cites, and no other.
    expect(rows.map(framesIn)).toEqual([[1], [2, 3], [3]]);
    expect(rows[1]).toContain(`data-base="/runs/${RUN}/frames/"`);
    expect(rows[1]).toContain('Frames (2)');
    expect(html).toContain('<dialog id="frames"');
    // What the button opens: the cited frame's masked picture.
    const pic = await app.inject({ url: `/runs/${RUN}/frames/3.png` });
    expect(pic.statusCode).toBe(200);
    expect(pic.body).toContain('frame 3');
    // Only the guess has a tick, on the approve form.
    expect(rows[2]).toContain(`name="tick" value="3" form="approve-${id}"`);
    expect(rows[0]).not.toContain('name="tick"');
    expect(html).toContain('One claim is a guess: approving needs each guess ticked.');
  });

  it('never approves a guess by default: each guess must be ticked', async () => {
    const r = await act('approve', { reason: 'the frames show every word' });
    expect(r.statusCode).toBe(400);
    expect(r.json().detail).toBe(
      'a guess is approved only when it is ticked; not ticked: claim 3 (refusals.insufficient_funds)',
    );
    expect(await status()).toBe('open');
    // Ticking a claim that is seen does not tick the guess.
    expect(
      (await act('approve', { reason: 'the frames show every word', tick: ['1'] })).statusCode,
    ).toBe(400);
    expect(await audit()).toEqual([]);
    expect(
      (
        await act('approve', { reason: 'the guess is the core’s usual wording', tick: ['3'] })
      ).json(),
    ).toEqual({ ok: true, status: 'approved' });
    expect(await status()).toBe('approved');
    expect(await audit()).toEqual([
      {
        actor: 'ada@generic-bank.local',
        action: 'recommendation.approve',
        reason: 'the guess is the core’s usual wording',
      },
    ]);
    // Decided once.
    expect((await act('reject', { reason: 'changed my mind about it' })).statusCode).toBe(409);
    const html = (await app.inject({ url: '/recommendations' })).body;
    expect(html).toContain('approved</span> by ada@generic-bank.local');
    expect(html).not.toContain('name="tick"');
  });

  it('approves and rejects from the forms, each with a reason, and says so', async () => {
    const form = (action: string, payload: string) =>
      app.inject({
        method: 'POST',
        url: `/recommendations/${id}/${action}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload,
      });
    let r = await form('approve', 'reason=the+frames+show+it');
    expect(decodeURIComponent(r.headers.location as string)).toContain(
      'not ticked: claim 3 (refusals.insufficient_funds)',
    );
    r = await form('reject', 'reason=short');
    expect(decodeURIComponent(r.headers.location as string)).toContain(
      'a reason of at least ten characters',
    );
    r = await form('reject', 'reason=the+guess+is+not+good+enough');
    expect(r.headers.location).toBe('/recommendations?done=reject');
    expect((await app.inject({ url: r.headers.location })).body).toContain(
      'Rejected: the profile is not used.',
    );
    expect(await status()).toBe('rejected');
    expect(await audit()).toEqual([
      {
        actor: 'ada@generic-bank.local',
        action: 'recommendation.reject',
        reason: 'the guess is not good enough',
      },
    ]);
  });

  it('lets no one but an approver or an admin decide', async () => {
    who = { email: 'vic@generic-bank.local', role: 'viewer' };
    const html = (await app.inject({ url: '/recommendations' })).body;
    expect(html).toContain('Approvers decide here.');
    expect(html).not.toContain(`action="/recommendations/${id}/approve"`);
    expect(
      (await act('approve', { reason: 'the frames show it all', tick: ['3'] })).statusCode,
    ).toBe(403);
    who = null;
    expect((await act('reject', { reason: 'the frames show it all' })).statusCode).toBe(401);
    expect(await status()).toBe('open');
    expect(await audit()).toEqual([]);
    who = { email: 'ada@generic-bank.local', role: 'admin' };
    expect((await act('reject', { reason: 'the frames show too little' })).statusCode).toBe(200);
  });
});
