import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awaitAnswer, awaitDecision, createRun, openHumanTask } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { inboxPages } from '../src/pages/inbox.js';
import type { Viewer } from '../src/pages/layout.js';

// The inbox, as a person and as the API use it: open tasks oldest deadline first, codes answered
// and sealed, an approval with what it approves and its four actions, each with a reason, and
// nothing for a viewer to press.

const KEY = 'a'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof Fastify>;
let who: Viewer | null = { email: 'ann@generic-bank.local', role: 'approver' };

const input = { bank: 'generic', memberId: '40017732', account: '7890' };
async function parked(minutesLeft: number, openedMinutesAgo = 0) {
  const { runId } = await createRun(
    db,
    { task: 'check-balance', bank: 'generic', clientId: 'gbc_agent', inputs: input },
    'k'.repeat(40),
  );
  const task = await openHumanTask(
    db,
    runId,
    'staff_code',
    { bank: 'generic', prompt: `The bank sent a code (${minutesLeft} min left).` },
    new Date(Date.now() + minutesLeft * 60_000),
  );
  if (openedMinutesAgo)
    await db.query(`UPDATE "HumanTask" SET "openedAt" = $2 WHERE id = $1`, [
      task,
      new Date(Date.now() - openedMinutesAgo * 60_000),
    ]);
  return { runId, task };
}
async function awaitingApproval() {
  const { runId } = await createRun(
    db,
    { task: 'transfer', bank: 'generic', clientId: 'gbc_agent', inputs: input },
    'k'.repeat(40),
  );
  const task = await openHumanTask(
    db,
    runId,
    'approval',
    {
      prompt: 'Approve this transfer.',
      review: {
        from: '****7890',
        to: '****1234',
        amountCents: 125_050,
        memo: 'GBX 7Q4M rent',
        memoToken: 'GBX 7Q4M',
      },
      frame: { runId, seq: 6 },
    },
    new Date(Date.now() + 15 * 60_000),
  );
  return { runId, task };
}
const form = (task: string, action: string, payload: string) =>
  app.inject({
    method: 'POST',
    url: `/human-tasks/${task}/${action}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload,
  });
const post = (task: string, action: string, body: unknown) =>
  app.inject({ method: 'POST', url: `/human-tasks/${task}/${action}`, payload: body as object });

beforeAll(async () => {
  db = await controlDb();
  app = Fastify();
  inboxPages(app, { sql: db, answerKey: KEY, whoIs: () => who });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the inbox', () => {
  it('lists open tasks, the nearest deadline first, with how long the agent has waited', async () => {
    const late = await parked(14);
    const soon = await parked(2, 7);
    const page = (await app.inject({ url: '/inbox' })).body;
    expect(page.indexOf('(2 min left)')).toBeLessThan(page.indexOf('(14 min left)'));
    expect(page).toContain(`/runs/${soon.runId}`);
    expect(page).toContain(`/human-tasks/${late.task}/answer`);
    // One task has waited more than five minutes: every page says so.
    expect(page).toContain('One task has waited more than five minutes');
    expect(page).toContain('7 min');
  });

  it('carries a code to the waiting run, and never shows it or keeps it in the clear', async () => {
    const { task } = await parked(10);
    const waiting = awaitAnswer(db, task, KEY, new Date(Date.now() + 10_000), 50);
    const r = await app.inject({
      method: 'POST',
      url: `/human-tasks/${task}/answer`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'code=731905',
    });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/inbox?done=answer');
    expect(await waiting).toEqual({ status: 'answered', answer: '731905' });
    const after = await app.inject({ url: '/inbox?done=answer' });
    expect(after.body).toContain('The code went to the run');
    expect(after.body).not.toContain(`/human-tasks/${task}/`);
    const rows = await db.query('SELECT * FROM "HumanTask" h, "AuditEntry" a WHERE h.id = $1', [
      task,
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain('731905');
  });

  it('answers the API in JSON: 200, then 409 once answered, 400 for a bad body', async () => {
    const { task } = await parked(10);
    expect((await post(task, 'answer', { code: '12x' })).statusCode).toBe(400);
    expect((await post(task, 'answer', { code: '120034' })).json()).toEqual({ ok: true });
    const again = await post(task, 'answer', { code: '120034' });
    expect(again.statusCode).toBe(409);
    expect(again.headers['content-type']).toContain('application/problem+json');
    expect(again.json()).toMatchObject({ code: 'conflict', detail: 'the task is answered' });
    expect((await post(task, 'nonsense', {})).statusCode).toBe(404);
    expect((await post('h_missing', 'answer', { code: '120034' })).statusCode).toBe(404);
  });

  it('cancels the run only with a written reason', async () => {
    const { task } = await parked(10);
    expect((await post(task, 'cancel', { reason: 'no' })).statusCode).toBe(400);
    expect((await post(task, 'cancel', { reason: 'the member hung up' })).statusCode).toBe(200);
    const t = await db.query<{ status: string; reason: string }>(
      'SELECT status, reason FROM "HumanTask" WHERE id = $1',
      [task],
    );
    expect(t.rows[0]).toEqual({ status: 'cancelled', reason: 'the member hung up' });
  });

  it('shows an approval: the review as read, its masked picture, and four reasoned actions', async () => {
    const { runId, task } = await awaitingApproval();
    const page = (await app.inject({ url: '/inbox' })).body;
    const row = page.slice(page.indexOf('Approve this transfer.'));
    expect(row).toContain('****7890');
    expect(row).toContain('****1234');
    expect(row).toContain('$1,250.50');
    expect(row).toContain('GBX 7Q4M rent');
    expect(row).toContain(`href="/runs/${runId}"`);
    expect(row).toContain(`src="/runs/${runId}/frames/6.png"`);
    for (const a of ['approve', 'reject', 'take_over', 'cancel'])
      expect(row).toMatch(
        new RegExp(
          `action="/human-tasks/${task}/${a}" class="row"><input name="reason" minlength="10" required`,
        ),
      );
    expect(row).not.toContain(`/human-tasks/${task}/answer`);
  });

  it('approves from the form: the run is handed its grant', async () => {
    const { task } = await awaitingApproval();
    const waiting = awaitDecision(db, task, new Date(Date.now() + 10_000), 50);
    const r = await form(task, 'approve', 'reason=checked+with+the+member');
    expect(r.headers.location).toBe('/inbox?done=approve');
    expect(await waiting).toMatchObject({ status: 'approved', grantId: expect.any(String) });
    expect((await app.inject({ url: '/inbox?done=approve' })).body).toContain(
      'Approved: the transfer will be submitted once, under a grant valid for five minutes.',
    );
  });

  it.each([
    ['reject', 'rejected', 'Rejected'],
    ['take_over', 'taken_over', 'Taken over: finish it by hand in the bank.'],
    ['cancel', 'cancelled', 'The run is cancelled.'],
  ])('%s from the form, and the run hears it', async (action, status, notice) => {
    const { task } = await awaitingApproval();
    const waiting = awaitDecision(db, task, new Date(Date.now() + 10_000), 50);
    const r = await form(task, action, 'reason=the+member+changed+their+mind');
    expect(r.headers.location).toBe(`/inbox?done=${action}`);
    expect(await waiting).toEqual({ status });
    expect((await app.inject({ url: r.headers.location })).body).toContain(notice);
  });

  it('takes every approval action as JSON, and none without a written reason', async () => {
    // The plan's paths spell it take-over; both spellings work.
    for (const action of ['approve', 'reject', 'take-over', 'take_over', 'cancel']) {
      const { task } = await awaitingApproval();
      for (const body of [{}, { reason: 'ok' }, { reason: '          ' }]) {
        const bad = await post(task, action, body);
        expect(bad.statusCode).toBe(400);
        expect(bad.json()).toMatchObject({ code: 'invalid_input' });
      }
      expect((await form(task, action, 'reason=')).headers.location).toMatch(/^\/inbox\?error=/);
      expect((await post(task, action, { reason: 'checked with the member' })).json()).toEqual({
        ok: true,
      });
      expect((await post(task, action, { reason: 'checked with the member' })).statusCode).toBe(
        409,
      );
      const grants = await db.query('SELECT id FROM "ApprovalGrant" WHERE "humanTaskId" = $1', [
        task,
      ]);
      expect(grants.rows).toHaveLength(action === 'approve' ? 1 : 0);
    }
  });

  it('gives a viewer nothing to press, and refuses anyone not signed in', async () => {
    const { task } = await parked(10);
    const approval = await awaitingApproval();
    who = { email: 'val@generic-bank.local', role: 'viewer' };
    try {
      const page = (await app.inject({ url: '/inbox' })).body;
      expect(page).toContain('Approvers answer here.');
      expect(page).not.toContain('<form');
      expect(page).toContain('$1,250.50');
      expect((await post(task, 'answer', { code: '120034' })).statusCode).toBe(403);
      expect(
        (await post(approval.task, 'approve', { reason: 'checked with the member' })).statusCode,
      ).toBe(403);
      who = null;
      expect((await app.inject({ url: '/inbox' })).headers.location).toBe('/admin/login');
      expect((await post(task, 'answer', { code: '120034' })).statusCode).toBe(401);
    } finally {
      who = { email: 'ann@generic-bank.local', role: 'approver' };
    }
    const open = await db.query<{ status: string }>(
      'SELECT status FROM "HumanTask" WHERE id = $1',
      [task],
    );
    expect(open.rows[0]!.status).toBe('open');
    const grants = await db.query('SELECT id FROM "ApprovalGrant" WHERE "humanTaskId" = $1', [
      approval.task,
    ]);
    expect(grants.rows).toEqual([]);
  });
});
