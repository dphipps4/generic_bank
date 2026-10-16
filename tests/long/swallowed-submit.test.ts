import { describe, expect, it } from 'vitest';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { submitHarness } from '../support/submit.js';

// A swallowed submit: the bank posts the transfer but answers with a "Processing" page that never
// finishes. The crawler waits out the 3 minutes a slow bank is allowed, then reads the account's
// history instead of pressing again (plan, §F.2). The bank's ledger shows one posting.

const { transfer, postings, token } = submitHarness();

describe('a swallowed submit', () => {
  it('after a swallowed submit, reads the history instead of pressing again: one posting', async () => {
    const memoToken = token();
    const { out } = await transfer(
      {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 2_500,
        memoToken,
      },
      { hazards: ['swallowed-submit'] },
    );
    expect(out).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    expect(await postings(memoToken)).toBe(1);
  }, 420_000);
});
