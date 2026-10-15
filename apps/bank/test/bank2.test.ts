import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS, OPERATORS } from '../src/seed.js';
import { lastCodeFor, PASSWORDS, type TestBank, testBank } from './harness.js';

// Example Credit Union, end to end through its own pages: a bare-port URL, email-only codes,
// Find Member, Move Money, the Confirm image, and a supervisor above $1,000.

let b: TestBank;
beforeAll(async () => {
  b = await testBank('example');
});
afterAll(() => b.close());

describe('Example Credit Union, as an operator meets it', () => {
  it('lives at the root of its own port, with its own words', async () => {
    const c = b.client();
    expect((await c.get('/')).body).toContain('location.replace("/signin")');
    expect((await c.get('/signin')).body).toContain('Log In');
  });

  it('sends the code by email without asking, then signs in', async () => {
    const c = b.client();
    await c.get('/signin');
    expect(
      (await c.post('/signin', { operator: OPERATORS.service.id, password: PASSWORDS.service }))
        .location,
    ).toBe('/code');
    const chooser = await c.get('/code');
    expect(chooser.location).toBe('/code/enter');
    const sent = await b.db.query<{ mailbox: string }>(
      'SELECT mailbox FROM messages ORDER BY id DESC LIMIT 1',
    );
    expect(sent.rows[0]!.mailbox).toBe('email');
    const r = await c.post('/code/enter', { code: await lastCodeFor(b.db, OPERATORS.service.id) });
    const handoff = new URL(r.location, 'http://x').searchParams.get('code')!;
    expect((await c.get(`/auth/complete?code=${encodeURIComponent(handoff)}`)).location).toBe(
      '/console',
    );
    expect((await c.get('/console')).body).toContain('frame/tabs');

    // Find Member, then Move Money.
    const found = JSON.parse(
      (await c.get(`/api/members?number=${MEMBERS.demo}&next=transfer`)).body,
    );
    expect(found.open).toBe(`/members/${MEMBERS.demo}/transfer`);
    const tiles = JSON.parse((await c.get(`/api/members/${MEMBERS.demo}/accounts`)).body).accounts;
    expect(tiles[0].wording).toMatch(/^Share \*\*\*\*\d{4}-S01$/);
    expect((await c.get(found.open)).body).toContain('Move Money');

    // Under $1,000: posts on Confirm with an ECU confirmation number.
    const [from, to] = await accountsOf(b.db, MEMBERS.demo);
    const ids = { from: String(from!.id), to: String(to!.id) };
    await c.post(`/members/${MEMBERS.demo}/transfer`, { ...ids, amount: '900', memo: 'ECU1' });
    expect((await c.post(`/members/${MEMBERS.demo}/transfer/submit`, {})).body).toMatch(
      /Confirmation number ECU-\d{5}-[A-Z]\./,
    );

    // Over $1,000: the supervisor's code.
    await c.post(`/members/${MEMBERS.demo}/transfer`, { ...ids, amount: '1000.01', memo: 'ECU2' });
    expect((await c.post(`/members/${MEMBERS.demo}/transfer/submit`, {})).body).toContain(
      'Supervisor approval required',
    );
    const code = await lastCodeFor(b.db, OPERATORS.supervisor.id);
    expect(
      (
        await c.post(`/members/${MEMBERS.demo}/transfer/approve`, {
          supervisor: OPERATORS.supervisor.id,
          code,
        })
      ).body,
    ).toMatch(/Transfer posted\. Confirmation number ECU-/);
  });
});
