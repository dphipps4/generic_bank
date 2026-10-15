import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/auth.js';
import { buildInbox } from '../src/inbox.js';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS, OPERATORS } from '../src/seed.js';
import { TENANTS } from '../src/tenants.js';
import { type Client, codeFor, PASSWORDS, signIn, type TestBank, testBank } from './harness.js';

// Placeholder FCU: an authenticator app, search results in a popup, a transfer split over pages,
// and six kinds of trouble of its own.

let b: TestBank;
let c: Client;
beforeAll(async () => {
  b = await testBank('placeholder');
  c = await signIn(b);
});
afterAll(() => b.close());

const scriptsParse = (html: string) => {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/gi))
    expect(() => new Function(m[1]!)).not.toThrow();
};
const toCode = async (d: Client) => {
  await d.get('signin');
  await d.post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service });
  return d;
};

describe('the authenticator code', () => {
  it('is RFC 6238', () => {
    // The RFC's SHA-1 test vector, last six digits of 94287082 at T = 59 s.
    expect(totp(Buffer.from('12345678901234567890').toString('hex'), new Date(59_000))).toBe(
      '287082',
    );
  });

  it('is never sent: the code page asks for the app’s code', async () => {
    const d = await toCode(b.client());
    const before = (await b.db.query<{ n: number }>('SELECT count(*)::int AS n FROM messages'))
      .rows[0]!.n;
    expect((await d.get('code')).location).toBe('/cu/ib/code/enter');
    expect((await d.get('code/enter')).body).toContain(
      'Enter the 6-digit code from your authenticator app.',
    );
    expect(
      (await b.db.query<{ n: number }>('SELECT count(*)::int AS n FROM messages')).rows[0]!.n,
    ).toBe(before);
  });

  it('silent-code-clear: an expired code clears the field with no message; a wrong one says so', async () => {
    const d = await toCode(b.client());
    const secret = (
      await b.db.query<{ s: string }>(
        'SELECT totp_secret AS s FROM operators WHERE operator_id = $1',
        [OPERATORS.service.id],
      )
    ).rows[0]!.s;
    const old = totp(secret, new Date(b.clock.now.getTime() - 3 * 30_000));
    const now = totp(secret, b.clock.now);
    const expired = await d.post('code/enter', { code: old === now ? '000000' : old });
    expect(expired.body).not.toMatch(/expired|not correct/);
    expect(
      (await d.post('code/enter', { code: now === '123456' ? '654321' : '123456' })).body,
    ).toContain('That code is not correct.');
    expect(
      (await d.post('code/enter', { code: await codeFor(b, OPERATORS.service.id) })).location,
    ).toMatch(/auth\/callback/);
  });

  it('shows in the staff inbox as an authenticator app', async () => {
    const inbox = await buildInbox([{ t: TENANTS.placeholder, db: b.db }]);
    const page = (await inbox.inject({ url: '/' })).body;
    expect(page).toContain('Authenticator');
    expect(page).toMatch(/Operator 0412<\/span> <b>\d{6}<\/b>/);
  });
});

describe('handoff-bounce', () => {
  it('draws the console for a moment, drops the first sign-in of the day back to sign-in, then lets it through', async () => {
    const fresh = await testBank('placeholder');
    const d = await toCode(fresh.client());
    await d.get('code');
    const r = await d.post('code/enter', { code: await codeFor(fresh, OPERATORS.service.id) });
    const h = new URL(r.location, 'http://x').searchParams.get('code')!;
    const bounce = await d.get(`auth/complete?code=${encodeURIComponent(h)}`);
    expect(bounce.status).toBe(200);
    expect(bounce.body).toContain('top.location.replace("http://localhost:8084/cu/ib/signin")');
    expect((await d.get('console')).location).toBe('/cu/ib/signin');
    await signIn(fresh, d);
    expect((await d.get('console')).status).toBe(200);
    await fresh.close();
  });
});

describe('member search in a popup window', () => {
  it('opens the results in a new window whose Open link moves the console', async () => {
    const page = await c.post('members/search', { number: MEMBERS.demo });
    expect(page.body).toContain(`window.open("/cu/ib/members/results?number=${MEMBERS.demo}`);
    scriptsParse(page.body);
    const popup = await c.get(`members/results?number=${MEMBERS.demo}&next=`);
    expect(popup.body).toContain('window.opener.location.href');
    scriptsParse(popup.body);
    expect((await b.client().get(`members/results?number=${MEMBERS.demo}`)).status).toBe(401);
  });
});

describe('the summary', () => {
  it('false-notice: says bill pay is unavailable on a summary that works', async () => {
    expect((await c.get(`members/${MEMBERS.demo}`)).body).toContain(
      'Bill pay is temporarily unavailable.',
    );
    expect(
      JSON.parse((await c.get(`api/members/${MEMBERS.demo}/accounts`)).body).accounts.length,
    ).toBeGreaterThan(1);
  });

  it('shuffled-tiles: draws the tiles in a different order from load to load', async () => {
    const orders = new Set<string>();
    for (let i = 0; i < 20; i++)
      orders.add(
        JSON.parse((await c.get(`api/members/${MEMBERS.demo}/accounts`)).body)
          .accounts.map((a: { id: number }) => a.id)
          .join(','),
      );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('the transfer, split over pages', () => {
  it('asks the amount, then the accounts, then Authorize, and a supervisor above $2,000', async () => {
    const form = (await c.get(`members/${MEMBERS.demo}/transfer`)).body;
    expect(form).toContain('Amount');
    expect(form).not.toContain('Loading accounts');
    expect(
      (await c.post(`members/${MEMBERS.demo}/transfer`, { amount: '250', memo: 'PF1' })).location,
    ).toBe(`/cu/ib/members/${MEMBERS.demo}/transfer/accounts`);
    const accounts = (await c.get(`members/${MEMBERS.demo}/transfer/accounts`)).body;
    expect(accounts).toContain('Loading accounts');
    scriptsParse(accounts);
    const [from, to] = await accountsOf(b.db, MEMBERS.demo);
    expect(
      (
        await c.post(`members/${MEMBERS.demo}/transfer/accounts`, {
          from: String(from!.id),
          to: String(to!.id),
        })
      ).location,
    ).toBe(`/cu/ib/members/${MEMBERS.demo}/transfer/review`);
    const review = (await c.get(`members/${MEMBERS.demo}/transfer/review`)).body;
    expect(review).toMatch(/Authorize/);
    expect((await c.post(`members/${MEMBERS.demo}/transfer/submit`, {})).body).toMatch(
      /Confirmation number PFCU-\d{5}-[A-Z]\./,
    );
    await c.post(`members/${MEMBERS.demo}/transfer`, { amount: '2000.01', memo: 'PF2' });
    await c.post(`members/${MEMBERS.demo}/transfer/accounts`, {
      from: String(from!.id),
      to: String(to!.id),
    });
    expect((await c.post(`members/${MEMBERS.demo}/transfer/submit`, {})).body).toContain(
      'Supervisor approval required',
    );
    await c.get(`members/${MEMBERS.demo}/transfer/cancel`);
  });

  it('refuses a bad amount on page one, before any accounts', async () => {
    expect(
      (await c.post(`members/${MEMBERS.demo}/transfer`, { amount: '0', memo: 'X' })).body,
    ).toContain('Enter an amount between $0.01 and $25,000.00.');
  });
});

describe('statements', () => {
  it('html-statement-viewer and window-token: the viewer replaces the main frame, and only its Download link gets the PDF', async () => {
    const a = (await accountsOf(b.db, MEMBERS.demo))[0]!;
    const rows = JSON.parse(
      (await c.get(`api/members/${MEMBERS.demo}/accounts/${a.id}/statements`)).body,
    ).rows;
    expect(rows[0].url).toBe(
      `/cu/ib/members/${MEMBERS.demo}/statements/view?account=${a.id}&month=2026-05`,
    );
    const page = (await c.get(`members/${MEMBERS.demo}/statements?account=${a.id}`)).body;
    expect(page).toContain("location.href = \\'");
    scriptsParse(page);
    const viewer = (await c.get(rows[0].url)).body;
    expect(viewer).toContain('Opening balance');
    const download = /HREF="([^"]*statement\?[^"]*wt=[^"]+)"/
      .exec(viewer)![1]!
      .replace(/&amp;/g, '&');
    const pdf = await c.raw(download);
    expect(pdf.type).toBe('application/pdf');
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBeGreaterThan(0);
    expect((await c.raw(download.replace(/&wt=[^&]+/, ''))).status).toBe(403);
    const other = await signIn(b);
    expect((await other.raw(download)).status).toBe(403);
  });
});
