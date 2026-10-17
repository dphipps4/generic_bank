// The outcome table's shared parts (plan, §A.1 to §A.2): a live Generic Bank, one browser, and one
// Check Balance run through bank 1's crawler. Runs are sequential, because one staff operator
// signing in from several places at once invalidates their own codes, as the bank would.
import { afterAll, beforeAll } from 'vitest';
import { bank1, checkBalance, Stop } from '../../packages/crawler/src/index.js';
import { type Browser, launch, newPage } from '../../packages/runtime/src/index.js';
import { type HazardName, OUTCOMES } from '../../packages/contracts/src/index.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

export { MEMBERS };

/** One calm bank and one browser for the whole file. */
export function outcomeBank() {
  const env: { bank: LiveBank; browser: Browser } = {} as never;
  beforeAll(async () => {
    [env.bank, env.browser] = await Promise.all([liveBank('generic'), launch()]);
  }, 120_000);
  afterAll(async () => {
    await env.browser?.close();
    await env.bank?.close();
  });
  return env;
}

/** A Check Balance run, ended as the API would report it: succeeded, or its status and code. */
export async function run(
  env: { bank: LiveBank; browser: Browser },
  account: string,
  hazards?: HazardName[],
  memberId: string = MEMBERS.demo,
): Promise<{ status: string; code?: string }> {
  const { bank, browser } = env;
  const page = await newPage(browser, hazards ? { headers: bank.forced(hazards) } : {});
  try {
    await checkBalance(
      {
        page,
        url: bank.url,
        table: bank1,
        known: [],
        limitMs: 20_000,
        credentials: async () => ({
          operatorId: OPERATORS.service.id,
          password: PASSWORDS.service,
        }),
        code: async () => {
          const r = await bank.db.query<{ body: string }>(
            'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
          );
          return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
        },
      },
      { member: memberId, account },
    );
    return { status: 'succeeded' };
  } catch (e) {
    if (e instanceof Stop) return { status: e.ended.status, code: e.ended.code };
    throw e;
  } finally {
    await page.context().close();
  }
}

/** A result as the table states it. */
export const brief = (o: { status: string; code?: string }) =>
  o.status === 'succeeded' ? { status: 'succeeded' } : { status: o.status, code: o.code };

// The table the hazard lab shows, and the three rows the suite runs from it: a business outcome, a
// recoverable condition and a hard failure, each with its distinct typed result.
export const CASES = OUTCOMES['check-balance'];
const hazard = (name: HazardName) => CASES.hazards.find((c) => c.hazard === name)!;
export const RUN = {
  business: CASES.members.find((m) => m.expected.code === 'no_such_member')!,
  recoverable: hazard('early-expiry'),
  hard: hazard('service-unavailable'),
};
