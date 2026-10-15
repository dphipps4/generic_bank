import { describe, expect, it } from 'vitest';
import { TASKS, TransferInput } from '../src/index.js';

describe('task contracts', () => {
  it('lists the three tasks', () => {
    expect(Object.keys(TASKS).sort()).toEqual(['check-balance', 'download-statements', 'transfer']);
  });

  it('refuses a transfer without an idempotency key', () => {
    const r = TransferInput.safeParse({
      tenant: 'generic',
      memberId: '40017732',
      from: '7890',
      to: '1234',
      amountCents: 1000,
    });
    expect(r.success).toBe(false);
  });
});
