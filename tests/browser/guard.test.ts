import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGuard } from '../../apps/runner/src/guard.js';
import {
  type DriverContext,
  GENERIC_BANK,
  prepareTransfer,
} from '../../packages/drivers/src/index.js';
import { GuardError } from '../../packages/guardrails/src/index.js';
import { Browser, click, guardActions, readScreen } from '../../packages/screen/src/index.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The guard on every action (plan, §J.2), on Generic Bank through a real browser: the transfer
// driver runs with the Runner's guard in front of every click, key and choice and reaches the
// review page; anything its list does not allow is refused before the browser, with its rule and
// layer, and the money-moving press is refused without a person's grant. The bank is the judge: its
// state-change counter does not move for anything the guard refused.

let bank: LiveBank;
let browser: Browser;
beforeAll(async () => {
  [bank, browser] = await Promise.all([liveBank('generic'), Browser.launch()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

const changes = async () => (await bank.admin<{ stateChanges: number }>('/state')).stateChanges;

describe('the guard', () => {
  it('refuses what the list does not allow, and a money-moving press without a grant, before the browser', async () => {
    const page = await browser.newPage();
    const g = runGuard({
      job: 'transfer',
      profile: GENERIC_BANK,
      secrets: [PASSWORDS.service, OPERATORS.service.id],
    });
    guardActions(page, g.guard);
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
      // Everything on the way to the review page is on the transfer's list.
      const prepared = await prepareTransfer(ctx, {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 1_500,
        memoToken: 'GBX G4RD',
      });
      expect(prepared.status).toBe('succeeded');
      expect(g.tripped()).toBeNull();
      const before = await changes();
      const review = await readScreen(page);

      // A key pressed on its own is not on the list.
      const keys = runGuard({ job: 'transfer', profile: GENERIC_BANK, secrets: [] });
      expect(() =>
        keys.guard({ verb: 'press', control: null, key: 'Enter', model: review }),
      ).toThrow(GuardError);
      expect(keys.tripped()).toMatchObject({ layer: 'task allowlist' });

      // The submit moves money: with no person's grant, the page's own guard refuses the click.
      const submit = review.controls.find((c) =>
        GENERIC_BANK.words.submitTransfer.includes(c.name),
      )!;
      const refused = await click(page, submit).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(GuardError);
      expect(g.tripped()).toEqual({
        layer: 'approval grant',
        rule: `"${submit.name}" needs an approval grant: none was presented`,
      });
      // Once tripped, the guard refuses everything, even what the list allows.
      await expect(click(page, submit)).rejects.toThrow(/the guard has tripped/);
      // Nothing reached the bank: the review is still on the screen, and the counter has not moved.
      expect((await readScreen(page)).controls.some((c) => c.name === submit.name)).toBe(true);
      expect(await changes()).toBe(before);
    } finally {
      await page.close();
    }
  }, 300_000);
});
