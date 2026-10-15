import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTCOMES } from '@gb/contracts';
import { createRun } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { type LabRun, labPages, type Started } from '../src/pages/lab.js';
import { page, showLabInNav, type Viewer } from '../src/pages/layout.js';

// The hazard lab, as an admin uses it: pick a member and hazards, start, and be told what to expect.
let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof Fastify>;
let who: Viewer = { email: 'ada@generic-bank.local', role: 'admin' };
const started: LabRun[] = [];
let answer: Started = { ok: true, runId: 'r_lab1' };

beforeAll(async () => {
  db = await controlDb();
  app = Fastify();
  labPages(app, {
    sql: db,
    whoIs: () => who,
    start: async (run) => (started.push(run), answer),
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const form = (fields: [string, string][]) =>
  app.inject({
    method: 'POST',
    url: '/lab',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });

describe('the hazard lab', () => {
  it('starts the run an admin picked, and says the result to expect', async () => {
    const r = await form([
      ['bank', 'generic'],
      ['task', 'check-balance'],
      ['member', '0'],
      ['hazards', 'record-in-use'],
    ]);
    expect(r.statusCode).toBe(303);
    expect(started.at(-1)).toEqual({
      task: 'check-balance',
      input: { bank: 'generic', memberId: '40017732', account: 'Everyday Checking' },
      hazards: ['record-in-use'],
      by: 'ada@generic-bank.local',
    });
    const html = (await app.inject({ url: r.headers.location as string })).body;
    expect(html).toContain('/runs/r_lab1');
    expect(html).toContain('Expected: <b>failed: record_in_use</b>');
  });

  it('expects the member’s own result with nothing forced, and no single result for a mix', async () => {
    let r = await form([['member', '2']]);
    expect(started.at(-1)!.hazards).toEqual([]);
    expect((await app.inject({ url: r.headers.location as string })).body).toContain(
      'Expected: <b>business_outcome: member_closed</b>',
    );
    r = await form([
      ['member', '0'],
      ['hazards', 'promo'],
      ['hazards', 'late-rows'],
    ]);
    expect(started.at(-1)!.hazards).toEqual(['promo', 'late-rows']);
    expect((await app.inject({ url: r.headers.location as string })).body).toContain(
      'Expected: <b>no single result</b>',
    );
  });

  it('refuses a hazard the bank does not know, and shows the API’s refusal', async () => {
    const n = started.length;
    let r = await form([['hazards', 'meteor']]);
    expect(started).toHaveLength(n);
    expect((await app.inject({ url: r.headers.location as string })).body).toContain(
      'That is not a hazard the bank knows.',
    );
    answer = { ok: false, detail: 'No promoted crawler serves check-balance on example yet.' };
    r = await form([['bank', 'example']]);
    expect((await app.inject({ url: r.headers.location as string })).body).toContain(
      'No promoted crawler serves check-balance on example yet.',
    );
    answer = { ok: true, runId: 'r_lab1' };
  });

  it('lists recent lab runs with what was forced and how each ended', async () => {
    const { runId } = await createRun(
      db,
      {
        task: 'check-balance',
        bank: 'generic',
        clientId: null,
        inputs: { bank: 'generic', memberId: '40017732', account: 'x' },
        forcedHazards: ['unknown-screen'],
      },
      'k'.repeat(40),
    );
    await db.query(
      `UPDATE "TaskRun" SET status = 'escalated', "resultCode" = 'unknown_screen' WHERE id = $1`,
      [runId],
    );
    const html = (await app.inject({ url: '/lab' })).body;
    const row = new RegExp(`<tr><td><a href="/runs/${runId}">.*?</tr>`).exec(html)?.[0];
    expect(row).toContain('<code>unknown-screen</code>');
    expect(row).toContain('<code>unknown_screen</code>');
  });

  it('offers every hazard and member, and only to an admin', async () => {
    const html = (await app.inject({ url: '/lab' })).body;
    for (const h of OUTCOMES['check-balance'].hazards)
      expect(html).toContain(`name="hazards" value="${h.hazard}"`);
    who = { email: 'val@generic-bank.local', role: 'approver' };
    const n = started.length;
    expect((await app.inject({ url: '/lab' })).body).toContain(
      'Only an admin starts runs in the hazard lab.',
    );
    await form([['member', '0']]);
    expect(started).toHaveLength(n);
    who = { email: 'ada@generic-bank.local', role: 'admin' };
  });

  it('is in the bar once the stack is forceable', () => {
    expect(page('x', '')).not.toContain('href="/lab"');
    showLabInNav();
    showLabInNav();
    expect(page('x', '').match(/href="\/lab"/g)).toHaveLength(1);
  });
});
