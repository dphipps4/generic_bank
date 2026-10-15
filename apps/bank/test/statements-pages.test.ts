import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS } from '../src/seed.js';
import { type Client, signIn, type TestBank, testBank } from './harness.js';

let b: TestBank;
let c: Client;
beforeAll(async () => {
  b = await testBank();
  c = await signIn(b);
});
afterAll(() => b.close());

describe('the statements page', () => {
  it('has an account picker, an eStatements decoy, and rows only by script', async () => {
    const r = await c.get(`members/${MEMBERS.demo}/statements`);
    expect(r.body).toContain('Everyday Checking, Account ending in');
    expect(r.body).toContain('Enroll in eStatements');
    // The months it does not list, in its own words.
    expect(r.body).toContain('Only the last 12 months of statements are available online.');
    expect(r.body).not.toContain('2026-05-31');
    expect(r.body).toContain('window.open(');
    for (const m of r.body.matchAll(/<script>([\s\S]*?)<\/script>/gi))
      expect(() => new Function(m[1]!)).not.toThrow();
  });

  it('switches account through the picker', async () => {
    const [, savings] = await accountsOf(b.db, MEMBERS.demo);
    const r = await c.post(`members/${MEMBERS.demo}/statements`, { account: String(savings!.id) });
    expect(r.location).toBe(`/corelink/members/${MEMBERS.demo}/statements?account=${savings!.id}`);
  });

  it('lists twelve statements, each with the URL its button opens, and that URL is a PDF', async () => {
    const a = (await accountsOf(b.db, MEMBERS.demo))[0]!;
    const rows = JSON.parse(
      (await c.get(`api/members/${MEMBERS.demo}/accounts/${a.id}/statements`)).body,
    ).rows;
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ month: '2026-05', date: '2026-05-31', type: 'Statement' });
    const pdf = await b.app.inject({
      method: 'GET',
      url: rows[0].url,
      headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await PDFDocument.load(pdf.rawPayload)).getTitle()).toBe(
      'Generic Bank statement 2026-05',
    );
  });

  it('refuses the PDF to anyone signed out, and for another member’s account', async () => {
    const a = (await accountsOf(b.db, MEMBERS.demo))[0]!;
    expect(
      (await b.client().get(`statement?member=${MEMBERS.demo}&account=${a.id}&month=2026-05`))
        .status,
    ).toBe(401);
    expect(
      (await c.get(`statement?member=${MEMBERS.ira}&account=${a.id}&month=2026-05`)).status,
    ).toBe(404);
  });

  it('delays the rows three seconds when late rows are forced', async () => {
    c.hazards = ['late-rows'];
    expect((await c.get(`members/${MEMBERS.demo}/statements`)).body).toMatch(/\}, 3000\);/);
    c.hazards = null;
  });
});
