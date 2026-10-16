import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBalance,
  type DriverContext,
  downloadStatements,
  prepareTransfer,
  PROFILES,
  type StepRecord,
} from '../../packages/drivers/src/index.js';
import { Browser, guardActions } from '../../packages/screen/src/index.js';
import { runGuard } from '../../apps/runner/src/guard.js';
import { totp } from '../../apps/bank/src/auth.js';
import { accountsOf, findMember } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { statementPdf } from '../../apps/bank/src/statements.js';
import { TENANTS, type TenantId } from '../../apps/bank/src/tenants.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The CoreLink driver on banks 2, 3 and 4, each with its hand-written profile, through a real
// browser: the same product with other words, layouts and quirks. Bank 2 draws some labels and a
// button as pictures and serves its tab strip from another origin; bank 3 draws every heading as a
// picture, has a notices frame, a terms page after sign-in, a bar drawn over its buttons, and
// statements behind a menu; bank 4 has a menu bar, a sign-in from another origin, search results in
// a window, a two-page transfer, an authenticator code, and statements on a page of their own.
// The banks are the judges: the balance is the ledger's, read through the bank's admin API; each
// PDF is the bank's own; and preparing a transfer posts nothing. Every action passes the Runner's
// guard for its job, and none is refused.

/** Last month, as YYYY-MM: always on the bank's list. */
const lastMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

describe.each(['example', 'sample', 'placeholder'] as TenantId[])('CoreLink on %s', (id) => {
  let bank: LiveBank;
  let browser: Browser;
  beforeAll(async () => {
    [bank, browser] = await Promise.all([liveBank(id), Browser.launch()]);
  }, 120_000);
  // The browser goes first: a bank waits for the connections a browser still holds open to it.
  afterAll(async () => {
    await browser?.close();
    await bank?.close();
  });

  /**
   * A run's context, behind the Runner's guard for the job: the person at the staff phone, or with
   * the authenticator app, answers.
   */
  async function context(
    job: 'check-balance' | 'download-statements' | 'transfer',
    steps: StepRecord[],
  ): Promise<DriverContext & { tripped(): unknown }> {
    const page = await browser.newPage();
    const profile = PROFILES[id]!;
    const g = runGuard({ job, profile, secrets: [PASSWORDS.service, OPERATORS.service.id] });
    guardActions(page, g.guard);
    return {
      tripped: g.tripped,
      page,
      profile: { ...profile, url: bank.url },
      credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
      askHuman: async () => {
        if (profile.codeStyle === 'authenticator') {
          const r = await bank.db.query<{ s: string }>(
            'SELECT totp_secret AS s FROM operators WHERE operator_id = $1',
            [OPERATORS.service.id],
          );
          return totp(r.rows[0]!.s, new Date());
        }
        const r = await bank.db.query<{ body: string }>(
          'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
        );
        return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
      },
      learn: () => undefined,
      step: (s) => void steps.push(s),
      now: () => new Date(),
    };
  }

  const ledger = () =>
    bank.admin<{ type: string; number: string; availableCents: number; currentCents: number }[]>(
      `/members/${MEMBERS.demo}/balances`,
    );

  it('checks a balance: the one the ledger holds', async () => {
    const checking = (await ledger()).find((a) => a.type === 'checking')!;
    const steps: StepRecord[] = [];
    const ctx = await context('check-balance', steps);
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
      expect(ctx.tripped()).toBeNull();
    } finally {
      await ctx.page.close();
    }
  }, 180_000);

  it('downloads last month’s statement: the bank’s own PDF', async () => {
    const month = lastMonth();
    const account = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const own = await statementPdf(
      bank.db,
      TENANTS[id],
      (await findMember(bank.db, MEMBERS.demo))!,
      account,
      month,
    );
    const ctx = await context('download-statements', []);
    try {
      const outcome = await downloadStatements(ctx, {
        memberId: MEMBERS.demo,
        account: account.number.slice(-4),
        months: [month],
      });
      // Matched whole, so a failure shows the driver's reason.
      expect(outcome).toMatchObject({ status: 'succeeded' });
      if (outcome.status !== 'succeeded') return;
      const [got] = outcome.data.months;
      expect(got && 'pdf' in got && Buffer.compare(got.pdf, Buffer.from(own!))).toBe(0);
      expect(ctx.tripped()).toBeNull();
    } finally {
      await ctx.page.close();
    }
  }, 180_000);

  it('prepares a transfer up to the review page, and posts nothing', async () => {
    const before = (await bank.admin<{ transfers: unknown[] }>('/state')).transfers.length;
    const accounts = await ledger();
    const ctx = await context('transfer', []);
    try {
      const outcome = await prepareTransfer(ctx, {
        memberId: MEMBERS.demo,
        from: accounts.find((a) => a.type === 'checking')!.number.slice(-4),
        to: 'Rainy Day Savings',
        amountCents: 12_500,
        memo: 'rent',
        memoToken: 'GBX 7Q4M',
      });
      expect(outcome).toMatchObject({
        status: 'succeeded',
        data: { amountCents: 12_500, memo: 'GBX 7Q4M rent' },
      });
      if (outcome.status === 'succeeded') {
        expect(outcome.data.from).toMatch(/^Everyday Checking, /);
        expect(outcome.data.to).toMatch(/^Rainy Day Savings, /);
      }
      expect((await bank.admin<{ transfers: unknown[] }>('/state')).transfers.length).toBe(before);
      expect(ctx.tripped()).toBeNull();
    } finally {
      await ctx.page.close();
    }
  }, 180_000);
});
