import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApprovalContext,
  createRun,
  resultOf,
  verifyJournal,
} from '../../packages/runs/src/index.js';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { type Harness, KEY, transferHarness } from './transfer-harness.js';

// A transfer run end to end (plan, §6): the Runner prepares it up to the bank's review page and
// parks there holding its browser; a person approves from the Console; the run submits once under
// the grant and finds the transfer in the history. The bank's ledger counts what moved.

let h: Harness;
beforeAll(async () => {
  h = await transferHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('a transfer run', () => {
  it('parks for approval with the review as read, then posts once under the grant', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 12_500, memo: 'rent' });
    const launched = h.browsers.length;
    const done = h.execute(runId);
    const task = await h.approval(runId);

    // While parked: waiting on a person, with what the bank's review page said, masked.
    expect(await resultOf(h.db, runId)).toMatchObject({
      status: 'needs_human',
      code: 'awaiting_approval',
      pending: { kind: 'approval' },
    });
    const context = (
      await h.db.query<{ contextMasked: ApprovalContext & { frame: { seq: number } } }>(
        'SELECT "contextMasked" FROM "HumanTask" WHERE id = $1',
        [task],
      )
    ).rows[0]!.contextMasked;
    expect(context.review).toMatchObject({
      amountCents: 12_500,
      memo: `${memoToken} rent`,
      memoToken,
    });
    expect(context.review.from).toMatch(/Everyday Checking/);
    expect(context.review.to).toMatch(/Rainy Day Savings/);
    // The accounts as the grant binds them: not one digit of an account number.
    expect(`${context.review.from} ${context.review.to}`).not.toMatch(/\d/);
    // The frame beside it is the review page's own, and its picture was stored masked.
    expect(context.frame).toMatchObject({ runId });
    const frame = (
      await h.db.query<{ imageKey: string | null; screen: string | null }>(
        `SELECT f."imageKey", s.screen FROM "TrailFrame" f JOIN "Step" s ON s."runId" = f."runId" AND s.seq = f."stepSeq"
          WHERE f."runId" = $1 AND f.seq = $2`,
        [runId, context.frame.seq],
      )
    ).rows[0]!;
    expect(frame.screen).toBe('transfer.review');
    expect(await h.store.get(frame.imageKey!)).not.toBeNull();
    expect(await h.postings(memoToken)).toBe(0);

    expect(await h.act(task, 'approve')).toBe(200);
    expect(await done).toMatchObject({ status: 'succeeded' });
    const result = await resultOf(h.db, runId);
    expect(result).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    expect((result!.data as { confirmation: string }).confirmation).toMatch(/^GB-/);
    expect(await h.postings(memoToken)).toBe(1);

    // The grant is spent, the journal holds the intent, the press and the checks, and verifies.
    const grant = (
      await h.db.query<{ usedAt: Date | null }>(
        'SELECT "usedAt" FROM "ApprovalGrant" WHERE "runId" = $1',
        [runId],
      )
    ).rows;
    expect(grant).toHaveLength(1);
    expect(grant[0]!.usedAt).not.toBeNull();
    expect((await h.journalOf(runId)).filter((l) => l.action === 'pressed')).toHaveLength(1);
    expect(await verifyJournal(h.db, runId)).toMatchObject({ ok: true, entries: 4 });
    // The browser was held while parked: one browser, one sign-in, one code asked of a person.
    expect(h.browsers.length - launched).toBe(1);
    const codes = await h.db.query(
      `SELECT 1 FROM "HumanTask" WHERE "runId" = $1 AND kind = 'staff_code'`,
      [runId],
    );
    expect(codes.rows).toHaveLength(1);
  }, 180_000);

  it('when the bank swallows the submit, reads the history and never presses again', async () => {
    // The bank posts the transfer, then answers with a page that never finishes, or a 502.
    const { runId, memoToken } = await h.start({ amountCents: 4_200, memo: 'swallowed' });
    const done = h.execute(runId, { headers: h.bank.forced(['swallowed-submit']) });
    expect(await h.act(await h.approval(runId), 'approve')).toBe(200);
    expect(await done).toMatchObject({ status: 'succeeded' });
    expect(await resultOf(h.db, runId)).toMatchObject({
      status: 'succeeded',
      data: { confirmation: memoToken, seenInHistory: true },
    });
    // No confirmation ever came: the history found it. One press, one posting, by the bank's ledger.
    const journal = await h.journalOf(runId);
    expect(journal.some((l) => l.intent === 'read the confirmation')).toBe(false);
    expect(journal.filter((l) => l.action === 'pressed')).toHaveLength(1);
    expect(await h.postings(memoToken)).toBe(1);
  }, 180_000);

  it('never makes up a memo token: a run created without one stops before any browser opens', async () => {
    const { runId } = await createRun(
      h.db,
      {
        task: 'transfer',
        bank: 'generic',
        clientId: null,
        inputs: {
          bank: 'generic',
          memberId: MEMBERS.demo,
          from: 'Everyday Checking',
          to: 'Rainy Day Savings',
          amountCents: 1_000,
          idempotencyKey: 'no-token-0001',
        },
      },
      KEY,
    );
    const launched = h.browsers.length;
    expect(await h.execute(runId)).toMatchObject({ status: 'escalated', code: 'stuck' });
    expect(h.browsers.length).toBe(launched);
  });
});
