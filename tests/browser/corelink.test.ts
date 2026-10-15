import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBalance,
  type DriverContext,
  GENERIC_BANK,
  type StepRecord,
} from '../../packages/drivers/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import type { HazardName } from '../../apps/bank/src/hazards.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The CoreLink driver's Check Balance against Generic Bank, through a real browser, from the
// Loading shell to the balance. The staff code is answered from the bank's own records, standing in
// for the person who reads it from the staff phone.

let browser: Browser;
let bank: LiveBank;
beforeAll(async () => {
  bank = await liveBank('generic');
  browser = await Browser.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

async function run(
  input: { memberId: string; account: string },
  o: { hazards?: HazardName[]; password?: string } = {},
) {
  const page = await browser.newPage();
  if (o.hazards)
    await page.call('Network.setExtraHTTPHeaders', { headers: bank.forced(o.hazards) });
  const steps: StepRecord[] = [];
  const ctx: DriverContext = {
    page,
    profile: { ...GENERIC_BANK, url: bank.url },
    credentials: async () => ({
      operatorId: OPERATORS.service.id,
      password: o.password ?? PASSWORDS.service,
    }),
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
  const outcome = await checkBalance(ctx, input);
  await page.close();
  return { outcome, steps };
}

describe('Check Balance on Generic Bank', () => {
  it('signs in, finds the member, and reads the balances the ledger holds, by last four digits', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const { outcome, steps } = await run({
      memberId: MEMBERS.demo,
      account: acct.number.slice(-4),
    });
    expect(outcome).toMatchObject({
      status: 'succeeded',
      data: { availableCents: acct.availableCents, currentCents: acct.currentCents },
    });
    expect(steps.map((s) => s.name)).toEqual(
      expect.arrayContaining(['sign in', 'staff code', 'member search', 'balance']),
    );
  }, 120_000);

  it('finds an account by its nickname too', async () => {
    const acct = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'savings')!;
    const { outcome } = await run({ memberId: MEMBERS.demo, account: 'Rainy Day Savings' });
    expect(outcome).toMatchObject({
      status: 'succeeded',
      data: { availableCents: acct.availableCents },
    });
  }, 120_000);

  it('reports the bank’s business answers: no such member, member closed, no such account', async () => {
    expect((await run({ memberId: MEMBERS.missing, account: '1234' })).outcome).toEqual({
      status: 'business_outcome',
      code: 'no_such_member',
    });
    expect((await run({ memberId: MEMBERS.closed, account: '1234' })).outcome).toEqual({
      status: 'business_outcome',
      code: 'member_closed',
    });
    expect((await run({ memberId: MEMBERS.demo, account: '0000' })).outcome).toEqual({
      status: 'business_outcome',
      code: 'no_such_account',
    });
  }, 300_000);

  it('handles the interstitial and the unread-alerts dialog inside the run, and still succeeds', async () => {
    const { outcome, steps } = await run(
      { memberId: MEMBERS.demo, account: 'Everyday Checking' },
      { hazards: ['promo', 'confirm-dialog'] },
    );
    expect(outcome.status).toBe('succeeded');
    expect(steps.filter((s) => s.outcome === 'recovered').map((s) => s.name)).toEqual(
      expect.arrayContaining(['interstitial', 'dialog']),
    );
  }, 120_000);

  it('fails cleanly, saying whether a retry may help: wrong password, record in use, gateway errors', async () => {
    expect(
      (await run({ memberId: MEMBERS.demo, account: '1234' }, { password: 'wrong-password' }))
        .outcome,
    ).toEqual({ status: 'failed', code: 'bad_credentials' });
    expect(
      (await run({ memberId: MEMBERS.demo, account: '1234' }, { hazards: ['record-in-use'] }))
        .outcome,
    ).toMatchObject({ status: 'failed', code: 'record_in_use', retryable: true });
    expect(
      (await run({ memberId: MEMBERS.demo, account: '1234' }, { hazards: ['service-unavailable'] }))
        .outcome,
    ).toMatchObject({ status: 'failed', code: 'unavailable', retryable: true });
  }, 300_000);

  it('stops at a screen it does not know, and never guesses', async () => {
    const { outcome } = await run(
      { memberId: MEMBERS.demo, account: '1234' },
      { hazards: ['unknown-screen'] },
    );
    expect(outcome).toMatchObject({ status: 'escalated', code: 'unknown_screen' });
  }, 120_000);
});
