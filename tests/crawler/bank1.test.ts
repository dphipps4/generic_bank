// Bank 1's crawler against bank 1 in a browser, checked against the bank's ledger. The test reads
// the ledger and the staff phone's code through the bank's admin API; the crawler never does.
// Each test has a bank of its own: every run signs in as the same teller, and a new code replaces
// the last, so two runs on one bank would trip over each other's codes.
import { appendFileSync } from 'node:fs';
import { type Browser, launch, newPage } from '../../packages/runtime/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HazardName } from '../../apps/bank/src/hazards.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';
import {
  bank1,
  checkBalance,
  prepareTransfer,
  type Session,
  Stop,
  submitTransfer,
} from '../../packages/crawler/src/index.js';

let browser: Browser;
const banks: LiveBank[] = [];
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await Promise.all(banks.map((b) => b.close()));
});

interface Ledger {
  nickname: string;
  number: string;
  availableCents: number;
  currentCents: number;
}
const ledger = (bank: LiveBank, member: string) =>
  bank.admin<Ledger[]>(`/members/${member}/balances`);

/** A bank of the test's own, and a crawler's session on it. */
async function session(hazards: HazardName[] = []): Promise<{ s: Session; bank: LiveBank }> {
  const bank = await liveBank('generic');
  banks.push(bank);
  const page = await newPage(browser, hazards.length ? { headers: bank.forced(hazards) } : {});
  const s: Session = {
    page,
    url: bank.url,
    table: bank1,
    known: [],
    limitMs: 20_000,
    // CRAWL_FRAMES=<file> writes each page the crawler saw, for reading a failure.
    ...(process.env.CRAWL_FRAMES && {
      keep: (seen: { did: string }, f: { tree: string; address: string }) =>
        appendFileSync(process.env.CRAWL_FRAMES!, `\n=== ${seen.did} @ ${f.address}\n${f.tree}\n`),
    }),
    credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
    code: async () =>
      (await bank.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`)).code,
  };
  return { s, bank };
}
const ended = (p: Promise<unknown>) =>
  p.then(
    () => 'succeeded',
    (e) => (e instanceof Stop ? e.ended.code : Promise.reject(e)),
  );
const balance = { member: MEMBERS.demo, account: 'Everyday Checking' };

describe.concurrent('bank 1, crawled', { timeout: 240_000 }, () => {
  it('reads a balance by the account name, and by its last four, as the ledger has it', async () => {
    const { s, bank } = await session();
    const [checking] = (await ledger(bank, MEMBERS.demo)).filter(
      (a) => a.nickname === 'Everyday Checking',
    );
    expect(await checkBalance(s, balance)).toMatchObject({
      availableCents: checking!.availableCents,
      currentCents: checking!.currentCents,
      accountLabel: `Everyday Checking, ending in ${checking!.number.slice(-4)}`,
    });
    const byLast4 = await checkBalance(s, { ...balance, account: checking!.number.slice(-4) });
    expect(byLast4.availableCents).toBe(checking!.availableCents);
  });

  it('stops a transfer at review, submits it once, and finds it in the activity', async () => {
    const { s, bank } = await session();
    const before = await ledger(bank, MEMBERS.demo);
    const task = {
      member: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 2_500,
      memo: 'GBX T001 lunch',
    };
    expect(await prepareTransfer(s, task)).toMatchObject({
      amountCents: 2_500,
      memo: 'GBX T001 lunch',
    });
    expect((await submitTransfer(s, task, async () => undefined)).seenInHistory).toBe(true);
    const after = await ledger(bank, MEMBERS.demo);
    const moved = before.map((a, i) => after[i]!.currentCents - a.currentCents);
    expect(moved.filter(Boolean).sort((a, b) => a - b)).toEqual([-2_500, 2_500]);
  });

  it("returns the bank's answers as outcomes", async () => {
    const { s } = await session();
    expect(await ended(checkBalance(s, { ...balance, member: MEMBERS.missing }))).toBe(
      'no_such_member',
    );
    expect(await ended(checkBalance(s, { ...balance, member: MEMBERS.closed }))).toBe(
      'member_closed',
    );
    const tooMuch = {
      member: MEMBERS.demo,
      from: 'Rainy Day Savings',
      to: 'Everyday Checking',
      amountCents: 2_000_000,
      memo: 'GBX T002',
    };
    expect(await ended(prepareTransfer(s, tooMuch))).toBe('insufficient_funds');
  });

  it('gets past a promo, a dialog and a swallowed click', async () => {
    const { s } = await session(['promo', 'confirm-dialog', 'swallowed-click']);
    expect((await checkBalance(s, balance)).availableCents).toBeGreaterThan(0);
  });

  for (const [hazard, code] of [
    ['js-error-fatal', 'app_error'],
    ['service-unavailable', 'unavailable'],
    ['unknown-screen', 'unknown_screen'],
  ] as const)
    it(`stops on ${hazard} as ${code}`, async () => {
      const { s } = await session([hazard]);
      expect(await ended(checkBalance(s, balance))).toBe(code);
    });

  it('never presses a hung Submit again: it reads the activity instead', async () => {
    const { s } = await session(['swallowed-submit']);
    const task = {
      member: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 1_000,
      memo: 'GBX T003',
    };
    await prepareTransfer(s, task);
    expect((await submitTransfer(s, task, async () => undefined)).seenInHistory).toBe(true);
  });
});
