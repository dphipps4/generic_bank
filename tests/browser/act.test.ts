import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  button,
  choose,
  click,
  field,
  recognize,
  type Signature,
  type,
  waitFullyRendered,
  withText,
} from '../../packages/screen/src/index.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS, signedInCookies } from '../support/banks.js';

// The first crawl: a real browser signs in to Generic Bank by typing and clicking, the way an
// operator would, then finds a member and reads a balance. The staff code is read from the bank's
// own records, standing in for the person who reads it from their phone.

const SIGS: Signature[] = [
  { id: 'signin', requires: ['Operator ID'], controls: [{ role: 'password' }] },
  { id: 'code.choose', requires: ['Where should we send your code?'] },
  { id: 'code.enter', requires: ['Enter the 6-digit code we sent'] },
  { id: 'console', controls: [{ name: 'Member Search' }, { name: 'Sign Out' }] },
];

let browser: Browser;
let bank: LiveBank;
let sample: LiveBank;
beforeAll(async () => {
  [bank, sample] = await Promise.all([liveBank('generic'), liveBank('sample')]);
  browser = await Browser.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
  await sample?.close();
});

const lastCode = async () => {
  const r = await bank.db.query<{ body: string }>(
    `SELECT body FROM messages ORDER BY id DESC LIMIT 1`,
  );
  return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
};

describe('acting like a person', () => {
  it('signs in to Generic Bank by typing and clicking, through every step', async () => {
    const p = await browser.newPage();
    await p.goto(bank.url);
    const enabled = (m: { controls: { role: string; enabled: boolean }[] }) =>
      m.controls.some((c) => c.role === 'password' && c.enabled);
    let r = await waitFullyRendered(p, { until: enabled, limitMs: 20_000 });
    expect(recognize(r.model, SIGS).screen).toBe('signin');
    await type(p, field(r.model, 'Operator ID'), OPERATORS.service.id);
    await type(p, field(r.model, 'Password'), PASSWORDS.service);
    await click(p, button(r.model, 'Sign In'));

    r = await waitFullyRendered(p, { limitMs: 20_000 });
    expect(recognize(r.model, SIGS).screen).toBe('code.choose');
    await click(p, button(r.model, 'Send code'));

    r = await waitFullyRendered(p, { limitMs: 20_000 });
    expect(recognize(r.model, SIGS).screen).toBe('code.enter');
    await type(p, field(r.model, 'Code'), await lastCode());
    await click(p, button(r.model, 'Verify'));

    r = await waitFullyRendered(p, {
      until: (m) => recognize(m, SIGS).screen === 'console',
      limitMs: 20_000,
    });
    expect(recognize(r.model, SIGS).screen).toBe('console');

    // Member Search, in the nav frame; the form appears in the main frame.
    await click(p, button(r.model, 'Member Search'));
    r = await waitFullyRendered(p, {
      until: (m) =>
        m.texts.some((t) => /Member number/.test(t.text)) ||
        m.controls.some((c) => c.name === 'Search'),
      limitMs: 20_000,
    });
    await type(p, field(r.model, 'Member number'), MEMBERS.demo);
    await click(p, button(r.model, 'Search'));
    r = await waitFullyRendered(p, {
      until: (m) => m.controls.some((c) => c.name === 'Open'),
      limitMs: 20_000,
    });
    await click(p, button(r.model, 'Open'));

    // The summary: tiles drawn by script, then drawn again; read the checking account's balance.
    const checking = (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.type === 'checking')!;
    const label = `Account ending in ${checking.number.slice(-4)}`;
    r = await waitFullyRendered(p, {
      until: (m) => m.texts.some((t) => t.text.includes(label)),
      limitMs: 20_000,
    });
    expect(r.model.texts.some((t) => t.text.includes(`Member ${MEMBERS.demo}`))).toBe(true);
    const shown = (
      r.model.texts
        .map((t) => t.text)
        .join(' ')
        .match(/\$[\d,]+\.\d{2}/g) ?? []
    ).map((s) => Math.round(Number(s.replace(/[$,]/g, '')) * 100));
    expect(shown).toContain(checking.availableCents);
    expect(withText(r.model, label, 'Activity').role).toBe('link');
    await p.close();
  }, 120_000);

  it('types key by key, so a field that reads only key presses gets the amount, and chooses from lists with the keyboard', async () => {
    const p = await browser.newPage();
    for (const c of await signedInCookies(sample))
      await p.call('Network.setCookie', { name: c.name, value: c.value, url: sample.url });
    await p.goto(`${sample.url}members/${MEMBERS.demo}/transfer`);
    let r = await waitFullyRendered(p, {
      until: (m) => m.controls.some((c) => c.role === 'select' && (c.options?.length ?? 0) > 2),
      limitMs: 20_000,
    });
    // Bank 3's notice bar covers the submit control until it is dismissed.
    await click(p, button(r.model, 'Dismiss'));
    r = await waitFullyRendered(p, {
      until: (m) => m.controls.some((c) => c.name === 'Proceed'),
      limitMs: 10_000,
    });
    const [from, to] = await accountsOf(sample.db, MEMBERS.demo);
    await choose(p, field(r.model, 'From'), (o) => o.startsWith(from!.nickname));
    r = await waitFullyRendered(p, { limitMs: 10_000 });
    await choose(p, field(r.model, 'To'), (o) => o.startsWith(to!.nickname));
    r = await waitFullyRendered(p, { limitMs: 10_000 });
    await type(p, field(r.model, 'Amount'), '12.34');
    await type(p, field(r.model, 'Memo'), 'KEYS1');
    r = await waitFullyRendered(p, { limitMs: 10_000 });
    await click(p, button(r.model, 'Proceed'));
    r = await waitFullyRendered(p, { limitMs: 20_000 });
    const page = r.model.texts.map((t) => t.text).join(' ');
    expect(page).toContain('$12.34');
    expect(page).toContain('KEYS1');
    await p.close();
  }, 120_000);
});
