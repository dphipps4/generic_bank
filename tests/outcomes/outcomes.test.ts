import { describe, expect, it } from 'vitest';
import { brief, outcomeBank, RUN, run } from './support.js';

// The error taxonomy (plan, §D.2 to §D.4), one row of each kind from the outcome table, each its
// distinct typed result: the bank's own answer about the member, a session that ends early and is
// signed in again inside the run, and a gateway that answers 503.
const env = outcomeBank();

describe('one business outcome, one recoverable condition, one hard failure', () => {
  it(`${RUN.business.name}: business_outcome, no_such_member`, async () => {
    const m = RUN.business;
    expect(brief(await run(env, m.account, undefined, m.memberId))).toEqual(m.expected);
  }, 120_000);

  it(`${RUN.recoverable.hazard}: succeeded`, async () => {
    expect(brief(await run(env, 'Everyday Checking', [RUN.recoverable.hazard]))).toEqual(
      RUN.recoverable.expected,
    );
  }, 120_000);

  it(`${RUN.hard.hazard}: failed, unavailable`, async () => {
    expect(brief(await run(env, 'Everyday Checking', [RUN.hard.hazard]))).toEqual(
      RUN.hard.expected,
    );
  }, 120_000);
});
