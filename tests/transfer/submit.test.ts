import { describe, expect, it } from 'vitest';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { submitHarness } from '../support/submit.js';

// Submitting a transfer once, under a grant, and confirming it in the account's history (plan,
// §F.1 steps 4 and 5, §F.2). The bank's own ledger is the judge: never two postings for one grant.
// The swallowed submit, which waits out the bank's endless "Processing" page, is in
// tests/long/swallowed-submit.test.ts.

const { transfer, postings, token, verify } = submitHarness();

describe('submitting a transfer under a grant', () => {
  it('posts once, reads the confirmation, finds it in the history, and journals each step', async () => {
    const memoToken = token();
    const { runId, out } = await transfer({
      memberId: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 12_500,
      memoToken,
    });
    expect(out).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    if (out.status === 'succeeded') expect(out.data.confirmation).toMatch(/^GB-/);
    expect(await postings(memoToken)).toBe(1);
    expect(await verify(runId)).toMatchObject({ ok: true, entries: 4 });
  }, 300_000);

  it('refuses the click when the grant is for a different amount, and posts nothing', async () => {
    const memoToken = token();
    const { out } = await transfer(
      {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 12_500,
        memoToken,
      },
      { grantAmount: 99_900 },
    );
    expect(out).toMatchObject({ status: 'escalated', code: 'guard_tripped' });
    expect(await postings(memoToken)).toBe(0);
  }, 300_000);

  it('never uses a grant twice', async () => {
    const memoToken = token();
    const { out, replay } = await transfer(
      {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 4_000,
        memoToken,
      },
      { replay: true },
    );
    expect(out.status).toBe('succeeded');
    expect(replay).toMatchObject({ status: 'escalated', code: 'guard_tripped' });
    expect(await postings(memoToken)).toBe(1);
  }, 300_000);

  it('answers the supervisor page over the threshold with the code the bank sent', async () => {
    const memoToken = token();
    const { out } = await transfer({
      memberId: MEMBERS.demo,
      from: 'Rainy Day Savings',
      to: 'Everyday Checking',
      amountCents: 300_000,
      memoToken,
    });
    expect(out).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    expect(await postings(memoToken)).toBe(1);
  }, 300_000);
});
