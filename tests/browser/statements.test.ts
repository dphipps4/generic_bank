import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DriverContext,
  downloadStatements,
  GENERIC_BANK,
  type StatementsInput,
  type StepRecord,
} from '../../packages/drivers/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import type { HazardName } from '../../apps/bank/src/hazards.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS, signedInCookies } from '../support/banks.js';

// Download Statements on Generic Bank, through a real browser. The bank is the judge: each PDF the
// driver kept is compared, byte for byte, with the one the bank serves for that month when asked
// directly.

let browser: Browser;
let bank: LiveBank;
let cookie: string;
beforeAll(async () => {
  [bank, browser] = await Promise.all([liveBank('generic'), Browser.launch()]);
  cookie = (await signedInCookies(bank)).map((c) => `${c.name}=${c.value}`).join('; ');
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

/** YYYY-MM, `back` months before this one. */
const monthsAgo = (back: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    .toISOString()
    .slice(0, 7);
};

async function run(input: StatementsInput, hazards?: HazardName[]) {
  const page = await browser.newPage();
  if (hazards) await page.call('Network.setExtraHTTPHeaders', { headers: bank.forced(hazards) });
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
    return { outcome: await downloadStatements(ctx, input), steps };
  } finally {
    await page.close();
  }
}

/** The month's PDF as the bank serves it to a signed-in operator who asks for it directly. */
async function bankPdf(accountId: number, month: string) {
  const r = await fetch(
    `${bank.url}statement?member=${MEMBERS.demo}&account=${accountId}&month=${month}`,
    { headers: { cookie } },
  );
  expect(r.headers.get('content-type')).toBe('application/pdf');
  return Buffer.from(await r.arrayBuffer());
}

describe('Download Statements on Generic Bank', () => {
  it('keeps each month’s PDF exactly as the bank serves it', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const months = [monthsAgo(1), monthsAgo(5)];
    const { outcome, steps } = await run({
      memberId: MEMBERS.demo,
      account: acct.number.slice(-4),
      months,
    });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.data.months.map((m) => m.month)).toEqual(months);
    for (const m of outcome.data.months) {
      if (!('pdf' in m)) throw new Error(`${m.month} was not kept`);
      expect(m.pdf.equals(await bankPdf(acct.id, m.month))).toBe(true);
    }
    // Two different months are two different documents.
    const [a, b] = outcome.data.months as { pdf: Buffer }[];
    expect(a!.pdf.equals(b!.pdf)).toBe(false);
    expect(steps.filter((s) => s.name === 'statement').map((s) => s.outcome)).toEqual([
      'kept',
      'kept',
    ]);
  }, 180_000);

  it('says a month the bank does not list is not available, in the bank’s words', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'savings')!;
    const { outcome } = await run({
      memberId: MEMBERS.demo,
      account: 'Rainy Day Savings',
      months: [monthsAgo(24), monthsAgo(2), monthsAgo(0)],
    });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    const [old, kept, current] = outcome.data.months;
    const words = 'Only the last 12 months of statements are available online.';
    expect(old).toEqual({ month: monthsAgo(24), notAvailable: words });
    expect(current).toEqual({ month: monthsAgo(0), notAvailable: words });
    expect(kept && 'pdf' in kept && kept.pdf.equals(await bankPdf(acct.id, monthsAgo(2)))).toBe(
      true,
    );
  }, 180_000);

  it('waits for rows that arrive late', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const { outcome } = await run(
      { memberId: MEMBERS.demo, account: acct.number.slice(-4), months: [monthsAgo(3)] },
      ['late-rows'],
    );
    expect(outcome).toMatchObject({ status: 'succeeded' });
  }, 180_000);

  it('ends with the business outcome for an account the member does not have', async () => {
    const { outcome } = await run({ memberId: MEMBERS.demo, account: '0000', months: ['2026-01'] });
    expect(outcome).toMatchObject({ status: 'business_outcome', code: 'no_such_account' });
  }, 180_000);
});
