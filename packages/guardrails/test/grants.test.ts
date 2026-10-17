import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlDb } from '../../oauth/test/control.js';
import { consumeGrant, decide, GRANT_LIFETIME_MS, issueGrant, tripGuard } from '../src/index.js';
import { approvedRun, parkedRun, REVIEW } from './support.js';

let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(() => db.close());

const submit = (grant?: Awaited<ReturnType<typeof consumeGrant>>) =>
  decide('transfer', 'transfer.review', 'press', 'Submit transfer', grant ? { grant } : {});

describe('approval grants', () => {
  it('are bound to the run and the approved values, with a random nonce, for five minutes', async () => {
    const now = new Date('2026-03-02T15:00:00Z');
    const a = await approvedRun(db, now);
    const b = await approvedRun(db, now);
    expect(a.expiresAt).toEqual(new Date(now.getTime() + GRANT_LIFETIME_MS));
    expect(GRANT_LIFETIME_MS).toBe(5 * 60_000);
    expect(a.nonce).not.toEqual(b.nonce);
    const row = (await db.query('SELECT * FROM "ApprovalGrant" WHERE id = $1', [a.grantId]))
      .rows[0];
    expect(row).toMatchObject({ runId: a.runId, humanTaskId: a.humanTaskId, ...REVIEW });
    expect(row).toMatchObject({ usedAt: null });
  });

  it('let the submit through exactly once when the screen matches', async () => {
    const { runId } = await approvedRun(db);
    const first = await consumeGrant(db, { runId, screen: REVIEW });
    expect(first.ok).toBe(true);
    expect(submit(first)).toEqual({ allowed: true });

    const again = await consumeGrant(db, { runId, screen: REVIEW });
    expect(again).toEqual({ ok: false, reason: 'already used' });
    expect(submit(again)).toEqual({
      allowed: false,
      layer: 'approval grant',
      rule: '"Submit transfer" needs an approval grant: already used',
    });
  });

  it('refuse the submit with no grant at all', async () => {
    const { runId } = await parkedRun(db);
    const check = await consumeGrant(db, { runId, screen: REVIEW });
    expect(check).toEqual({ ok: false, reason: 'no grant' });
    expect(submit(check)).toMatchObject({ allowed: false, layer: 'approval grant' });
    expect(submit()).toMatchObject({ allowed: false, layer: 'approval grant' });
  });

  it('refuse the submit once the grant has expired', async () => {
    const issued = new Date('2026-03-02T15:00:00Z');
    const { runId } = await approvedRun(db, issued);
    const late = new Date(issued.getTime() + GRANT_LIFETIME_MS);
    const check = await consumeGrant(db, { runId, screen: REVIEW }, late);
    expect(check).toEqual({ ok: false, reason: 'expired' });
    expect(submit(check)).toMatchObject({ allowed: false, layer: 'approval grant' });
  });

  it('refuse the submit when the screen shows anything but what the person approved', async () => {
    const cases = [
      [{ amountCents: REVIEW.amountCents + 1 }, 'the screen shows a different amount'],
      [{ fromRef: '****0000' }, 'the screen shows different accounts'],
      [{ toRef: '****0000' }, 'the screen shows different accounts'],
      [{ memoToken: 'GBX 0000' }, 'the screen shows a different memo'],
    ] as const;
    for (const [change, reason] of cases) {
      const { runId } = await approvedRun(db);
      const check = await consumeGrant(db, { runId, screen: { ...REVIEW, ...change } });
      expect(check).toEqual({ ok: false, reason });
      expect(submit(check)).toMatchObject({ allowed: false, layer: 'approval grant' });
      // A mismatch spends nothing: the screen that matches still gets its one click.
      expect((await consumeGrant(db, { runId, screen: REVIEW })).ok).toBe(true);
    }
  });

  it('belong to their own run: another run’s grant opens nothing', async () => {
    await approvedRun(db);
    const { runId } = await parkedRun(db);
    expect(await consumeGrant(db, { runId, screen: REVIEW })).toEqual({
      ok: false,
      reason: 'no grant',
    });
  });

  it('are used once even when consumers race for them', async () => {
    const { runId } = await approvedRun(db);
    const checks = await Promise.all(
      Array.from({ length: 8 }, () => consumeGrant(db, { runId, screen: REVIEW })),
    );
    expect(checks.filter((c) => c.ok)).toHaveLength(1);
    expect(checks.filter((c) => !c.ok)).toEqual(
      Array(7).fill({ ok: false, reason: 'already used' }),
    );
    expect(checks.filter((c) => submit(c).allowed)).toHaveLength(1);
  });

  it('cover a whole, positive number of cents', async () => {
    const run = await parkedRun(db);
    await expect(issueGrant(db, { ...run, ...REVIEW, amountCents: 0 })).rejects.toThrow();
    await expect(issueGrant(db, { ...run, ...REVIEW, amountCents: 1.5 })).rejects.toThrow();
  });
});

describe('a guard trip', () => {
  it('freezes the bank and hands back the ending', async () => {
    const { runId } = await parkedRun(db);
    const t = await tripGuard(db, {
      runId,
      bank: 'generic',
      layer: 'element',
      rule: '"Pay now" moves money or changes the account, and transfer does not press "Pay now" on transfer.review',
    });
    const freeze = (await db.query('SELECT * FROM "Freeze" WHERE id = $1', [t.freezeId])).rows[0];
    expect(freeze).toMatchObject({ tenant: 'generic', layer: 'element', runId, clearedAt: null });
    expect(t.ending).toEqual({ status: 'escalated', code: 'guard_tripped' });
  });
});
