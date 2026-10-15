import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauth } from '@gb/oauth';
import { answerHumanTask, openHumanTask, settleRun } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { buildServer } from '../src/server.js';

// Runs over HTTP: 202 with a Location, then the result as the status code that says what to do.
const SEAL = 'r'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let o: ReturnType<typeof oauth>;
const enqueued: string[] = [];

beforeAll(async () => {
  db = await controlDb();
  o = oauth(db, 'k'.repeat(40));
  app = await buildServer({
    oauth: o,
    sql: db,
    sealKey: SEAL,
    enqueue: async (id) => void enqueued.push(id),
  });
});
afterAll(() => db.close());

async function client(scopes = ['tasks:read', 'tasks:balance']) {
  const c = await o.createClient({ name: 'agent', scopes, createdBy: 'a' });
  return (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
}
const start = (token: string, memberId = '40017732') =>
  app.inject({
    method: 'POST',
    url: '/tasks/check-balance',
    headers: { authorization: `Bearer ${token}` },
    payload: { bank: 'generic', memberId, account: '7890' },
  });
const get = (token: string, runId: string, wait = 0) =>
  app.inject({
    method: 'GET',
    url: `/tasks/${runId}?wait=${wait}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('runs over HTTP', () => {
  it('accepts a task with 202, a Location and a Retry-After, and hands it to the Runner once', async () => {
    const t = await client();
    const r = await start(t);
    expect(r.statusCode).toBe(202);
    const runId = r.json().runId;
    expect(r.headers.location).toBe(`/tasks/${runId}`);
    expect(r.headers['retry-after']).toBe('5');
    expect(r.json()).toEqual({ runId, task: 'check-balance', status: 'running' });
    expect(enqueued).toContain(runId);
  });

  it('answers each ending with its own status code', async () => {
    const t = await client();
    const end = async (e: Parameters<typeof settleRun>[2]) => {
      const runId = (await start(t)).json().runId;
      await settleRun(db, runId, e);
      return get(t, runId);
    };
    const ok = await end({
      status: 'succeeded',
      data: {
        accountLabel: 'Account ending in ****',
        availableCents: 1,
        currentCents: 2,
        asOf: '2026-06-15T00:00:00.000Z',
      },
    });
    expect([ok.statusCode, ok.json().data.availableCents]).toEqual([200, 1]);
    const no = await end({ status: 'business_outcome', code: 'no_such_member' });
    expect([no.statusCode, no.headers['content-type'], no.json().code, no.json().message]).toEqual([
      422,
      'application/problem+json; charset=utf-8',
      'no_such_member',
      'The bank has no member with that number.',
    ]);
    const busy = await end({ status: 'failed', code: 'unavailable' });
    expect([busy.statusCode, busy.headers['retry-after'], busy.json().retryable]).toEqual([
      503,
      '30',
      true,
    ]);
    const gone = await end({ status: 'failed', code: 'bad_credentials' });
    expect([gone.statusCode, gone.json().retryable]).toEqual([502, false]);
  });

  it('answers 409 while escalated, naming the escalation, and 202 while waiting on a person', async () => {
    const t = await client();
    const runId = (await start(t)).json().runId;
    const task = await openHumanTask(db, runId, 'staff_code', {}, new Date(Date.now() + 60_000));
    const waiting = await get(t, runId);
    expect([waiting.statusCode, waiting.json().status, waiting.json().code]).toEqual([
      202,
      'needs_human',
      'awaiting_staff_code',
    ]);
    await answerHumanTask(db, task, '123456', 'staff', SEAL);
    await settleRun(db, runId, { status: 'escalated', code: 'unknown_screen' });
    const r = await get(t, runId);
    expect([r.statusCode, r.json().code, r.json().escalationId, r.json().resolvable]).toEqual([
      409,
      'unknown_screen',
      task,
      true,
    ]);
  });

  it('long-polls with wait=, and returns as soon as the run settles', async () => {
    const t = await client();
    const runId = (await start(t)).json().runId;
    setTimeout(
      () => void settleRun(db, runId, { status: 'business_outcome', code: 'member_closed' }),
      500,
    );
    const t0 = Date.now();
    expect((await get(t, runId, 10)).statusCode).toBe(422);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('shows a run only to the client that started it', async () => {
    const mine = await client();
    const theirs = await client();
    const runId = (await start(mine)).json().runId;
    expect((await get(theirs, runId)).statusCode).toBe(404);
    expect((await get(mine, runId)).statusCode).toBe(202);
  });
});
