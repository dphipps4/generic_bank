import { describe, expect, it } from 'vitest';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, outcomeBank, run } from '../outcomes/support.js';

// The long suite: Check Balance under the bank's ambient hazards, run after run, sitting through
// the bank's real latency (a quarter of a second to nearly two on every response). It runs on every
// merge to master and with make test-long, not on each pull request.
const env = outcomeBank({ profile: 'default' });

describe('under the bank’s ambient hazards', () => {
  it('checks a balance correctly, run after run', async () => {
    const acct = (await accountsOf(env.bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await run(env, 'Everyday Checking'));
    // Each run's result, with the reason when it did not succeed.
    expect(
      results.map((r) =>
        r.status === 'succeeded'
          ? r.data.availableCents === acct.availableCents
          : `${r.status}: ${r.code} (${r.note ?? ''})`,
      ),
    ).toEqual([true, true, true, true]);
  }, 600_000);
});
