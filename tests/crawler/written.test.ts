// A written crawler for bank 1, run by the crawler's own task functions with the written guard on,
// checked against the bank's ledger: the engine a factory-written crawler runs on, with no model.
import { type Browser, launch, newPage } from '../../packages/runtime/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { decideWritten, GuardError } from '../../packages/guardrails/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';
import {
  type Action,
  checkBalance,
  prepareTransfer,
  type Session,
  Stop,
} from '../../packages/crawler/src/index.js';

/** Bank 1's crawler, as a factory would write it: it reads each page, then acts. */
const BANK1 = `
async function arrive(site, task, there) {
  await site.open();
  for (let i = 0; i < 25; i++) {
    const { lines } = await site.look();
    const has = (w) => lines.some((l) => l.includes(w));
    if (there(has)) return;
    if (has('Welcome back')) {
      await site.type('Password', 'password');
      await site.press('Sign In');
    } else if (has('Operator ID')) {
      await site.type('Operator ID', 'user_id');
      await site.type('Password', 'password');
      await site.press('Sign In');
    } else if (has('Where should we send your code?')) await site.press('Send code');
    else if (has('That code has expired.')) await site.press('Send a new code');
    else if (has('Enter the 6-digit code we sent')) {
      await site.type('Code', 'code');
      await site.press('Verify');
    } else if (has('Member number:') && has('Status')) await site.press('Open');
    else if (has('Member number:')) {
      await site.type('Member number', 'member');
      await site.press('Search');
    } else if (has('Use Member Search to begin.') || has('New in CoreLink'))
      await site.press('Member Search');
    else await site.wait(1);
  }
  throw new Error('never reached the page it was going to');
}
const summary = (has) => has('Member Summary') && has('Available balance:');

async function balance(site, task) {
  await arrive(site, task, summary);
  const { lines } = await site.look();
  const tile = lines.find((l) => l.includes(task.from) && l.includes('Available balance:'));
  if (!tile) site.stop('no_such_account', 'no tile holds the account');
  const m = tile.match(/^(.*) Available balance: (\\S+) Current balance: (\\S+)/);
  return { account: m[1], available: m[2], current: m[3] };
}
async function transfer(site, task) {
  await arrive(site, task, summary);
  await site.press({ name: 'Transfer Funds', near: 'Member Summary' });
  await site.choose('From', 'from');
  await site.choose('To', 'to');
  await site.type('Amount', 'amount');
  await site.type('Memo', 'memo');
  await site.press('Continue');
}
async function review(site) {
  const { lines } = await site.look();
  const after = (label) => lines[lines.indexOf(label) + 1];
  return { from: after('From:'), to: after('To:'), amount: after('Amount:'), memo: after('Memo:') };
}
async function history(site, task) {
  await arrive(site, task, summary);
  await site.press({ name: 'Activity', near: task.from });
}
function name(lines, member) {
  const l = lines.find((x) => x.startsWith('Member ') && x.includes(' · '));
  return l ? l.split(' · ')[1] : null;
}
const send = 'Submit transfer';
`;

let browser: Browser;
const banks: LiveBank[] = [];
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await Promise.all(banks.map((b) => b.close()));
});

/** A bank of the test's own, the written crawler's session on it, and its guard. */
async function session(source = BANK1) {
  const bank = await liveBank('generic');
  banks.push(bank);
  const pressed: string[] = [];
  const s: Session = {
    page: await newPage(browser),
    url: bank.url,
    table: { kind: 'written', source },
    known: [],
    limitMs: 20_000,
    guard: (a: Action) => {
      if (a.verb === 'press') pressed.push(a.control);
      const v = decideWritten(a.verb, a.control, {
        secrets: [PASSWORDS.service],
        ...(a.typed !== undefined ? { typed: a.typed } : {}),
      });
      if (!v.allowed) throw new GuardError(v.layer, v.rule);
    },
    credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
    code: async () =>
      (await bank.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`)).code,
  };
  return { s, bank, pressed };
}

describe.concurrent('a written crawler on bank 1', { timeout: 240_000 }, () => {
  it("reads the balance the ledger holds, and hides the member's name once it shows", async () => {
    const { s, bank } = await session();
    const [checking] = (
      await bank.admin<{ nickname: string; availableCents: number }[]>(
        `/members/${MEMBERS.demo}/balances`,
      )
    ).filter((a) => a.nickname === 'Everyday Checking');
    expect(
      await checkBalance(s, { member: MEMBERS.demo, account: 'Everyday Checking' }),
    ).toMatchObject({ availableCents: checking!.availableCents });
    expect(s.known.length).toBeGreaterThan(3);
  });

  it('fills a transfer in to its review, and never presses send', async () => {
    const { s, pressed } = await session();
    const r = await prepareTransfer(s, {
      member: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 100,
      memo: 'GBX TEST',
    });
    expect(r).toMatchObject({ amountCents: 100, memo: expect.stringContaining('GBX TEST') });
    expect(pressed.some((p) => /submit/i.test(p))).toBe(false);
  });

  it('is stopped by the guard when it presses send', async () => {
    const { s } = await session(
      BANK1.replace(
        "await site.press('Continue');",
        "await site.press('Continue');\n  await site.press(send);",
      ),
    );
    const err = await prepareTransfer(s, {
      member: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 100,
      memo: 'GBX TEST',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardError);
    expect(err).not.toBeInstanceOf(Stop);
  });
});
