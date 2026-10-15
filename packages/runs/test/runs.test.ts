import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlDb } from '../../oauth/test/control.js';
import {
  actOnHumanTask,
  answerHumanTask,
  awaitAnswer,
  createRun,
  inputsOf,
  loadRun,
  maskInputs,
  noteAsk,
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
    const deadline = (
      await db.query<{ deadline: Date }>('SELECT deadline FROM "HumanTask" WHERE id = $1', [task])
    ).rows[0]!.deadline;
    expect(await resultOf(db, runId)).toMatchObject({
      status: 'needs_human',
      code: 'awaiting_staff_code',
      pending: { kind: 'staff_code', deadline: new Date(deadline).toISOString() },
    });
    setTimeout(() => void answerHumanTask(db, task, '123456', 'admin@test', KEY), 300);
    expect(await awaitAnswer(db, task, KEY, new Date(Date.now() + 10_000), 100)).toEqual({
      status: 'answered',
      answer: '123456',
    });
    const row = (
      await db.query<{ answerSealed: string | null; answeredBy: string }>(
        'SELECT "answerSealed", "answeredBy" FROM "HumanTask" WHERE id = $1',
        [task],
      )
    ).rows[0]!;
    expect(row).toEqual({ answerSealed: null, answeredBy: 'admin@test' });
    expect((await resultOf(db, runId))!.status).toBe('running');
  });

  it('say what a transfer waits for: an approval, then a supervisor code, both as approval', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    await openHumanTask(db, runId, 'approval', {}, new Date(Date.now() + 60_000));
    expect(await resultOf(db, runId)).toMatchObject({
      code: 'awaiting_approval',
      pending: { kind: 'approval' },
    });
    await openHumanTask(db, runId, 'supervisor_code', {}, new Date(Date.now() + 60_000));
    expect(await resultOf(db, runId)).toMatchObject({
      code: 'awaiting_approval',
      pending: { kind: 'supervisor_code' },
    });
  });

  it('expire at the deadline, and cannot be answered twice', async () => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    const task = await openHumanTask(db, runId, 'staff_code', {}, new Date(Date.now() + 200));
    expect(await awaitAnswer(db, task, KEY, new Date(Date.now() + 200), 50)).toEqual({
      status: 'expired',
    });
    expect(await answerHumanTask(db, task, '1', 'x', KEY)).toBe(false);
  });
});

describe('acting on a human task', () => {
  const open = async (kind: 'staff_code' | 'approval' = 'staff_code') => {
    const { runId } = await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    const task = await openHumanTask(db, runId, kind, {}, new Date(Date.now() + 60_000));
    return { runId, task };
  };
  const audit = async (task: string) =>
    (
      await db.query<{ actor: string; action: string; reason: string }>(
        'SELECT actor, action, reason FROM "AuditEntry" WHERE target = $1 ORDER BY at',
        [task],
      )
    ).rows;

  it('seals a code, audits the answer without it, and refuses a second answer', async () => {
    const { task } = await open();
    expect(await actOnHumanTask(db, task, 'answer', { code: '482913' }, 'ann@bank', KEY)).toEqual({
      ok: true,
    });
    const row = (
      await db.query<Record<string, unknown>>('SELECT * FROM "HumanTask" WHERE id = $1', [task])
    ).rows[0]!;
    expect(row).toMatchObject({ status: 'answered', action: 'answer', answeredBy: 'ann@bank' });
    expect(JSON.stringify(row)).not.toContain('482913');
    expect(JSON.stringify(await audit(task))).not.toContain('482913');
    expect(await audit(task)).toEqual([
      { actor: 'ann@bank', action: 'human_task.answer', reason: 'entered the code the bank sent' },
    ]);
    expect(await actOnHumanTask(db, task, 'answer', { code: '111111' }, 'bo@bank', KEY)).toEqual({
      ok: false,
      status: 409,
      reason: 'the task is answered',
    });
  });

  it('cancels with a reason, and the waiting run hears it as cancelled', async () => {
    const { task } = await open();
    const waiting = awaitAnswer(db, task, KEY, new Date(Date.now() + 10_000), 50);
    expect(await actOnHumanTask(db, task, 'cancel', { reason: 'short' }, 'ann@bank', KEY)).toEqual({
      ok: false,
      status: 400,
      reason: 'a reason of at least ten characters',
    });
    expect(
      await actOnHumanTask(db, task, 'cancel', { reason: 'member left the branch' }, 'ann', KEY),
    ).toEqual({ ok: true });
    expect(await waiting).toEqual({ status: 'cancelled' });
    expect(await audit(task)).toEqual([
      { actor: 'ann', action: 'human_task.cancel', reason: 'member left the branch' },
    ]);
  });

  it('refuses an action the task does not offer, and a task that does not exist', async () => {
    const { task } = await open();
    expect(
      await actOnHumanTask(db, task, 'approve', { reason: 'looks right to me' }, 'a', KEY),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await actOnHumanTask(db, 'h_none', 'answer', { code: '123456' }, 'a', KEY)).toEqual({
      ok: false,
      status: 404,
      reason: 'there is no such task',
    });
    expect(await audit(task)).toEqual([]);
  });

  it('counts how often the agent asks while a person has not answered', async () => {
    const { runId, task } = await open();
    await noteAsk(db, runId);
    await noteAsk(db, runId);
    const r = await db.query<{ asks: number }>('SELECT asks FROM "HumanTask" WHERE id = $1', [
      task,
    ]);
    expect(r.rows[0]!.asks).toBe(2);
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
