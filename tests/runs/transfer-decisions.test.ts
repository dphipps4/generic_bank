import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultOf } from '../../packages/runs/src/index.js';
import { type Harness, transferHarness } from './transfer-harness.js';

// Every decision but Approve ends a parked transfer in the result the plan gives it (§F.1 step 3,
// §F.3), with nothing submitted: the bank's ledger never sees the transfer.

let h: Harness;
beforeAll(async () => {
  h = await transferHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

/** A run parked on the review page, then decided by a person. */
async function decided(action: 'reject' | 'take-over' | 'cancel') {
  const { runId, memoToken } = await h.start({ amountCents: 7_500 });
  const done = h.execute(runId);
  expect(await h.act(await h.approval(runId), action)).toBe(200);
  await done;
  return { runId, memoToken };
}

const grants = async (runId: string) =>
  (await h.db.query('SELECT id FROM "ApprovalGrant" WHERE "runId" = $1', [runId])).rows.length;

describe('a person decides a parked transfer', () => {
  it('Reject: the business outcome approval_rejected', async () => {
    const { runId, memoToken } = await decided('reject');
    expect(await resultOf(h.db, runId)).toMatchObject({
      status: 'business_outcome',
      code: 'approval_rejected',
    });
    expect(await grants(runId)).toBe(0);
    expect(await h.postings(memoToken)).toBe(0);
  }, 300_000);

  it('Take over: handed off, with who took it', async () => {
    const { runId, memoToken } = await decided('take-over');
    expect(await resultOf(h.db, runId)).toMatchObject({
      status: 'handed_off',
      code: 'taken_over',
      resolvedBy: 'staff@test',
    });
    expect(await h.postings(memoToken)).toBe(0);
  }, 300_000);

  it('Cancel: the run stops cleanly', async () => {
    const { runId, memoToken } = await decided('cancel');
    expect(await resultOf(h.db, runId)).toMatchObject({ status: 'cancelled', code: 'cancelled' });
    expect(await h.postings(memoToken)).toBe(0);
  }, 300_000);

  it('nobody answers: the deadline ends it expired', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 7_500 });
    // Long enough for the staff code, which shares the deadline; short enough to pass unanswered.
    expect(await h.execute(runId, { humanDeadlineMs: 15_000 })).toMatchObject({
      status: 'expired',
    });
    const task = (
      await h.db.query<{ status: string }>(
        `SELECT status FROM "HumanTask" WHERE "runId" = $1 AND kind = 'approval'`,
        [runId],
      )
    ).rows;
    expect(task).toEqual([{ status: 'expired' }]);
    expect(await h.postings(memoToken)).toBe(0);
  }, 300_000);
});
