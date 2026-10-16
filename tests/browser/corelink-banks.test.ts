import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBalance,
  type DriverContext,
  PROFILES,
  type StepRecord,
} from '../../packages/drivers/src/index.js';
import { Browser, guardActions } from '../../packages/screen/src/index.js';
import { runGuard } from '../../apps/runner/src/guard.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The CoreLink driver on bank 2, Example Credit Union, with its hand-written profile, through a real
// browser: the same product with other words, layouts and quirks. It draws some labels and a button
// as pictures and serves its tab strip from another origin. The bank is the judge: the balance is
// the ledger's, read through the bank's admin API. Every action passes the Runner's guard for its
// job, and none is refused.

let bank: LiveBank;
let browser: Browser;
beforeAll(async () => {
  [bank, browser] = await Promise.all([liveBank('example'), Browser.launch()]);
}, 120_000);
// The browser goes first: a bank waits for the connections a browser still holds open to it.
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

describe('CoreLink on example', () => {
  it('checks a balance: the one the ledger holds', async () => {
    const checking = (
      await bank.admin<
        { type: string; number: string; availableCents: number; currentCents: number }[]
      >(`/members/${MEMBERS.demo}/balances`)
    ).find((a) => a.type === 'checking')!;
    const profile = PROFILES.example!;
    const page = await browser.newPage();
    const g = runGuard({
      job: 'check-balance',
      profile,
      secrets: [PASSWORDS.service, OPERATORS.service.id],
    });
    guardActions(page, g.guard);
    const steps: StepRecord[] = [];
    const ctx: DriverContext = {
      page,
      profile: { ...profile, url: bank.url },
      credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
      askHuman: async () => {
        const r = await bank.db.query<{ body: string }>(
          'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
        );
        return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
      },
      learn: () => undefined,
      step: (s) => void steps.push(s),
      now: () => new Date(),
    };
    try {
      const outcome = await checkBalance(ctx, {
        memberId: MEMBERS.demo,
        account: checking.number.slice(-4),
      });
      expect(outcome).toMatchObject({
        status: 'succeeded',
        data: { availableCents: checking.availableCents, currentCents: checking.currentCents },
      });
      expect(steps.map((s) => s.name)).toEqual(
        expect.arrayContaining(['sign in', 'staff code', 'member search', 'balance']),
      );
      expect(g.tripped()).toBeNull();
    } finally {
      await page.close();
    }
  }, 120_000);
});
