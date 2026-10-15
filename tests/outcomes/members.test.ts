import { describe, expect, it } from 'vitest';
import { brief, MEMBERS, outcomeBank, run } from './support.js';

// The outcome table: the member's own cases, each its business outcome.
const env = outcomeBank();

describe('the member’s own cases', () => {
  it('no such member, a closed member, no such account', async () => {
    expect(brief(await run(env, '1234', undefined, MEMBERS.missing))).toEqual({
      status: 'business_outcome',
      code: 'no_such_member',
    });
    expect(brief(await run(env, '1234', undefined, MEMBERS.closed))).toEqual({
      status: 'business_outcome',
      code: 'member_closed',
    });
    expect(brief(await run(env, '0000'))).toEqual({
      status: 'business_outcome',
      code: 'no_such_account',
    });
  }, 600_000);
});
