// The outcome table's shared parts (plan, §D.2 to §D.4): a live Generic Bank, one browser, and one
// Check Balance run through the real driver. Each test file starts its own bank and browser, so the
// files run side by side; inside a file, runs are sequential, because one staff operator signing in
// from several places at once invalidates their own codes, as the bank would.
import { afterAll, beforeAll } from 'vitest';
import {
  checkBalance,
  type DriverContext,
  GENERIC_BANK,
  type Outcome,
} from '../../packages/drivers/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { type Expected, type HazardName, OUTCOMES } from '../../packages/contracts/src/index.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

export { MEMBERS };

/** One bank (calm, or under the given hazard profile) and one browser for the whole file. */
export function outcomeBank(o: { profile?: 'default' } = {}) {
  const env: { bank: LiveBank; browser: Browser } = {} as never;
  beforeAll(async () => {
    [env.bank, env.browser] = await Promise.all([
      liveBank('generic', o.profile ? { profile: o.profile } : {}),
      Browser.launch(),
    ]);
  }, 120_000);
  afterAll(async () => {
    await env.browser?.close();
    await env.bank?.close();
  });
  return env;
}

export async function run(
  env: { bank: LiveBank; browser: Browser },
  account: string,
  hazards?: HazardName[],
  memberId: string = MEMBERS.demo,
) {
  const { bank, browser } = env;
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

export const brief = (o: Outcome<{ availableCents: number }>) =>
  o.status === 'succeeded' ? { status: 'succeeded' } : { status: o.status, code: o.code };

// Every hazard, forced alone, and the one result it must give: the same list the hazard lab shows.
export const CASES = OUTCOMES['check-balance'];
export const TABLE: [HazardName, Expected][] = CASES.hazards.map((c) => [c.hazard, c.expected]);
