import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS } from '../src/seed.js';
import { TENANTS, type TenantId } from '../src/tenants.js';
import { type Client, signIn, type TestBank, testBank } from './harness.js';

// BANK_REDESIGN: the vendor's redesign. Off, every bank is as it was. On, every bank shows
// "We've refreshed Online Banking" once after sign-in, renames its places in its own words, and
// moves its nav into one Menu at the top right; the ledger, the transfers and the refusals stay.

const IDS = Object.keys(TENANTS) as TenantId[];
const off = {} as Record<TenantId, { b: TestBank; c: Client }>;
const on = {} as Record<TenantId, { b: TestBank; c: Client }>;
beforeAll(async () => {
  for (const id of IDS) {
    const b = await testBank(id);
    off[id] = { b, c: await signIn(b) };
    const r = await testBank(id, undefined, { redesign: true });
    on[id] = { b: r, c: await signIn(r) };
  }
}, 180_000);
afterAll(async () => {
  for (const id of IDS) await Promise.all([off[id].b.close(), on[id].b.close()]);
});

/** The redesigned console's Menu: each place's address and name. */
const menu = (html: string) =>
  [
    ...html.matchAll(/<a HREF="([^"]+)" TARGET="\w+" STYLE="display:block[^"]*">([^<]+)<\/a>/gi),
  ].map((m) => ({ href: m[1]!, text: m[2]! }));
/** What a person reads: tags gone, scripts' markup too. */
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const said = (text: string, w: string) =>
  new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
const where = (base: string, path: string) =>
  path.replace(/^https?:\/\/[^/]+/, '').slice(base.length);

describe('with BANK_REDESIGN off', () => {
  for (const id of IDS) {
    it(`${id}: signs in to the console it always had, in its old words`, async () => {
      const { b, c } = off[id];
      const t = TENANTS[id];
      expect(where(b.base, c.landing)).toBe('console');
      expect((await c.get('refreshed')).status).toBe(404);
      const console_ = (await c.get('console')).body;
      expect(console_).not.toContain('Menu &#9662;');
      expect((await c.get('home')).body).toContain(`Use ${t.labels.memberSearch} to begin.`);
      const summary = (await c.get(`members/${MEMBERS.demo}`)).body;
      expect(summary).toContain(`>Activity</a>`);
      expect(summary).toContain(t.labels.transferFunds);
    });
  }
});

describe('with BANK_REDESIGN on', () => {
  for (const id of IDS) {
    const t = TENANTS[id];
    const renamed = (k: keyof typeof t.redesign) => t.redesign[k];

    it(`${id}: shows "We've refreshed Online Banking" once after sign-in, then the console`, async () => {
      const { b } = on[id];
      const c = await signIn(b);
      const at = where(b.base, c.landing);
      expect(at).toBe('refreshed');
      const page = (await c.get(at)).body;
      expect(page).toContain("We've refreshed Online Banking");
      expect(page).toContain('has a new look');
      expect(page).toContain('Continue to Online Banking');
      expect((await c.post('refreshed', {})).location).toBe(`${b.base}console`);
      for (const p of ['console', 'home', 'members/search', `members/${MEMBERS.demo}`])
        expect((await c.get(p)).body).not.toContain('has a new look');
      expect((await b.client().get('refreshed')).location).toBe(`${b.base}signin`);
    });

    it(`${id}: moves the nav into one Menu at the top right, with the notices on the left`, async () => {
      const r = (await on[id].c.get('console')).body;
      expect(r).not.toMatch(/<frameset/i);
      expect(r).toContain('Menu &#9662;');
      expect(r).toMatch(/display:none;position:absolute;right:0/);
      expect(r.indexOf('Notices')).toBeLessThan(r.search(/<iframe NAME="main"/i));
      for (const m of r.matchAll(/<script>([\s\S]*?)<\/script>/gi))
        expect(() => new Function(m[1]!)).not.toThrow();
      // The same places to go as before, under their new names.
      const before = (await off[id].c.get('frame/nav')).body;
      const places = (html: string) =>
        new Set([...html.matchAll(/HREF=\\?"([^"\\]+)/gi)].map((m) => m[1]!));
      expect(new Set(menu(r).map((m) => m.href))).toEqual(places(before));
      const names = menu(r).map((m) => m.text);
      for (const k of ['memberSearch', 'transferFunds', 'statements'] as const) {
        expect(names).toContain(renamed(k));
        expect(names).not.toContain(t.labels[k]);
      }
    });

    it(`${id}: says the new words, and the old ones are gone`, async () => {
      const { c } = on[id];
      const acct = (await accountsOf(on[id].b.db, MEMBERS.demo))[0]!.id;
      const pages = await Promise.all(
        [
          'console',
          'home',
          'members/search',
          `members/${MEMBERS.demo}`,
          `members/${MEMBERS.demo}/transfer`,
          `members/${MEMBERS.demo}/activity?account=${acct}`,
        ].map(async (p) => (await c.get(p)).body),
      );
      const text = words(pages.join('\n'));
      expect(words(pages[1]!)).toContain(`Open the Menu and choose ${renamed('memberSearch')}.`);
      for (const k of ['memberSearch', 'transferFunds', 'statements', 'activity'] as const) {
        expect(text, `${id} says "${renamed(k)}"`).toContain(renamed(k));
        expect(said(text, t.labels[k]), `${id} no longer says "${t.labels[k]}"`).toBe(false);
      }
      // The summary's tiles stack in one column, and its transfer link moves below them.
      const summary = pages[3]!;
      expect(summary).toContain(`if (i > 0) { h += '</tr><tr>'; }`);
      expect(summary.indexOf(`>${renamed('transferFunds')}<`)).toBeGreaterThan(
        summary.search(/<div CLASS="c\w+"><\/div>/i),
      );
    });

    it(`${id}: a balance and a transfer, by hand through the new pages`, async () => {
      const { b, c } = on[id];
      const n = MEMBERS.demo;
      // The Menu leads to the member search; the search finds the member.
      const find = menu((await c.get('console')).body).find(
        (m) => m.text === renamed('memberSearch'),
      )!;
      expect((await c.get(find.href)).status).toBe(200);
      await c.post(find.href, { number: n });
      const found = JSON.parse((await c.get(`api/members?number=${n}&next=`)).body);
      const summary = (await c.get(found.open)).body;
      expect(summary).toContain(`>${renamed('activity')}</a>`);

      // The balance: what the tiles draw is what the ledger holds.
      const ledger = await accountsOf(b.db, n);
      const tiles = JSON.parse((await c.get(`api/members/${n}/accounts`)).body).accounts;
      for (const a of ledger)
        expect(tiles.find((x: { id: number }) => x.id === a.id)).toMatchObject({
          available: a.availableCents,
          current: a.currentCents,
        });

      // The transfer, from the summary's link: refused in the same words, then posted once.
      const transfer = /HREF="([^"]+\/transfer)"/i.exec(summary)![1]!;
      const [from, to] = ledger;
      const accounts = { from: String(from!.id), to: String(to!.id) };
      expect((await c.post(transfer, { ...accounts, amount: '0', memo: 'RD0' })).body).toContain(
        'Enter an amount between $0.01 and $25,000.00.',
      );
      const r = await c.post(transfer, { ...accounts, amount: '25.00', memo: 'RD1' });
      expect(r.location).toBe(`${transfer}/review`);
      expect((await c.get(r.location)).body).toContain('RD1');
      expect((await c.post(`${transfer}/submit`, {})).body).toMatch(/Confirmation number \S+\./);
      const after = await accountsOf(b.db, n);
      expect(after[0]!.currentCents).toBe(from!.currentCents - 2_500);
      expect(after[1]!.currentCents).toBe(to!.currentCents + 2_500);
    });
  }
});
