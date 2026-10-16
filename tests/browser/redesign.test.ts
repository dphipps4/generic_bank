import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBalance,
  type DriverContext,
  downloadStatements,
  GENERIC_BANK,
  prepareTransfer,
  type StepRecord,
} from '../../packages/drivers/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The hand-written CoreLink driver against Generic Bank after its vendor's redesign
// (BANK_REDESIGN=1, set here for this bank only). The driver knows the old screens, so it must
// stop where the new ones begin, as an escalation, and never return a wrong answer.

let browser: Browser;
let bank: LiveBank;
beforeAll(async () => {
  [bank, browser] = await Promise.all([liveBank('generic', { redesign: true }), Browser.launch()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

async function run<T>(job: (ctx: DriverContext) => Promise<T>) {
  const page = await browser.newPage();
  const steps: StepRecord[] = [];
  const ctx: DriverContext = {
    page,
    profile: { ...GENERIC_BANK, url: bank.url },
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
    return { outcome: await job(ctx), steps };
  } finally {
    await page.close();
  }
}

const count = async (table: string) =>
  (await bank.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

describe('the CoreLink driver on a redesigned Generic Bank', () => {
  it('Check Balance signs in, meets "We\'ve refreshed Online Banking", and escalates', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const { outcome, steps } = await run((ctx) =>
      checkBalance(ctx, { memberId: MEMBERS.demo, account: acct.number.slice(-4) }),
    );
    expect(outcome).toMatchObject({ status: 'escalated', code: 'unknown_screen' });
    // It got through the sign-in it knows, and stopped at the first screen it does not.
    expect(steps.map((s) => s.name)).toEqual(expect.arrayContaining(['sign in', 'staff code']));
    expect(steps.at(-1)).toMatchObject({ name: 'unknown', outcome: 'unknown screen' });
    expect(steps.map((s) => s.name)).not.toContain('balance');
  }, 120_000);

  it('Download Statements and a transfer stop there too, keeping nothing and posting nothing', async () => {
    const before = { transfers: await count('transfers'), changes: await count('state_changes') };
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const statements = await run((ctx) =>
      downloadStatements(ctx, {
        memberId: MEMBERS.demo,
        account: 'Everyday Checking',
        months: [lastMonth.toISOString().slice(0, 7)],
      }),
    );
    expect(statements.outcome).toMatchObject({ status: 'escalated', code: 'unknown_screen' });
    const transfer = await run((ctx) =>
      prepareTransfer(ctx, {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 2_500,
        memoToken: 'GBX 7Q4M',
      }),
    );
    expect(transfer.outcome).toMatchObject({ status: 'escalated', code: 'unknown_screen' });
    expect(await count('transfers')).toBe(before.transfers);
    expect(await count('state_changes')).toBe(before.changes);
  }, 240_000);
});
