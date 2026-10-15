import { describe, expect, it } from 'vitest';
import { brief, CASES, outcomeBank, run } from './support.js';

// The outcome table: the member's own cases, each its business outcome.
const env = outcomeBank();

describe('the member’s own cases', () => {
  it('no such member, a closed member, no such account', async () => {
    for (const m of CASES.members.slice(1))
      expect(brief(await run(env, m.account, undefined, m.memberId))).toEqual(m.expected);
  }, 600_000);
});
