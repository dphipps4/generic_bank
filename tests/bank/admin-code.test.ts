// The bank's own word for a teller's sign-in code, which the factory's hazard check types: the
// last code the bank sent them.
import { afterAll, describe, expect, it } from 'vitest';
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
      'Generic Bank: your CoreLink sign-in code is 123456. It expires in 7 minutes.',
      new Date(),
    ]);
    expect(await b.admin(path)).toEqual({ code: '123456' });
  });
});
