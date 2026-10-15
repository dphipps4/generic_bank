import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlDb } from '../../oauth/test/control.js';
import {
  answerHumanTask,
  awaitAnswer,
  createRun,
  inputsOf,
  loadRun,
  maskInputs,
  openHumanTask,
  resultOf,
  seal,
  settleRun,
  unseal,
  waitForResult,
} from '../src/index.js';

const KEY = 's'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(() => db.close());

const input = { bank: 'generic', memberId: '40017732', account: '7890' };

describe('sealing', () => {
  it('round-trips, and refuses anything tampered with or sealed under another key', () => {
    const s = seal(input, KEY);
    expect(unseal(s, KEY)).toEqual(input);
    expect(s).not.toContain('40017732');
    const bad = Buffer.from(s, 'base64url');
    bad[bad.length - 1]! ^= 1;
    expect(() => unseal(bad.toString('base64url'), KEY)).toThrow();
    expect(() => unseal(s, 't'.repeat(40))).toThrow();
  });
});

describe('runs', () => {
  it('store the inputs sealed and masked, never in the clear', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: 'gbc_x', inputs: input },
      KEY,
    );
    const row = JSON.stringify(
      (await db.query('SELECT * FROM "TaskRun" WHERE id = $1', [runId])).rows,
    );
    expect(row).not.toContain('40017732');
    expect(row).not.toContain('7890');
    expect(await inputsOf(db, runId, KEY)).toEqual(input);
    expect(maskInputs(input)).toEqual({ bank: 'generic', memberId: '********', account: '****' });
  });

  it('return the same run for the same idempotency key', async () => {
    const a = await createRun(
      db,
      {
        task: 'transfer',
        bank: 'generic',
        clientId: null,
        inputs: input,
        idempotencyKey: 'key-123456',
      },
      KEY,
    );
    const b = await createRun(
      db,
      {
        task: 'transfer',
        bank: 'generic',
        clientId: null,
        inputs: input,
        idempotencyKey: 'key-123456',
      },
      KEY,
    );
    expect(b).toEqual({ runId: a.runId, existing: true });
  });

  it('end in exactly one result, in our words, and drop the sealed inputs', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    expect(await resultOf(db, runId)).toEqual({ runId, task: 'check-balance', status: 'running' });
    await settleRun(db, runId, { status: 'failed', code: 'record_in_use' });
    expect(await resultOf(db, runId)).toEqual({
      runId,
      task: 'check-balance',
      status: 'failed',
      code: 'record_in_use',
      message: "The member's record is in use at the bank right now.",
      retryable: true,
    });
    expect((await loadRun(db, runId))!.inputsSealed).toBeNull();
    const ok = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    await settleRun(db, ok.runId, { status: 'succeeded', data: { availableCents: 100 } });
    expect((await resultOf(db, ok.runId))!.data).toEqual({ availableCents: 100 });
  });

  it('wait for a result, up to the time asked', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    setTimeout(
      () => void settleRun(db, runId, { status: 'business_outcome', code: 'no_such_member' }),
      400,
    );
    const t = Date.now();
    expect((await waitForResult(db, runId, 5))!.status).toBe('business_outcome');
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('human tasks', () => {
  it('park the run, carry a sealed answer to it, and clear the answer once read', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    const task = await openHumanTask(
      db,
      runId,
      'staff_code',
      { bank: 'generic' },
      new Date(Date.now() + 60_000),
    );
    expect(await resultOf(db, runId)).toMatchObject({ status: 'needs_human' });
    setTimeout(() => void answerHumanTask(db, task, '123456', 'admin@test', KEY), 300);
    expect(await awaitAnswer(db, task, KEY, new Date(Date.now() + 10_000), 100)).toBe('123456');
    const row = (
      await db.query<{ answerSealed: string | null; answeredBy: string }>(
        'SELECT "answerSealed", "answeredBy" FROM "HumanTask" WHERE id = $1',
        [task],
      )
    ).rows[0]!;
    expect(row).toEqual({ answerSealed: null, answeredBy: 'admin@test' });
    expect((await resultOf(db, runId))!.status).toBe('running');
  });

  it('expire at the deadline, and cannot be answered twice', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    const task = await openHumanTask(db, runId, 'staff_code', {}, new Date(Date.now() + 200));
    expect(await awaitAnswer(db, task, KEY, new Date(Date.now() + 200), 50)).toBeNull();
    expect(await answerHumanTask(db, task, '1', 'x', KEY)).toBe(false);
  });
});

describe('the long poll', () => {
  it('waits while a run waits on a person too, and returns when it settles', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    await openHumanTask(db, runId, 'staff_code', {}, new Date(Date.now() + 60_000));
    setTimeout(() => void settleRun(db, runId, { status: 'succeeded', data: {} }), 600);
    const t = Date.now();
    expect((await waitForResult(db, runId, 5))!.status).toBe('succeeded');
    expect(Date.now() - t).toBeGreaterThanOrEqual(500);
  });
});
