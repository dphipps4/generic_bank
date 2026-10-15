import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBalance,
  type DriverContext,
  GENERIC_BANK,
  type Outcome,
} from '../../packages/drivers/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import type { HazardName } from '../../apps/bank/src/hazards.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The outcome table (plan, §D.2 to §D.4): Check Balance on Generic Bank, first under the bank's
// ambient hazards, then with every hazard forced alone, each mapped to the one result it must give.
// Runs are sequential: one staff operator signing in from several places at once invalidates their
// own codes, as the bank would.

let browser: Browser;
let calm: LiveBank;
let ambient: LiveBank;
beforeAll(async () => {
  [calm, ambient] = await Promise.all([
    liveBank('generic'),
    liveBank('generic', { profile: 'default' }),
  ]);
  browser = await Browser.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await calm?.close();
  await ambient?.close();
});

async function run(
  bank: LiveBank,
  account: string,
  hazards?: HazardName[],
  memberId: string = MEMBERS.demo,
) {
  const page = await browser.newPage();
  if (hazards) await page.call('Network.setExtraHTTPHeaders', { headers: bank.forced(hazards) });
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
    return await checkBalance(ctx, { memberId, account });
  } finally {
    await page.close();
  }
}

const brief = (o: Outcome<{ availableCents: number }>) =>
  o.status === 'succeeded' ? { status: 'succeeded' } : { status: o.status, code: o.code };

describe('under the bank’s ambient hazards', () => {
  it('checks a balance correctly, run after run', async () => {
    const acct = (await accountsOf(ambient.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await run(ambient, 'Everyday Checking'));
    // Each run's result, with the reason when it did not succeed.
    expect(
      results.map((r) =>
        r.status === 'succeeded'
          ? r.data.availableCents === acct.availableCents
          : `${r.status}: ${r.code} (${r.note ?? ''})`,
      ),
    ).toEqual([true, true, true, true]);
  }, 600_000);
});

// Every hazard, forced alone, and the one result it must give.
const TABLE: [HazardName, { status: string; code?: string }][] = [
  ['latency', { status: 'succeeded' }],
  ['js-error-harmless', { status: 'succeeded' }],
  ['confirm-dialog', { status: 'succeeded' }],
  ['promo', { status: 'succeeded' }],
  ['slow-handoff', { status: 'succeeded' }],
  ['early-expiry', { status: 'succeeded' }],
  ['swallowed-click', { status: 'succeeded' }],
  ['swallowed-submit', { status: 'succeeded' }],
  ['late-rows', { status: 'succeeded' }],
  ['injected-instruction', { status: 'succeeded' }],
  ['validation-error', { status: 'succeeded' }],
  ['js-error-widget', { status: 'escalated', code: 'unknown_screen' }],
  ['js-error-fatal', { status: 'failed', code: 'app_error' }],
  ['service-unavailable', { status: 'failed', code: 'unavailable' }],
  ['record-in-use', { status: 'failed', code: 'record_in_use' }],
  ['record-not-found', { status: 'business_outcome', code: 'no_such_member' }],
  ['permission-denial', { status: 'business_outcome', code: 'permission_denied' }],
  ['unknown-screen', { status: 'escalated', code: 'unknown_screen' }],
];

describe('every hazard, forced alone, gives its one result', () => {
  for (const [hazard, want] of TABLE) {
    it(`${hazard} → ${want.status}${want.code ? `: ${want.code}` : ''}`, async () => {
      expect(brief(await run(calm, 'Everyday Checking', [hazard]))).toEqual(want);
    }, 240_000);
  }
});

describe('the member’s own cases', () => {
  it('no such member, a closed member, no such account', async () => {
    expect(brief(await run(calm, '1234', undefined, MEMBERS.missing))).toEqual({
      status: 'business_outcome',
      code: 'no_such_member',
    });
    expect(brief(await run(calm, '1234', undefined, MEMBERS.closed))).toEqual({
      status: 'business_outcome',
      code: 'member_closed',
    });
    expect(brief(await run(calm, '0000'))).toEqual({
      status: 'business_outcome',
      code: 'no_such_account',
    });
  }, 600_000);
});
