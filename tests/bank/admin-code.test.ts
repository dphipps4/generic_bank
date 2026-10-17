// The bank's own word for a teller's sign-in code, which the factory's hazard check types: the
// last code the bank sent them, or, at a bank whose staff use an authenticator, the app's code.
import { afterAll, describe, expect, it } from 'vitest';
import { totp } from '../../apps/bank/src/auth.js';
import { OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank } from '../support/banks.js';

const open: LiveBank[] = [];
afterAll(async () => {
  for (const b of open) await b.close();
});

describe("the bank admin's code for an operator", () => {
  it('is the last code sent to them, and none before one is sent', async () => {
    const b = await liveBank('generic');
    open.push(b);
    const path = `/operators/${OPERATORS.service.id}/code`;
    await expect(b.admin(path)).rejects.toThrow(/404/);
    const { phone } = (
      await b.db.query<{ phone: string }>('SELECT phone FROM operators WHERE operator_id = $1', [
        OPERATORS.service.id,
      ])
    ).rows[0]!;
    await b.db.query('INSERT INTO messages (mailbox, address, body, at) VALUES ($1, $2, $3, $4)', [
      'phone',
      phone,
      'Generic Bank: your CoreLink sign-in code is 123456. It expires in 5 minutes.',
      new Date(),
    ]);
    expect(await b.admin(path)).toEqual({ code: '123456' });
  });

  it("is the authenticator's at a bank whose staff use one", async () => {
    const b = await liveBank('placeholder');
    open.push(b);
    const { s } = (
      await b.db.query<{ s: string }>(
        'SELECT totp_secret AS s FROM operators WHERE operator_id = $1',
        [OPERATORS.service.id],
      )
    ).rows[0]!;
    const { code } = await b.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`);
    // A code changes every 30 seconds; either side of a boundary is the app's.
    const now = Date.now();
    expect([totp(s, new Date(now - 30_000)), totp(s, new Date(now))]).toContain(code);
  });
});
