import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DriverContext,
  GENERIC_BANK,
  prepareTransfer,
  type TransferInput,
} from '../../packages/drivers/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// Preparing a transfer on Generic Bank (plan, §F.1 step 1): the driver stops on the review page and
// reads it back, and a refusal in the bank's own words is the business outcome it is. The bank's own
// ledger is the judge: nothing is ever posted by preparing.

let bank: LiveBank;
let browser: Browser;
beforeAll(async () => {
  [bank, browser] = await Promise.all([liveBank('generic'), Browser.launch()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

const posted = async () =>
  Number((await bank.db.query<{ n: string }>('SELECT count(*) AS n FROM transfers')).rows[0]!.n);

async function prepare(input: Omit<TransferInput, 'memoToken'> & { memoToken?: string }) {
  const page = await browser.newPage();
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
    step: () => undefined,
    now: () => new Date(),
  };
  try {
    return await prepareTransfer(ctx, { memoToken: 'GBX 7Q4M', ...input });
  } finally {
    await page.close();
  }
}

describe('preparing a transfer', () => {
  it('stops on the review page, reads it back, and posts nothing', async () => {
    const before = await posted();
    const r = await prepare({
      memberId: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 12_500,
      memo: 'rent',
    });
    expect(r).toMatchObject({
      status: 'succeeded',
      data: { amountCents: 12_500, memo: 'GBX 7Q4M rent' },
    });
    if (r.status !== 'succeeded') return;
    expect(r.data.from).toMatch(/Everyday Checking/);
    expect(r.data.to).toMatch(/Rainy Day Savings/);
    expect(await posted()).toBe(before);
  }, 240_000);

  it('gives each refusal in the bank’s words its business outcome, with nothing posted', async () => {
    const before = await posted();
    const cases: [Omit<TransferInput, 'memoToken'>, string][] = [
      [
        {
          memberId: MEMBERS.nearZero,
          from: 'Everyday Checking',
          to: 'Rainy Day Savings',
          amountCents: 5_000,
        },
        'insufficient_funds',
      ],
      [
        {
          memberId: MEMBERS.ira,
          from: 'Traditional IRA',
          to: 'Everyday Checking',
          amountCents: 10_000,
        },
        'permission_denied',
      ],
      [
        {
          memberId: MEMBERS.restricted,
          from: 'Rainy Day Savings',
          to: 'Everyday Checking',
          amountCents: 10_000,
        },
        'account_restricted',
      ],
      [
        {
          memberId: MEMBERS.demo,
          from: 'Rainy Day Savings',
          to: 'Everyday Checking',
          amountCents: 1_000_001,
        },
        'limit_exceeded',
      ],
      [
        {
          memberId: MEMBERS.demo,
          from: 'Everyday Checking',
          to: 'Rainy Day Savings',
          amountCents: 2_500_001,
        },
        'invalid_amount',
      ],
    ];
    for (const [input, code] of cases) {
      expect(await prepare(input), code).toMatchObject({ status: 'business_outcome', code });
    }
    expect(await posted()).toBe(before);
  }, 600_000);

  it('says the member has no such account rather than guess', async () => {
    expect(
      await prepare({
        memberId: MEMBERS.demo,
        from: '0000',
        to: 'Rainy Day Savings',
        amountCents: 100,
      }),
    ).toMatchObject({ status: 'business_outcome', code: 'no_such_account' });
  }, 240_000);
});
