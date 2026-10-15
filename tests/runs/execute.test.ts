import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun } from '../../apps/runner/src/execute.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { answerHumanTask, createRun, resultOf } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// A task run, carried out by the Runner against the real Generic Bank, with the control database's
// real migrations. A small loop plays the person who reads the staff code and answers the task.

const KEY = 'k'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let answering: NodeJS.Timeout;

beforeAll(async () => {
  [db, bank] = await Promise.all([controlDb(), liveBank('generic')]);
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
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
      if (code) await answerHumanTask(db, t.id, code, 'staff@test', KEY);
    }
  }, 500);
}, 120_000);
afterAll(async () => {
  clearInterval(answering);
  await bank?.close();
  await db?.close();
});

const deps = (store = memoryStore()) => ({
  sql: db,
  store,
  sealKey: KEY,
  credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
});

describe('the Runner carries out a run', () => {
  it('checks a balance end to end: steps, a person’s code, masked frames, one result', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const { runId } = await createRun(
      db,
      {
        task: 'check-balance',
        bank: 'generic',
        clientId: 'gbc_t',
        inputs: { bank: 'generic', memberId: MEMBERS.demo, account: acct.number.slice(-4) },
      },
      KEY,
    );
    const store = memoryStore();
    await executeRun(runId, deps(store));

    const result = await resultOf(db, runId);
    expect(result).toMatchObject({
      status: 'succeeded',
      data: {
        availableCents: acct.availableCents,
        currentCents: acct.currentCents,
        accountLabel: 'Account ending in ****',
      },
    });

    const steps = (
      await db.query<{ name: string }>('SELECT name FROM "Step" WHERE "runId" = $1 ORDER BY seq', [
        runId,
      ])
    ).rows.map((r) => r.name);
    expect(steps).toEqual(
      expect.arrayContaining(['sign in', 'staff code', 'member search', 'balance']),
    );

    const task = (
      await db.query<{ status: string; answerSealed: string | null }>(
        'SELECT status, "answerSealed" FROM "HumanTask" WHERE "runId" = $1',
        [runId],
      )
    ).rows[0]!;
    expect(task).toEqual({ status: 'answered', answerSealed: null });

    const frames = (
      await db.query<{ imageKey: string | null; screenModelKey: string; path: string }>(
        'SELECT "imageKey", "screenModelKey", path FROM "TrailFrame" WHERE "runId" = $1 ORDER BY seq',
        [runId],
      )
    ).rows;
    expect(frames.length).toBeGreaterThanOrEqual(steps.length - 1);
    expect(frames.every((f) => f.imageKey?.endsWith('.png'))).toBe(true);
    // Nothing stored anywhere carries the member number, the account's digits or the password.
    const stored = [
      ...(await Promise.all(
        store
          .keys()
          .filter((k) => k.endsWith('.json'))
          .map(async (k) => (await store.get(k))!.toString()),
      )),
      JSON.stringify((await db.query('SELECT * FROM "TaskRun" WHERE id = $1', [runId])).rows),
      JSON.stringify((await db.query('SELECT * FROM "Step" WHERE "runId" = $1', [runId])).rows),
      JSON.stringify(frames),
    ].join('\n');
    for (const v of [MEMBERS.demo, acct.number, acct.number.slice(-4), PASSWORDS.service])
      expect(stored).not.toContain(v);
  }, 180_000);

  it('refuses a bank and task with no promoted driver, before any browser opens', async () => {
    const { runId } = await createRun(
      db,
      {
        task: 'check-balance',
        bank: 'example',
        clientId: null,
        inputs: { bank: 'example', memberId: MEMBERS.demo, account: '1234' },
      },
      KEY,
    );
    const launched = { n: 0 };
    await executeRun(runId, { ...deps(), launch: async () => (launched.n++, null as never) });
    expect(await resultOf(db, runId)).toMatchObject({
      status: 'failed',
      code: 'no_driver',
      retryable: false,
    });
    expect(launched.n).toBe(0);
  });

  it('reports a business outcome from the bank’s own screen', async () => {
    const { runId } = await createRun(
      db,
      {
        task: 'check-balance',
        bank: 'generic',
        clientId: null,
        inputs: { bank: 'generic', memberId: MEMBERS.missing, account: '1234' },
      },
      KEY,
    );
    await executeRun(runId, deps());
    expect(await resultOf(db, runId)).toMatchObject({
      status: 'business_outcome',
      code: 'no_such_member',
      message: 'The bank has no member with that number.',
    });
  }, 180_000);
});
