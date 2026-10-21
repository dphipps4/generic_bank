// The factory learns a site by its pages' own titles, and the crawler knows them the same way. A
// script stands where the model would, on a small legacy site in no bank's words: no model, no
// bank. The Scout never names a page; each step is filed under the page it was taken on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judge, refusals } from '../../apps/factory/src/guard.js';
import { openTrail } from '../../apps/factory/src/trail.js';
import { scout, type Judging, type Task } from '../../apps/factory/src/scout.js';
import { checkBalance, type Table } from '../../packages/crawler/src/index.js';
import { hazardHeader, memoryStore } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import {
  type Browser,
  knows,
  launch,
  newPage,
  type Page,
} from '../../packages/runtime/src/index.js';
import { pagesOf } from '../../packages/crawler/src/crawl.js';
import { legacySite, redesign, SITE } from '../support/legacy-site.js';

let site: Awaited<ReturnType<typeof legacySite>>;
let browser: Browser;
let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  [site, browser, db] = await Promise.all([legacySite(), launch(), controlDb()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await site?.close();
  await db?.close();
});

const credentials = { operatorId: 'teller0001', password: 'a-password-for-tests' };
const task: Task = { goal: 'balance', member: SITE.member, from: SITE.account };

async function aScout(page: Page, judged: Judging[], table?: Table, learn = true) {
  const trail = await openTrail({
    sql: db,
    store: memoryStore(),
    runId: `fr_${Math.random().toString(16).slice(2, 10)}`,
    task: 'check-balance',
    bank: 'sample',
    known: [],
  });
  const s = scout(
    {
      page,
      start: site.url,
      trail,
      credentials,
      code: async () => '',
      judge: async (j) => (judged.push(j), { verdict: 'continue', says: 'Fine.' }),
      ...(table ? { table } : {}),
      learn,
    },
    task,
  );
  const id = (role: string, name?: string) => {
    const i = s
      .latest()!
      .controls.findIndex((c) => c.role === role && (name === undefined || c.name === name));
    if (i < 0) throw new Error(`no ${role} ${name ?? ''}`);
    return `c${i + 1}`;
  };
  const go = (tool: string, input: Record<string, unknown> = {}) => s.call('scout', tool, input);
  return { s, id, go };
}

const why = 'the next step';
const crawlerSession = (page: Page, table: Table) => ({
  page,
  url: site.url,
  table,
  known: [],
  credentials: async () => credentials,
  code: async () => '',
  guard: (a: Parameters<typeof judge>[2]) =>
    expect(judge(table, 'balance', a)).toEqual({ allowed: true }),
});

describe('a site learned by its pages’ own titles', () => {
  it('files each step under the page it was taken on, by its title, and the crawler reads the balance', async () => {
    const judged: Judging[] = [];
    const known = await newPage(browser);
    const { s, id, go } = await aScout(known, judged);
    await go('browser_open', { why: 'to start' });
    await go('page_kind', { kind: 'sign_in' });
    await go('browser_type', { id: id('textbox'), label: 'Operator ID', value: 'user_id', why });
    await go('browser_type', { id: id('password'), label: 'Password', value: 'password', why });
    await go('browser_press', { id: id('button', 'Sign In'), why });
    await go('page_kind', { kind: 'home' });
    await go('browser_press', { id: id('link', 'Member Search'), why });
    await go('page_kind', { kind: 'member.search' });
    await go('browser_type', { id: id('textbox'), label: 'Member number', value: 'member', why });
    await go('browser_press', { id: id('button', 'Search'), why });
    // The results show on the same page, under the same title: it is the same page.
    await go('note_read', { what: 'name', text: '$member\n{name}\nActive' });
    await go('browser_press', { id: id('link', 'Open'), as: 'Matching member', why });
    await go('page_kind', { kind: 'member.summary' });
    await go('note_read', {
      what: 'balance',
      text: '{name} Account ending in {last4} Available balance: {available} Current balance: {current}',
    });
    await go('note_read', { what: 'name', text: 'Member $member · {name}' });
    await go('goal_reached');

    const t = s.table();
    // One page per title, each named by it; no name was given by the Scout.
    expect(t.rows.map((r) => r.page)).toEqual([
      'Branch Sign In',
      'Branch Home',
      'Member Search',
      'Member Summary',
    ]);
    expect(t.rows.find((r) => r.page === 'Member Search')!.do.balance).toEqual([
      { type: 'Member number', value: '$member' },
      { press: 'Search' },
      { press: 'Open' },
    ]);
    expect(t.ends.balance).toBe('Member Summary');
    expect(refusals(t, ['balance'])).toEqual([]);

    // A browser the site knows meets the shorter sign-in, under the same title: another page, told
    // apart by its fields, and learned the same way.
    const again = await aScout(known, [], t);
    await again.go('browser_open', { why: 'to start again, as the next task does' });
    await again.go('page_kind', { kind: 'sign_in' });
    await again.go('browser_type', {
      id: again.id('password'),
      label: 'Password',
      value: 'password',
      why,
    });
    await again.go('browser_press', { id: again.id('button', 'Sign In'), why });
    const t2 = again.s.table();
    expect(t2.rows.map((r) => [r.page, r.title, r.fields])).toContainEqual([
      'Branch Sign In (password)',
      'Branch Sign In',
      ['password'],
    ]);
    expect(t2.rows.find((r) => r.page === 'Branch Sign In')!.fields).toEqual([
      'password',
      'textbox',
    ]);

    // The crawler, with no model, knows both sign-ins and reads the balance from a new browser and
    // from the one the site knows.
    for (const page of [await newPage(browser), known]) {
      const b = await checkBalance(crawlerSession(page, t2), {
        member: SITE.member,
        account: SITE.account,
      });
      expect(b.availableCents).toBe(SITE.availableCents);
    }
    // The tools filed every page by the crawler's own function: each kept frame is known as its page.
    expect(judged.every((j) => j.frame.title !== undefined)).toBe(true);
    for (const j of judged.filter((j) => j.frame.title))
      expect(() => knows(j.frame, pagesOf(t2))).not.toThrow();
  }, 240_000);

  it('shows the Supervisor every call the Scout makes, exactly once, failures included', async () => {
    const judged: Judging[] = [];
    const { id, go } = await aScout(await newPage(browser), judged);
    const made: string[] = [];
    const call = async (tool: string, input: Record<string, unknown> = {}) => {
      made.push(tool);
      return go(tool, input).catch((e: Error) => e);
    };
    await call('browser_open', { why: 'to start' });
    await call('browser_look');
    // Refused: no control at that point. The Supervisor judges it at once, error and all.
    const before = judged.length;
    const refused = await call('browser_press', { x: 1, y: 1, why: 'a test' });
    expect(judged.length).toBe(before + 1);
    expect(String(refused)).toMatch(/The Supervisor: Fine/);
    // Refused: a step on a page whose kind the Scout hasn't said, as the guard needs it.
    expect(
      String(
        await call('browser_type', {
          id: id('textbox'),
          label: 'Operator ID',
          value: 'user_id',
          why,
        }),
      ),
    ).toMatch(/say this page's kind with page_kind first/);
    await call('page_kind', { kind: 'sign_in' });
    await call('browser_type', { id: id('textbox'), label: 'Operator ID', value: 'user_id', why });
    // Every call, in order, in exactly one judgment's record.
    expect(judged.flatMap((j) => j.record.map((e) => e.tool))).toEqual(made);
  }, 120_000);
  it("notes the site's own answers to forced hazards in the hazard pass, and the crawler then gets past them", async () => {
    // The route, learned as above.
    const known = await newPage(browser);
    const { s, id, go } = await aScout(known, []);
    await go('browser_open', { why: 'to start' });
    await go('page_kind', { kind: 'sign_in' });
    await go('browser_type', { id: id('textbox'), label: 'Operator ID', value: 'user_id', why });
    await go('browser_type', { id: id('password'), label: 'Password', value: 'password', why });
    await go('browser_press', { id: id('button', 'Sign In'), why });
    await go('page_kind', { kind: 'home' });
    await go('browser_press', { id: id('link', 'Member Search'), why });
    await go('page_kind', { kind: 'member.search' });
    await go('browser_type', { id: id('textbox'), label: 'Member number', value: 'member', why });
    await go('browser_press', { id: id('button', 'Search'), why });
    await go('note_read', { what: 'name', text: '$member\n{name}\nActive' });
    await go('browser_press', { id: id('link', 'Open'), as: 'Matching member', why });
    await go('page_kind', { kind: 'member.summary' });
    await go('note_read', {
      what: 'balance',
      text: '{name} Account ending in {last4} Available balance: {available} Current balance: {current}',
    });
    await go('note_read', { what: 'name', text: 'Member $member · {name}' });
    await go('goal_reached');
    // The next goal starts from the start page in this browser, which the site knows: the shorter
    // sign-in joins the route, as it does in a run.
    const next = await aScout(known, [], s.table());
    await next.go('browser_open', { why: 'the next goal, from the start page' });
    await next.go('page_kind', { kind: 'sign_in' });
    await next.go('browser_type', {
      id: next.id('password'),
      label: 'Password',
      value: 'password',
      why,
    });
    await next.go('browser_press', { id: next.id('button', 'Sign In'), why });
    const learned = next.s.table();
    const key = 'a-hazard-key-for-tests';
    const under = (hazard: string) =>
      newPage(browser, { headers: hazardHeader([hazard as never], key) });
    const ended = (p: Page, t: Table) =>
      checkBalance(crawlerSession(p, t), { member: SITE.member, account: SITE.account }).then(
        () => null,
        (e: { ended?: { code: string } }) => e.ended ?? { code: String(e) },
      );
    // Before the hazard pass, a promotion in place of a page stops the crawler.
    expect(await ended(await under('promo'), learned)).not.toBeNull();

    // The hazard pass: a promotion, then a record in use. Each is noted in the site's own words,
    // and the route's steps don't change.
    const steps = JSON.stringify(learned.rows);
    const p1 = await aScout(await under('promo'), [], learned, false);
    await p1.go('browser_open', { why: 'the goal again, by the route' });
    await p1.go('page_kind', { kind: 'sign_in' });
    await p1.go('browser_type', {
      id: p1.id('textbox'),
      label: 'Operator ID',
      value: 'user_id',
      why,
    });
    await p1.go('browser_type', {
      id: p1.id('password'),
      label: 'Password',
      value: 'password',
      why,
    });
    await p1.go('browser_press', { id: p1.id('button', 'Sign In'), why });
    const promo = await p1.go('note_trouble', {
      says: 'Have a look at what is new',
      means: 'app_error',
      press: 'Not now',
      kind: 'promo',
    });
    expect(promo.text).toMatch(/stop now/);
    await expect(p1.go('goal_reached')).rejects.toThrow(/changes nothing in the route/);
    const afterPromo = p1.s.table();
    expect(JSON.stringify(afterPromo.rows)).toBe(steps);
    expect(afterPromo.trouble.map((t) => [t.says, t.press, t.screen])).toEqual([
      ['Have a look at what is new', 'Not now', 'promo'],
    ]);

    await known.setExtraHTTPHeaders(hazardHeader(['record-in-use' as never], key));
    const p2 = await aScout(known, [], afterPromo, false);
    await p2.go('browser_open', { why: 'the goal again, by the route' });
    // A browser the site knows meets the shorter sign-in.
    await p2.go('browser_type', {
      id: p2.id('password'),
      label: 'Password',
      value: 'password',
      why,
    });
    await p2.go('browser_press', { id: p2.id('button', 'Sign In'), why });
    await p2.go('browser_press', { id: p2.id('link', 'Member Search'), why });
    await p2.go('browser_type', {
      id: p2.id('textbox'),
      label: 'Member number',
      value: 'member',
      why,
    });
    await p2.go('browser_press', { id: p2.id('button', 'Search'), why });
    await p2.go('note_answer', {
      says: 'This record is in use by another operator.',
      means: 'record_in_use',
    });
    await known.setExtraHTTPHeaders({});
    const taught = p2.s.table();
    expect(JSON.stringify(taught.rows)).toBe(steps);
    expect(taught.answers.map((a) => [a.says, a.code])).toEqual([
      ['This record is in use by another operator.', 'record_in_use'],
    ]);

    // The crawler, with what the pass noted: past the promotion to the balance, and the right
    // result when the record is in use.
    const b = await checkBalance(crawlerSession(await under('promo'), taught), {
      member: SITE.member,
      account: SITE.account,
    });
    expect(b.availableCents).toBe(SITE.availableCents);
    expect((await ended(await under('record-in-use'), taught))?.code).toBe('record_in_use');

    // An error page whose reference changes on every load: noted once, with the reference kept as
    // {value}, and found again by the crawler under another reference.
    expect((await ended(await under('js-error-fatal'), taught))?.code).not.toBe('app_error');
    await known.setExtraHTTPHeaders(hazardHeader(['js-error-fatal' as never], key));
    const p3 = await aScout(known, [], taught, false);
    await p3.go('browser_open', { why: 'the goal again, by the route' });
    await p3.go('browser_type', {
      id: p3.id('password'),
      label: 'Password',
      value: 'password',
      why,
    });
    await p3.go('browser_press', { id: p3.id('button', 'Sign In'), why });
    const shown = /An unexpected error has occurred\. Reference ERR-\S+/.exec(
      p3.s.latest()!.frame.tree,
    )![0];
    const noted = await p3.go('note_trouble', { says: shown, means: 'app_error' });
    await known.setExtraHTTPHeaders({});
    expect(noted.text).toMatch(
      /Noted as "An unexpected error has occurred\. Reference \{value\}", id [0-9a-f-]{36}/,
    );
    const withError = p3.s.table();
    expect(JSON.stringify(withError.rows)).toBe(steps);
    expect(withError.trouble.at(-1)!.says).toBe(
      'An unexpected error has occurred. Reference {value}',
    );
    expect((await ended(await under('js-error-fatal'), withError))?.code).toBe('app_error');
  }, 300_000);

  it('repairs a route a redesign broke: the renamed page joins under its new title', async () => {
    // The route, learned before the redesign.
    const known = await newPage(browser);
    const { s, id, go } = await aScout(known, []);
    await go('browser_open', { why: 'to start' });
    await go('page_kind', { kind: 'sign_in' });
    await go('browser_type', { id: id('textbox'), label: 'Operator ID', value: 'user_id', why });
    await go('browser_type', { id: id('password'), label: 'Password', value: 'password', why });
    await go('browser_press', { id: id('button', 'Sign In'), why });
    await go('page_kind', { kind: 'home' });
    await go('browser_press', { id: id('link', 'Member Search'), why });
    await go('page_kind', { kind: 'member.search' });
    await go('browser_type', { id: id('textbox'), label: 'Member number', value: 'member', why });
    await go('browser_press', { id: id('button', 'Search'), why });
    await go('note_read', { what: 'name', text: '$member\n{name}\nActive' });
    await go('browser_press', { id: id('link', 'Open'), as: 'Matching member', why });
    await go('page_kind', { kind: 'member.summary' });
    await go('note_read', {
      what: 'balance',
      text: '{name} Account ending in {last4} Available balance: {available} Current balance: {current}',
    });
    await go('note_read', { what: 'name', text: 'Member $member · {name}' });
    await go('goal_reached');
    const before = s.table();
    const balance = (t: Table) =>
      newPage(browser).then((p) =>
        checkBalance(crawlerSession(p, t), { member: SITE.member, account: SITE.account }).then(
          (b) => b.availableCents,
          (e: { ended?: { code: string } }) => e.ended?.code ?? String(e),
        ),
      );
    expect(await balance(before)).toBe(SITE.availableCents);

    redesign(true);
    try {
      // The deterministic crawler breaks on the redesigned site: its route doesn't know the page.
      expect(await balance(before)).not.toBe(SITE.availableCents);

      // The repair: the Scout starts from the broken route and walks the site again. The renamed
      // page joins the route under its own new title; the pages that didn't move keep theirs.
      const fix = await aScout(await newPage(browser), [], before);
      await fix.go('browser_open', { why: 'the goal again, from the broken route' });
      await fix.go('browser_type', {
        id: fix.id('textbox'),
        label: 'Operator ID',
        value: 'user_id',
        why,
      });
      await fix.go('browser_type', {
        id: fix.id('password'),
        label: 'Password',
        value: 'password',
        why,
      });
      await fix.go('browser_press', { id: fix.id('button', 'Sign In'), why });
      await fix.go('browser_press', { id: fix.id('link', 'Look Up'), as: 'Member Search', why });
      await fix.go('page_kind', { kind: 'member.search' });
      await fix.go('browser_type', {
        id: fix.id('textbox'),
        label: 'Member ID',
        value: 'member',
        why,
      });
      await fix.go('browser_press', { id: fix.id('button', 'Search'), why });
      await fix.go('browser_press', { id: fix.id('link', 'Open'), as: 'Matching member', why });
      await fix.go('goal_reached');
      const after = fix.s.table();
      expect(after.rows.map((r) => r.page)).toContain('Look Up a Member');
      expect(after.rows.find((r) => r.page === 'Branch Home')!.do.balance).toEqual([
        { press: 'Look Up' },
      ]);
      // The repaired route serves the redesigned site.
      expect(await balance(after)).toBe(SITE.availableCents);
    } finally {
      redesign(false);
    }
  }, 300_000);
});
