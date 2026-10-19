// The Scout's tools across a run's three goals against bank 1, with no model: a script stands where
// the model would. As a factory run does, each goal starts at the site's start page with the route
// so far carried over: the balance, a transfer up to its review (never sent), and the from-account's
// activity. The route the three goals write passes the guard, and runs under the crawler's loop
// with the guard on: the ledger's balance, the task's amount on the review, the activity.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judge, refusals } from '../../apps/factory/src/guard.js';
import { openTrail, type Trail } from '../../apps/factory/src/trail.js';
import { scout, type Judging, type Task } from '../../apps/factory/src/scout.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import {
  type Action,
  checkBalance,
  crawl,
  type Goal,
  leaves,
  prepareTransfer,
  type Table,
} from '../../packages/crawler/src/index.js';
import { memoryStore } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { type Browser, launch, newPage, type Page } from '../../packages/runtime/src/index.js';
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
/** What a run is given: a member and two of their accounts. */
const input = { member: MEMBERS.demo, from: 'Everyday Checking', to: 'Rainy Day Savings' };
const memo = 'GBX 5C0F';
const balances = async () =>
  bank.admin<{ nickname: string; availableCents: number; currentCents: number }[]>(
    `/members/${MEMBERS.demo}/balances`,
  );

/** One goal's Scout, as run.ts makes it: the run's page and trail, and the route so far. */
function aGoal(page: Page, trail: Trail, goal: Goal, table: Table | undefined, judged: Judging[]) {
  const task: Task = { goal, ...input, amountCents: 100, memo };
  const s = scout(
    {
      page,
      start: bank.url,
      trail,
      credentials,
      code,
      judge: async (j) => (judged.push(j), { verdict: 'continue', says: 'Fine.' }),
      ...(table ? { table } : {}),
    },
    task,
  );
  /**
   * The id of the latest page's control with this role (any, with null) and, if given, this name:
   * the first such, or the nth (from 0).
   */
  const id = (role: string | null, name?: string, nth = 0) => {
    const ids = s
      .latest()!
      .controls.flatMap((c, k) =>
        (role === null || c.role === role) && (name === undefined || c.name === name)
          ? [`c${k + 1}`]
          : [],
      );
    if (!ids[nth]) throw new Error(`no ${role ?? 'control'} ${name ?? ''} ${nth}`);
    return ids[nth];
  };
  const go = (tool: string, input: Record<string, unknown> = {}) => s.call('scout', tool, input);
  return { s, id, go };
}

/** The route the three goals wrote, for the replay. */
let route: Table;
/** The ledger before anything ran: nothing here may move money. */
let before: Awaited<ReturnType<typeof balances>>;

describe("the Scout, scripted, across a run's three goals", () => {
  it('learns the balance, a transfer to its review and the activity, each from the start page', async () => {
    before = await balances();
    const judged: Judging[] = [];
    const page = await newPage(browser);
    const trail = await openTrail({
      sql: db,
      store: memoryStore(),
      runId: `fr_${Math.random().toString(16).slice(2, 10)}`,
      task: 'factory',
      bank: 'generic',
      known: [],
    });
    const why = 'the next step';
    // The bank is open before the Scout first looks, as run.ts opens it.
    await page.goto(bank.url);

    // The balance.
    {
      const { s, id, go } = aGoal(page, trail, 'balance', undefined, judged);
      await go('browser_look');
      await go('browser_open', { why: 'to start at the start page' });
      await go('name_page', {
        name: 'sign-in',
        kind: 'sign_in',
        shows: ['Operator ID:', 'Password:'],
      });
      await go('browser_type', { id: id('textbox'), label: 'Operator ID', value: 'user_id', why });
      await go('browser_type', { id: id('password'), label: 'Password', value: 'password', why });
      await go('browser_press', { id: id(null, 'Sign In'), why });
      await go('name_page', {
        name: 'code chooser',
        kind: 'staff_code',
        shows: ['Where should we send your code?'],
      });
      await go('browser_press', { id: id(null, 'Send code'), why });
      await go('name_page', {
        name: 'code',
        kind: 'staff_code',
        shows: ['Enter the 6-digit code we sent'],
      });
      await go('browser_type', { id: id('textbox'), label: 'Code', value: 'code', why });
      await go('browser_press', { id: id(null, 'Verify'), why });
      await go('name_page', { name: 'home', kind: 'home', shows: ['Use Member Search to begin.'] });
      await go('browser_press', { id: id(null, 'Member Search'), why });
      await go('name_page', { name: 'search', kind: 'member.search', shows: ['Member number:'] });
      await go('browser_type', { id: id('textbox'), label: 'Member number', value: 'member', why });
      await go('browser_press', { id: id(null, 'Search'), why });
      // The member's number shows: the name read first, then the page is named.
      await go('note_read', { what: 'name', text: '$member\n{name}\n{status}' });
      await go('name_page', {
        name: 'found',
        kind: 'member.search',
        shows: ['Member number:', 'Status'],
      });
      await go('browser_press', { id: id(null, 'Open'), as: 'Matching member', why });
      await go('name_page', {
        name: 'summary',
        kind: 'member.summary',
        shows: ['Member Summary', 'Available balance:'],
      });
      await go('note_read', {
        what: 'balance',
        text: '{name} Account ending in {last4} Available balance: {available} Current balance: {current}',
      });
      await go('note_read', { what: 'name', text: 'Member $member · {name}' });
      await go('goal_reached');
      route = s.table();
      expect(route.ends.balance).toBe('summary');
    }

    // The transfer, up to its review: from the start page, where a browser signed in once is
    // welcomed back.
    {
      const { s, id, go } = aGoal(page, trail, 'transfer', route, judged);
      await page.goto(bank.url);
      await go('browser_look');
      await go('name_page', {
        name: 'welcome back',
        kind: 'sign_in',
        shows: ['Welcome back', 'Password:'],
      });
      await go('browser_type', { id: id('password'), label: 'Password', value: 'password', why });
      await go('browser_press', { id: id(null, 'Sign In'), why });
      // The screens the route knows are known again: no code on a remembered workstation.
      await go('browser_press', { id: id(null, 'Member Search'), why });
      await go('browser_type', { id: id('textbox'), label: 'Member number', value: 'member', why });
      await go('browser_press', { id: id(null, 'Search'), why });
      await go('browser_press', { id: id(null, 'Open'), as: 'Matching member', why });
      // The menu draws a Transfer Funds too: the one in the summary's panel, under its heading.
      await go('browser_press', {
        id: id(null, 'Transfer Funds', 1),
        near: 'Member Summary',
        why,
      });
      await go('name_page', {
        name: 'transfer form',
        kind: 'transfer.form',
        shows: ['From:', 'Amount:', 'Continue'],
      });
      await go('browser_choose', { id: id('select'), label: 'From', account: 'from', why });
      await go('browser_choose', {
        id: id('select', undefined, 1),
        label: 'To',
        account: 'to',
        why,
      });
      await go('browser_type', { id: id('textbox'), label: 'Amount', value: 'amount', why });
      await go('browser_type', {
        id: id('textbox', undefined, 1),
        label: 'Memo',
        value: 'memo',
        why,
      });
      await go('browser_press', { id: id(null, 'Continue'), why });
      await go('name_page', {
        name: 'review',
        kind: 'transfer.review',
        shows: ['Review transfer'],
      });
      await go('note_read', {
        what: 'review',
        parts: [
          { placeholder: 'from', after: 'From:' },
          { placeholder: 'to', after: 'To:' },
          { placeholder: 'amount', after: 'Amount:' },
          { placeholder: 'memo', after: 'Memo:' },
        ],
      });
      // Named, never pressed.
      await go('goal_reached', { submit: 'Submit transfer' });
      route = s.table();
      expect(route.ends.transfer).toBe('review');
      expect(route.submit.press).toBe('Submit transfer');
    }

    // The from-account's activity, from the start page again.
    {
      const { s, id, go } = aGoal(page, trail, 'history', route, judged);
      await page.goto(bank.url);
      await go('browser_look');
      await go('browser_type', { id: id('password'), label: 'Password', value: 'password', why });
      await go('browser_press', { id: id(null, 'Sign In'), why });
      await go('browser_press', { id: id(null, 'Member Search'), why });
      await go('browser_type', { id: id('textbox'), label: 'Member number', value: 'member', why });
      await go('browser_press', { id: id(null, 'Search'), why });
      await go('browser_press', { id: id(null, 'Open'), as: 'Matching member', why });
      await go('browser_press', { id: id(null, 'Activity'), near: input.from, why });
      await go('name_page', {
        name: 'activity',
        kind: 'activity',
        shows: ['Activity:', 'Description'],
      });
      await go('goal_reached');
      route = s.table();
      expect(route.ends.history).toBe('activity');
    }
    await page
      .context()
      .close()
      .catch(() => undefined);

    // Every action was judged, and no call pressed the send.
    const calls = judged.flatMap((j) => j.record);
    expect(calls.filter((e) => e.error)).toEqual([]);
    expect(calls.filter((e) => /^pressed[^.]*Submit/.test(e.result ?? ''))).toEqual([]);
  }, 360_000);

  it('writes a route the guard passes, every screen with its kind', () => {
    expect(route.ends).toEqual({ balance: 'summary', transfer: 'review', history: 'activity' });
    expect(refusals(route)).toEqual([]);
    expect(route.rows.filter((r) => !r.screen).map((r) => r.page)).toEqual([]);
    const row = (page: string) => route.rows.find((r) => r.page === page)!;
    // The returning sign-in is its own screen, and the first never takes it for itself.
    expect(row('sign-in').never).toContain('Welcome back');
    expect(row('welcome back').do.transfer).toEqual([
      { type: 'Password', value: '$password' },
      { press: 'Sign In' },
    ]);
    // The summary holds each goal's own way on, by the task's account where it is the task's.
    expect(row('summary').do.transfer).toEqual([
      { press: 'Transfer Funds', near: 'Member Summary' },
    ]);
    expect(row('summary').do.history).toEqual([{ press: 'Activity', near: '$from' }]);
    expect(row('transfer form').do.transfer).toEqual([
      { choose: 'From', containing: '$from' },
      { choose: 'To', containing: '$to' },
      { type: 'Amount', value: '$amount' },
      { type: 'Memo', value: '$memo' },
      { press: 'Continue' },
    ]);
    // Each goal's end holds no steps for that goal, and nothing presses the send.
    for (const goal of ['balance', 'transfer', 'history'] as const)
      expect(row(route.ends[goal]).do[goal]).toBeUndefined();
    expect(JSON.stringify(route.rows)).not.toMatch(/Submit/);
  });

  it('runs under the crawler with no model and the guard on: balance, review, activity', async () => {
    const page = await newPage(browser);
    let goal: Goal = 'balance';
    const guarded: (Action & { goal: Goal })[] = [];
    const visited: Record<Goal, string[]> = { balance: [], transfer: [], history: [] };
    const session = {
      guard: (a: Action) => {
        guarded.push({ ...a, goal });
        const v = judge(route, goal, a);
        if (!v.allowed) throw new Error(`the guard refused: ${v.rule}`);
      },
      page,
      url: bank.url,
      table: route,
      known: [],
      credentials: async () => credentials,
      code,
      keep: (seen: { page: string | null }) => void visited[goal].push(seen.page ?? '?'),
    };
    // Another memo than the one learned with: the route holds the task's, not that run's.
    const task = { ...input, amountCents: 100, memo: 'GBX GATE' };
    try {
      const b = await checkBalance(session, { ...task, account: input.from });
      const checking = before.find((a) => a.nickname === input.from)!;
      expect(b.availableCents).toBe(checking.availableCents);

      goal = 'transfer';
      const r = await prepareTransfer(session, task);
      expect(r).toMatchObject({ amountCents: 100, memo: 'GBX GATE' });
      expect(r.from).toContain(input.from);
      expect(r.to).toContain(input.to);
      // A browser signed in once is welcomed back, and the route knows that screen.
      expect(visited.transfer[0]).toBe('welcome back');

      goal = 'history';
      await crawl(session, task, 'history');
      expect(visited.history.at(-1)).toBe('activity');
      expect((await leaves(page)).join('\n')).toMatch(/Activity: Everyday Checking/);
    } finally {
      await page
        .context()
        .close()
        .catch(() => undefined);
    }
    // Never a press of the send, and the ledger is as it was.
    expect(guarded.filter((a) => /submit/i.test(a.control))).toEqual([]);
    expect(await balances()).toEqual(before);
  }, 240_000);
});
