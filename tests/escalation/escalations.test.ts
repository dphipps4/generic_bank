import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';
import { freezePages } from '../../apps/console/src/pages/freezes.js';
import { inboxPages } from '../../apps/console/src/pages/inbox.js';
import { executeRun } from '../../apps/runner/src/execute.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { oauth } from '../../packages/oauth/src/index.js';
import { settleRun } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// Escalations as the agent and a person see them (plan, §D.8). The agent asks through the Task API;
// the person acts through the Console's API, the same calls its pages make; the Runner carries out
// the run against the real Generic Bank. Escalated: 409 with the escalation's id. Resumed: 202, then
// 200 once the Runner is done. Finished by hand: 200 handed_off. Cancelled: 410. After a guard trip
// nothing resumes, and the bank serves nothing until its freeze is cleared.

const MAINTENANCE = `data:text/html,${encodeURIComponent(
  '<title>Maintenance</title><h1>Scheduled maintenance</h1><p>We will be back soon.</p><button>Details</button>',
)}`;
const KEY = 'k'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let api: Awaited<ReturnType<typeof buildServer>>;
let token: string;
let answering: NodeJS.Timeout;
const restarted: string[] = [];
const people = Fastify();

beforeAll(async () => {
  [db, bank] = await Promise.all([controlDb(), liveBank('generic')]);
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
  const o = oauth(db, 'o'.repeat(40));
  api = await buildServer({ oauth: o, sql: db, sealKey: KEY, enqueue: async () => undefined });
  const c = await o.createClient({
    name: 'agent',
    scopes: ['tasks:read', 'tasks:balance'],
    createdBy: 'a',
  });
  token = (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
  const whoIs = () => ({ email: 'ada@generic-bank.local', role: 'admin' as const });
  inboxPages(people, {
    sql: db,
    answerKey: ANSWER_KEY,
    whoIs,
    restart: async (runId) => void restarted.push(runId),
  });
  freezePages(people, { sql: db, whoIs });
  await people.ready();
  // The person at the staff phone: answers any open staff-code task with the code the bank sent.
  answering = setInterval(async () => {
    const open = await db.query<{ id: string }>(
      `SELECT id FROM "HumanTask" WHERE status = 'open' AND kind = 'staff_code'`,
    );
    for (const t of open.rows) {
      const m = await bank.db.query<{ body: string }>(
        'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
      );
      const code = /(\d{6})/.exec(m.rows[0]?.body ?? '')?.[1];
      if (code)
        await people.inject({
          method: 'POST',
          url: `/human-tasks/${t.id}/answer`,
          payload: { code },
        });
    }
  }, 500);
}, 120_000);
afterAll(async () => {
  clearInterval(answering);
  await people.close();
  await api?.close();
  await bank?.close();
  await db?.close();
});

const deps = () => ({
  sql: db,
  store: memoryStore(),
  sealKey: KEY,
  answerKey: ANSWER_KEY,
  credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
});
const runner = (runId: string) => executeRun(runId, deps());

const ask = (runId: string) =>
  api.inject({ url: `/tasks/${runId}`, headers: { authorization: `Bearer ${token}` } });
const start = async (account: string) =>
  (
    await api.inject({
      method: 'POST',
      url: '/tasks/check-balance',
      headers: { authorization: `Bearer ${token}` },
      payload: { bank: 'generic', memberId: MEMBERS.demo, account },
    })
  ).json() as { runId: string; status: string };
const act = (task: string, action: string, reason: string) =>
  people.inject({ method: 'POST', url: `/human-tasks/${task}/${action}`, payload: { reason } });

async function escalated(code: 'unknown_screen' | 'guard_tripped' = 'unknown_screen') {
  const { runId } = await start('7890');
  await settleRun(db, runId, {
    status: 'escalated',
    code,
    ...(code === 'guard_tripped' ? { guard: { layer: 'element', rule: 'pressed Pay now' } } : {}),
  });
  const r = await ask(runId);
  expect([r.statusCode, r.json().code]).toEqual([409, code]);
  return { runId, escalationId: r.json().escalationId as string };
}

describe('an escalation, as the agent and a person see it', () => {
  it('409 while a person looks, then 202 after Resume, then 200 once the Runner is done', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const { runId } = await start(acct.number.slice(-4));
    // The bank shows a page the crawler has never seen: it stops where it is.
    await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [MAINTENANCE, 'generic']);
    expect(await runner(runId)).toMatchObject({ status: 'escalated', code: 'unknown_screen' });
    const stopped = await ask(runId);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.headers['content-type']).toContain('application/problem+json');
    expect(stopped.json()).toMatchObject({
      status: 409,
      code: 'unknown_screen',
      runId,
      escalationId: expect.stringMatching(/^h_/),
      resolvable: true,
    });
    // Asking again changes nothing until a person acts; the inbox counts the asks.
    expect((await ask(runId)).statusCode).toBe(409);
    const escalationId = stopped.json().escalationId as string;
    const asks = await db.query<{ asks: number }>('SELECT asks FROM "HumanTask" WHERE id = $1', [
      escalationId,
    ]);
    expect(asks.rows[0]!.asks).toBeGreaterThanOrEqual(2);

    // An unknown screen is a driver fault, so it took the driver out of service (registry.test.ts
    // shows that path); this test is about the escalation, so the driver is put back.
    const demoted = await db.query(
      `UPDATE "Driver" SET state = 'promoted', "activeVersionId" = 'dv_generic_check_balance_1'
        WHERE tenant = 'generic' AND task = 'check-balance' AND state = 'demoted' RETURNING id`,
    );
    expect(demoted.rows).toHaveLength(1);

    // The person clears the blocker and presses Resume; the run goes back to the Runner.
    await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
    expect((await act(escalationId, 'resume', 'the bank is back on its own page')).json()).toEqual({
      ok: true,
    });
    expect(restarted).toEqual([runId]);
    const resumed = await ask(runId);
    expect([resumed.statusCode, resumed.json().status]).toEqual([202, 'running']);
    await runner(runId);
    const done = await ask(runId);
    expect([done.statusCode, done.json().status, done.json().data.availableCents]).toEqual([
      200,
      'succeeded',
      acct.availableCents,
    ]);
    // One trail: the resumed attempt carries on after the stopped one.
    const steps = (
      await db.query<{ seq: number; name: string }>(
        'SELECT seq, name FROM "Step" WHERE "runId" = $1 ORDER BY seq',
        [runId],
      )
    ).rows;
    expect(steps[0]!.name).toBe('unknown');
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i + 1));
    expect(steps.map((s) => s.name)).toContain('balance');
  }, 180_000);

  it('200 handed_off after Finish by hand, with who finished it', async () => {
    const { runId, escalationId } = await escalated();
    expect((await act(escalationId, 'finish', 'read the balance to the member')).statusCode).toBe(
      200,
    );
    const r = await ask(runId);
    expect([r.statusCode, r.json().status, r.json().resolvedBy]).toEqual([
      200,
      'handed_off',
      'ada@generic-bank.local',
    ]);
  });

  it('410 after Cancel', async () => {
    const { runId, escalationId } = await escalated();
    expect((await act(escalationId, 'cancel', 'the member no longer needs it')).statusCode).toBe(
      200,
    );
    const r = await ask(runId);
    expect([r.statusCode, r.json().code]).toEqual([410, 'cancelled']);
  });

  it('after a guard trip: no Resume, and the bank serves nothing until its freeze is cleared', async () => {
    const { runId, escalationId } = await escalated('guard_tripped');
    expect((await ask(runId)).json().resolvable).toBe(false);
    expect((await act(escalationId, 'resume', 'it looked fine to me')).statusCode).toBe(409);
    const refused = await api.inject({
      method: 'POST',
      url: '/tasks/check-balance',
      headers: { authorization: `Bearer ${token}` },
      payload: { bank: 'generic', memberId: MEMBERS.demo, account: '7890' },
    });
    expect([refused.statusCode, refused.json().code]).toEqual([404, 'task_not_available']);
    // A run already queued for the frozen bank never opens a browser.
    const queued = (
      await db.query<{ id: string }>(
        `INSERT INTO "TaskRun" (id, task, bank, "inputsMasked", status) VALUES ('r_queued', 'check-balance', 'generic', '{}', 'running') RETURNING id`,
      )
    ).rows[0]!.id;
    expect(await executeRun(queued, { ...deps(), launch: () => never() })).toMatchObject({
      status: 'failed',
      code: 'no_driver',
    });

    const freeze = await db.query<{ id: string }>('SELECT id FROM "Freeze" WHERE "runId" = $1', [
      runId,
    ]);
    const cleared = await people.inject({
      method: 'POST',
      url: `/freezes/${freeze.rows[0]!.id}/clear`,
      payload: { reason: 'read the trail; nothing was pressed' },
    });
    expect(cleared.json()).toEqual({ ok: true });
    expect((await start('7890')).status).toBe('running');
  });
});

function never(): never {
  throw new Error('a frozen bank opened a browser');
}
