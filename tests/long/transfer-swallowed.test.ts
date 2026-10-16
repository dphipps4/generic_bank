import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, transferHarness } from '../runs/transfer-harness.js';

// The Runner under a swallowed submit (plan, §F.2): the bank posts the transfer but answers with a
// "Processing" page that never finishes. The run waits out the 3 minutes a slow bank is allowed,
// then reads the history and never presses again. The bank's ledger shows one posting.

let h: Harness;
beforeAll(async () => {
  h = await transferHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const presses = async (runId: string) =>
  (await h.journalOf(runId)).filter((l) => l.intent.startsWith('press ') && !l.result);

describe('a transfer run under a swallowed submit', () => {
  it('a swallowed submit is read from the history, never pressed again: one posting', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 2_500 });
    const done = h.execute(runId, { headers: h.bank.forced(['swallowed-submit']) });
    expect(await h.act(await h.approval(runId), 'approve')).toBe(200);
    // The confirmation never came, so the reference is the one read from the history.
    expect(await done).toMatchObject({
      status: 'succeeded',
      data: { confirmation: memoToken, seenInHistory: true },
    });
    expect(await h.postings(memoToken)).toBe(1);
    // One intent, one press.
    expect((await presses(runId)).map((l) => l.action)).toEqual([null, 'pressed']);
    expect(await h.journalOf(runId)).toContainEqual(
      expect.objectContaining({ intent: 'find the memo token in the history', result: '1 found' }),
    );
  }, 420_000);
});
