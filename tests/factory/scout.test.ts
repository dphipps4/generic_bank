// The Scout's tools against bank 1, with no model: a script stands where the model would, so this
// proves the mechanics only. Every action is judged before the next, a target the runtime finds
// elsewhere is refused, and the table the Scout writes as it goes runs under the same loop as bank
// 1's own, with the balance the ledger holds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTrail } from '../../apps/factory/src/trail.js';
import { scout, type Judging } from '../../apps/factory/src/scout.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { checkBalance } from '../../packages/crawler/src/index.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { type Browser, launch, newPage } from '../../packages/runtime/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

let bank: LiveBank;
let browser: Browser;
let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  [bank, browser, db] = await Promise.all([liveBank('generic'), launch(), controlDb()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
  await db?.close();
});

const credentials = { operatorId: OPERATORS.service.id, password: PASSWORDS.service };
const code = async () =>
  (await bank.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`)).code;

async function aScout(judged: Judging[] = []) {
  const page = await newPage(browser);
  const trail = await openTrail({
    sql: db,
    store: memoryStore(),
    runId: `fr_${Math.random().toString(16).slice(2, 10)}`,
    task: 'check-balance',
    bank: 'generic',
    known: [],
  });
  const s = scout(
    {
      page,
      start: bank.url,
      trail,
      credentials,
      code,
      judge: async (j) => (judged.push(j), { verdict: 'continue', says: 'Fine.' }),
    },
    { goal: 'balance', member: MEMBERS.demo },
  );
  /** The id of the latest page's control with this role and, if given, this name. */
  const id = (role: string, name?: string) => {
    const i = s
      .latest()!
      .controls.findIndex((c) => c.role === role && (name === undefined || c.name === name));
    if (i < 0) throw new Error(`no ${role} ${name ?? ''}`);
    return `c${i + 1}`;
  };
  const go = (tool: string, input: Record<string, unknown> = {}) => s.call('scout', tool, input);
  return { s, id, go, page };
}

describe('the Scout, scripted', () => {
  it("writes a table as it goes that reads the ledger's balance", async () => {
    const judged: Judging[] = [];
    const { s, id, go } = await aScout(judged);
    const why = 'the next step';
    await go('browser_open');
    await go('name_page', { name: 'sign-in', shows: ['Operator ID:', 'Password:'] });
    await go('browser_type', { id: id('textbox'), label: 'Operator ID', value: 'user_id', why });
    await go('browser_type', { id: id('password'), label: 'Password', value: 'password', why });
    await go('browser_press', { id: id('button', 'Sign In'), why });
    await go('name_page', { name: 'code chooser', shows: ['Where should we send your code?'] });
    await go('browser_press', { id: id('button', 'Send code'), why });
    await go('name_page', { name: 'code', shows: ['Enter the 6-digit code we sent'] });
    await go('browser_type', { id: id('textbox'), label: 'Code', value: 'code', why });
    await go('browser_press', { id: id('link', 'Verify'), why });
    await go('name_page', { name: 'home', shows: ['Use Member Search to begin.'] });
    await go('browser_press', { id: id('link', 'Member Search'), why });
    await go('name_page', { name: 'search', shows: ['Member number:'], never: ['Status'] });
    await go('browser_type', { id: id('textbox'), label: 'Member number', value: 'member', why });
    await go('browser_press', { id: id('clickable', 'Search'), why });
    await go('name_page', { name: 'found', shows: ['Member number:', 'Status'] });
    await go('note_read', { what: 'name', text: '$member\n{name}\n{status}' });
    await go('browser_press', { id: id('link', 'Open'), why });
    await go('name_page', { name: 'summary', shows: ['Member Summary', 'Available balance:'] });
    await go('note_read', {
      what: 'balance',
      text: '{name} Account ending in {last4} Available balance: {available} Current balance: {current}',
    });
    await go('note_read', { what: 'name', text: 'Member $member · {name}' });
    await go('goal_reached');

    // Every action was judged, each with its picture.
    expect(judged.length).toBeGreaterThanOrEqual(10);
    expect(judged.every((j) => j.frame.picture.length > 0)).toBe(true);
    // The table, in the step language bank 1's uses, citing the Scout's own frames.
    const t = s.table();
    expect(t.ends.balance).toBe('summary');
    expect(t.rows.find((r) => r.page === 'sign-in')!.do.balance).toEqual([
      { type: 'Operator ID', value: '$operator' },
      { type: 'Password', value: '$password' },
      { press: 'Sign In' },
    ]);
    expect(t.rows.every((r) => /^f\d+$/.test(r.frame))).toBe(true);

    // It runs under the crawler's loop, as bank 1's own table does.
    const [checking] = (
      await bank.admin<{ nickname: string; availableCents: number }[]>(
        `/members/${MEMBERS.demo}/balances`,
      )
    ).filter((a) => a.nickname === 'Everyday Checking');
    const page = await newPage(browser);
    const b = await checkBalance(
      { page, url: bank.url, table: t, known: [], credentials: async () => credentials, code },
      { member: MEMBERS.demo, account: 'Everyday Checking' },
    );
    expect(b.availableCents).toBe(checking!.availableCents);
  }, 240_000);

  it('refuses a target the runtime finds elsewhere, and an unseen word', async () => {
    const { id, go } = await aScout();
    await go('browser_open');
    // The password box, named by the operator ID's label: the runtime lands on another field.
    await expect(
      go('browser_type', {
        id: id('password'),
        label: 'Operator ID',
        value: 'user_id',
        why: 'x x',
      }),
    ).rejects.toThrow(/finds another control/);
    await expect(
      go('name_page', { name: 'sign-in', shows: ['Welcome back, teller'] }),
    ).rejects.toThrow(/does not show/);
    await expect(go('browser_press', { x: 1, y: 1, why: 'x x' })).rejects.toThrow(/lands on no/);
  }, 120_000);
});
