import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlDb } from '../../oauth/test/control.js';
import {
  actOnHumanTask,
  answerHumanTask,
  awaitAnswer,
  awaitDecision,
  createRun,
  DuplicateRun,
  inputsOf,
  loadRun,
  maskInputs,
  newMemoToken,
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
const review = {
  from: '****7890',
  to: '****1234',
  amountCents: 125_000,
  memo: 'GBX 7Q4M rent',
  memoToken: 'GBX 7Q4M',
};

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

  it('treat another client’s idempotency key as a new key, never as a way into its run', async () => {
    const start = (clientId: string) =>
      createRun(
        db,
        {
          task: 'transfer',
          bank: 'generic',
          clientId,
          inputs: input,
          idempotencyKey: 'key-shared',
        },
        KEY,
      );
    const mine = await start('gbc_mine');
    const theirs = await start('gbc_theirs');
    expect(theirs.existing).toBe(false);
    expect(theirs.runId).not.toBe(mine.runId);
    expect(await start('gbc_mine')).toEqual({ runId: mine.runId, existing: true });
  });

  it('refuse a second open run for the same transfer, and allow it once the first has ended', async () => {
    const same = ['40017732', '7890', '1234', 12_500];
    const start = (key: string, dedupeOn = same) =>
      createRun(
        db,
        {
          task: 'transfer',
          bank: 'generic',
          clientId: 'gbc_dup',
          inputs: input,
          idempotencyKey: key,
          dedupeOn,
        },
        KEY,
      );
    const first = await start('dup-key-1');
    const refused = await start('dup-key-2').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DuplicateRun);
    expect((refused as DuplicateRun).runId).toBe(first.runId);
    // The same key is still the same run, not a duplicate of itself.
    expect(await start('dup-key-1')).toEqual({ runId: first.runId, existing: true });
    // A different amount is a different transfer.
    expect((await start('dup-key-3', ['40017732', '7890', '1234', 12_501])).existing).toBe(false);
    for (const status of ['needs_human', 'escalated'] as const) {
      await db.query('UPDATE "TaskRun" SET status = $2 WHERE id = $1', [first.runId, status]);
      expect(await start('dup-key-2').catch((e: unknown) => e)).toBeInstanceOf(DuplicateRun);
    }
    await settleRun(db, first.runId, { status: 'business_outcome', code: 'approval_rejected' });
    expect((await start('dup-key-2')).existing).toBe(false);
    const stored = JSON.stringify(
      (await db.query('SELECT "dedupeKey" FROM "TaskRun" WHERE id = $1', [first.runId])).rows,
    );
    expect(stored).not.toContain('40017732');
  });

  it('let only one of two simultaneous requests for the same transfer through', async () => {
    const start = (key: string) =>
      createRun(
        db,
        {
          task: 'transfer',
          bank: 'generic',
          clientId: 'gbc_race',
          inputs: input,
          idempotencyKey: key,
          dedupeOn: ['40017732', '7890', '1234', 9_900],
        },
        KEY,
      ).catch((e: unknown) => e);
    const [a, b, c] = await Promise.all([start('race-1'), start('race-2'), start('race-1')]);
    const made = [a, b, c].filter((r) => !(r instanceof DuplicateRun)) as { runId: string }[];
    const refused = [a, b, c].filter((r) => r instanceof DuplicateRun) as DuplicateRun[];
    expect(new Set(made.map((r) => r.runId)).size).toBe(1);
    expect(refused.every((r) => r.runId === made[0]!.runId)).toBe(true);
    const n = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "TaskRun" WHERE "clientId" = 'gbc_race'`,
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it('mint a memo token the bank’s memo field accepts', () => {
    const tokens = new Set(Array.from({ length: 200 }, newMemoToken));
    expect(tokens.size).toBeGreaterThan(190);
    for (const t of tokens) expect(t).toMatch(/^GBX [0-9A-Z]{4}$/);
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
    await openHumanTask(db, runId, 'approval', { review }, new Date(Date.now() + 60_000));
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

describe('an approval', () => {
  const parked = async (ms = 60_000) => {
    const { runId } = await createRun(
      db,
      { task: 'transfer', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    const task = await openHumanTask(
      db,
      runId,
      'approval',
      { review, frame: { runId, seq: 4 } },
      new Date(Date.now() + ms),
    );
    return { runId, task };
  };
  const grants = async (runId: string) =>
    (
      await db.query<Record<string, unknown>>(
        'SELECT "humanTaskId", "fromRef", "toRef", "amountCents", "memoToken", "expiresAt", "usedAt" FROM "ApprovalGrant" WHERE "runId" = $1',
        [runId],
      )
    ).rows;
  const why = 'checked it with the member';

  it('cannot be approved without the review page as read', async () => {
    const { runId } = await createRun(
      db,
      { task: 'transfer', bank: 'generic', clientId: null, inputs: input },
      KEY,
    );
    const task = await openHumanTask(
      db,
      runId,
      'approval',
      { review: { ...review, memoToken: undefined } },
      new Date(Date.now() + 60_000),
    );
    expect(await actOnHumanTask(db, task, 'approve', { reason: why }, 'ann', KEY)).toEqual({
      ok: false,
      status: 409,
      reason: 'the task has no review to approve',
    });
    expect(await grants(runId)).toEqual([]);
    expect(
      (await db.query<{ status: string }>('SELECT status FROM "HumanTask" WHERE id = $1', [task]))
        .rows[0]!.status,
    ).toBe('open');
  });

  it('approved, issues exactly one grant for the review as read, for five minutes', async () => {
    const { runId, task } = await parked();
    const waiting = awaitDecision(db, task, new Date(Date.now() + 10_000), 50);
    const before = Date.now();
    expect(await actOnHumanTask(db, task, 'approve', { reason: why }, 'ann', KEY)).toEqual({
      ok: true,
    });
    const g = await grants(runId);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({
      humanTaskId: task,
      fromRef: '****7890',
      toRef: '****1234',
      amountCents: 125_000,
      memoToken: 'GBX 7Q4M',
      usedAt: null,
    });
    const life = (g[0]!.expiresAt as Date).getTime() - before;
    expect(life).toBeGreaterThan(5 * 60_000 - 5_000);
    expect(life).toBeLessThanOrEqual(5 * 60_000 + 1_000);
    const decided = await waiting;
    expect(decided).toEqual({ status: 'approved', grantId: expect.stringMatching(/^g_/) });
    const id = (
      await db.query<{ id: string }>('SELECT id FROM "ApprovalGrant" WHERE "runId" = $1', [runId])
    ).rows[0]!.id;
    expect(decided).toEqual({ status: 'approved', grantId: id });
    expect((await resultOf(db, runId))!.status).toBe('running');
    expect(
      (await db.query('SELECT actor, action, reason FROM "AuditEntry" WHERE target = $1', [task]))
        .rows,
    ).toEqual([{ actor: 'ann', action: 'human_task.approve', reason: why }]);
  });

  it('is decided once: a second decision is refused and issues nothing', async () => {
    const { runId, task } = await parked();
    expect(await actOnHumanTask(db, task, 'approve', { reason: why }, 'ann', KEY)).toEqual({
      ok: true,
    });
    for (const a of ['approve', 'reject', 'take_over', 'cancel'] as const)
      expect(await actOnHumanTask(db, task, a, { reason: why }, 'bo', KEY)).toEqual({
        ok: false,
        status: 409,
        reason: 'the task is answered',
      });
    expect(await grants(runId)).toHaveLength(1);
  });

  it('two people approving at once issue one grant between them', async () => {
    const { runId, task } = await parked();
    const both = await Promise.all([
      actOnHumanTask(db, task, 'approve', { reason: why }, 'ann', KEY),
      actOnHumanTask(db, task, 'approve', { reason: why }, 'bo', KEY),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await grants(runId)).toHaveLength(1);
  });

  it.each([
    ['reject', 'answered', { status: 'rejected' }],
    ['take_over', 'answered', { status: 'taken_over' }],
    ['cancel', 'cancelled', { status: 'cancelled' }],
  ] as const)(
    '%s: needs a reason, is audited, issues no grant',
    async (action, status, decision) => {
      const { runId, task } = await parked();
      const waiting = awaitDecision(db, task, new Date(Date.now() + 10_000), 50);
      expect(await actOnHumanTask(db, task, action, { reason: 'no' }, 'ann', KEY)).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(await actOnHumanTask(db, task, action, { reason: why }, 'ann', KEY)).toEqual({
        ok: true,
      });
      expect(await waiting).toEqual(decision);
      const row = (
        await db.query<Record<string, unknown>>(
          'SELECT status, action, reason, "answeredBy" FROM "HumanTask" WHERE id = $1',
          [task],
        )
      ).rows[0];
      expect(row).toEqual({ status, action, reason: why, answeredBy: 'ann' });
      expect(await grants(runId)).toEqual([]);
      expect(
        (await db.query('SELECT action FROM "AuditEntry" WHERE target = $1', [task])).rows,
      ).toEqual([{ action: `human_task.${action}` }]);
    },
  );

  it('stays open when its grant cannot be issued', async () => {
    const { runId, task } = await parked();
    // A grant row already bound to the task: the new grant's insert fails.
    await db.query(
      `INSERT INTO "ApprovalGrant" (id, "humanTaskId", "runId", "fromRef", "toRef", "amountCents", "memoToken", nonce, "expiresAt")
       VALUES ('g_stale', $1, 'r_other', 'a', 'b', 1, 'm', 'n_stale', now())`,
      [task],
    );
    await expect(
      actOnHumanTask(db, task, 'approve', { reason: why }, 'ann', KEY),
    ).rejects.toThrow();
    const row = (
      await db.query<Record<string, unknown>>(
        'SELECT status, action, "answeredBy" FROM "HumanTask" WHERE id = $1',
        [task],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'open', action: null, answeredBy: null });
    expect(await grants(runId)).toEqual([]);
  });

  it('expires at its deadline, and then cannot be approved', async () => {
    const { runId, task } = await parked(200);
    expect(await awaitDecision(db, task, new Date(Date.now() + 200), 50)).toEqual({
      status: 'expired',
    });
    expect(await actOnHumanTask(db, task, 'approve', { reason: why }, 'ann', KEY)).toEqual({
      ok: false,
      status: 409,
      reason: 'the task is expired',
    });
    expect(await grants(runId)).toEqual([]);
  });

  it('a code task offers no approval, and an approval takes no code', async () => {
    const { task } = await parked();
    expect(await actOnHumanTask(db, task, 'answer', { code: '123456' }, 'ann', KEY)).toMatchObject({
      ok: false,
      status: 409,
    });
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
