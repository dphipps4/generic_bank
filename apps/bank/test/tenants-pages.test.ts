import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS } from '../src/seed.js';
import { TENANTS, type TenantId } from '../src/tenants.js';
import { type Client, PORTS, signIn, type TestBank, testBank } from './harness.js';

// Every bank's pages speak only that bank's words, in that bank's colors.

const IDS = Object.keys(TENANTS) as TenantId[];
const banks = {} as Record<TenantId, { b: TestBank; c: Client; pages: string }>;
/** What a person reads: tags gone (an image's words are its alt text), so a split label reads as one. */
const text = {} as Record<TenantId, string>;

beforeAll(async () => {
  for (const id of IDS) {
    const b = await testBank(id);
    const c = await signIn(b);
    const acct = (await accountsOf(b.db, MEMBERS.demo))[0]!.id;
    const paths = [
      'signin?other=1',
      'frame/nav',
      'frame/banner',
      'members/search',
      `members/${MEMBERS.demo}`,
      `members/${MEMBERS.demo}/transfer`,
      `members/${MEMBERS.demo}/statements?account=${acct}`,
    ];
    const bodies = (await Promise.all(paths.map((p) => c.get(p)))).map((r) => r.body);
    // Bank 4's sign-in form lives on its second origin, inside the shell's inline frame.
    if (TENANTS[id].secondOrigin === 'signin') {
      c.host = `localhost:${PORTS[id].second}`;
      bodies.push((await c.get('signin?other=1&embedded=1')).body);
      c.host = '';
    }
    const pages = bodies.join('\n');
    banks[id] = { b, c, pages };
    text[id] = pages
      .replace(/<[^>]*\balt="([^"]*)"[^>]*>/gi, ' $1 ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
  }
}, 120_000);
afterAll(async () => {
  for (const id of IDS) await banks[id].b.close();
});

describe('each bank', () => {
  for (const id of IDS) {
    it(`${id}: signs in and shows its own words`, () => {
      const t = TENANTS[id];
      expect(text[id]).toContain(t.brand);
      for (const w of [
        t.labels.operatorId,
        t.labels.password,
        t.labels.memberSearch,
        t.labels.transferFunds,
        t.labels.continue,
        t.labels.statements,
      ]) {
        expect(text[id], `${id} should say "${w}"`).toContain(w);
      }
    });

    it(`${id}: never shows another bank's words`, () => {
      const mine = new Set(Object.values(TENANTS[id].labels));
      const theirs = IDS.filter((x) => x !== id)
        .flatMap((x) => Object.values(TENANTS[x].labels))
        .filter((w) => !mine.has(w) && w.length > 3);
      // Words that are also ordinary English in this bank's pages are not a leak.
      const ordinary = new Set([
        'Member',
        'Member number',
        'Statements',
        'Transfer',
        'Continue',
        'Accounts',
        'Password',
        'Search',
      ]);
      for (const w of theirs.filter((x) => !ordinary.has(x)))
        expect(text[id], `${id} must not say "${w}"`).not.toMatch(new RegExp(`\\b${w}\\b`));
      for (const other of IDS.filter((x) => x !== id))
        expect(banks[id].pages).not.toContain(TENANTS[other].brand);
    });
  }

  it('each has its own colors, and only Generic Bank is best viewed in Internet Explorer', () => {
    const bg = IDS.map((id) => /BGCOLOR="(#[0-9A-F]{6})"/i.exec(banks[id].pages)![1]);
    expect(new Set(bg).size).toBe(4);
    for (const id of IDS)
      expect(banks[id].pages.includes('Best viewed in Internet Explorer')).toBe(id === 'generic');
  });
});
