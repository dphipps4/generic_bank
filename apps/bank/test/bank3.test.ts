import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsOf } from '../src/ledger.js';
import { fieldName } from '../src/markup/dialect.js';
import { MEMBERS, OPERATORS } from '../src/seed.js';
import { type Client, lastCodeFor, PASSWORDS, signIn, type TestBank, testBank } from './harness.js';

// Sample Savings Bank: lookup by name, terms after sign-in, a $500 supervisor threshold, and six
// kinds of trouble that banks 1 and 2 never show.

let b: TestBank;
let c: Client;
beforeAll(async () => {
  b = await testBank('sample');
  c = await signIn(b);
  await c.post('terms', {});
});
afterAll(() => b.close());

const scriptsParse = (html: string) => {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/gi))
    expect(() => new Function(m[1]!)).not.toThrow();
};
const ids = async (member: string) => {
  const [from, to] = await accountsOf(b.db, member);
  return { from: String(from!.id), to: String(to!.id) };
};

describe('Sample Savings Bank', () => {
  it('asks staff to acknowledge updated terms after every sign-in', async () => {
    const d = b.client();
    await d.get('signin');
    await d.post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service });
    await d.get('code');
    await d.post('code', {});
    const r = await d.post('code/enter', { code: await lastCodeFor(b.db, OPERATORS.service.id) });
    const handoff = new URL(r.location, 'http://x').searchParams.get('code')!;
    expect((await d.get(`auth/complete?code=${encodeURIComponent(handoff)}`)).location).toBe(
      '/online/branch/terms',
    );
    expect((await d.get('terms')).body).toContain('Acknowledge');
    expect((await d.post('terms', {})).location).toBe('/online/branch/console');
  });

  it('finds members by number or by last name', async () => {
    expect((await c.get('members/search')).body).toMatch(/Member number or last name|or last name/);
    const byName = JSON.parse((await c.get('api/members?number=sample')).body);
    expect(byName.members.map((m: { number: string }) => m.number)).toContain(MEMBERS.demo);
    expect(JSON.parse((await c.get('api/members?number=Nobody')).body).error).toBe(
      'No member found with that name.',
    );
    expect(JSON.parse((await c.get('api/members?number=1')).body).error).toBe(
      'Enter a member number or a last name.',
    );
  });

  it('asks a supervisor above $500', async () => {
    await c.post(`members/${MEMBERS.demo}/transfer`, {
      ...(await ids(MEMBERS.demo)),
      amount: '500.01',
      memo: 'SSB1',
    });
    expect((await c.post(`members/${MEMBERS.demo}/transfer/submit`, {})).body).toContain(
      'Supervisor approval required',
    );
    await c.get(`members/${MEMBERS.demo}/transfer/cancel`);
  });
});

describe('Bank 3’s trouble', () => {
  it('hidden-duplicate: a hidden copy of the password field and button, earlier in the page, that sends nothing', async () => {
    const d = b.client();
    const page = (await d.get('signin')).body;
    const hidden = page.indexOf('display:none');
    expect(hidden).toBeGreaterThan(-1);
    expect(hidden).toBeLessThan(page.search(/TYPE="password"[^>]*>(?![\s\S]*display:none)/i));
    expect(page.match(/TYPE="password"/gi)).toHaveLength(2);
    const r = await d.post('signin', {
      operator: OPERATORS.service.id,
      'password-shadow': PASSWORDS.service,
    });
    expect(r.body).toContain('do not match');
  });

  it('keypress-only: an amount set without typing is never sent', async () => {
    const page = (await c.get(`members/${MEMBERS.demo}/transfer`)).body;
    expect(page).toContain('shown.onkeydown');
    expect(page).toContain(`NAME="${fieldName(c.cookies.get('CLFORM')!, 'amount')}"`);
    scriptsParse(page);
    const lost = await c.post(`members/${MEMBERS.demo}/transfer`, {
      ...(await ids(MEMBERS.demo)),
      'amount-typed': '25.00',
      memo: 'KEYS',
    });
    expect(lost.body).toContain('Enter an amount between $0.01 and $25,000.00.');
    const typed = await c.post(`members/${MEMBERS.demo}/transfer`, {
      ...(await ids(MEMBERS.demo)),
      amount: '25.00',
      memo: 'KEYS',
    });
    expect(typed.location).toMatch(/\/review$/);
  });

  it('covering-bar: a notice bar is drawn over the submit control on the form and on the review page', async () => {
    const review = (await c.get(`members/${MEMBERS.demo}/transfer/review`)).body;
    for (const page of [review, (await c.get(`members/${MEMBERS.demo}/transfer`)).body]) {
      expect(page).toContain('the wire cut-off today is 3:00 PM');
      expect(page).toContain("position:fixed;left:0;right:0;top:' + (r.top - 8)");
      scriptsParse(page);
    }
  });

  it('documents-among-statements: a privacy notice and a tax form sit between the statements, and open', async () => {
    const a = (await accountsOf(b.db, MEMBERS.demo))[0]!;
    const rows = JSON.parse(
      (await c.get(`api/members/${MEMBERS.demo}/accounts/${a.id}/statements`)).body,
    ).rows;
    expect(rows).toHaveLength(14);
    const docs = rows.filter((r: { type: string }) => r.type !== 'Statement');
    expect(docs.map((r: { type: string }) => r.type).sort()).toEqual([
      'Privacy Notice',
      'Tax Form 1099-INT',
    ]);
    expect(docs.every((r: { balance: null }) => r.balance === null)).toBe(true);
    const i = rows.findIndex((r: { type: string }) => r.type === 'Privacy Notice');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(rows.length - 1);
    const pdf = await c.raw(docs[0].url);
    expect(pdf.type).toBe('application/pdf');
    expect((await PDFDocument.load(pdf.bytes)).getTitle()).toMatch(/^Sample Savings Bank /);
  });

  it('view-more and detached-menu: twelve rows, then "View more statements"; Options menus drawn at the end of the page', async () => {
    const a = (await accountsOf(b.db, MEMBERS.demo))[0]!;
    const page = (await c.get(`members/${MEMBERS.demo}/statements?account=${a.id}`)).body;
    expect(page).toContain('CL_render(12)');
    expect(page).toContain('View more statements');
    expect(page).toContain('Options &#9662;');
    expect(page).toContain('document.body.appendChild(m)');
    scriptsParse(page);
  });
});
