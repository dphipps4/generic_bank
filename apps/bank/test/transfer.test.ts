import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS, OPERATORS } from '../src/seed.js';
import { prefixOf } from '../src/routes/transfer.js';
import { type Client, lastCode, phoneOf, signIn, type TestBank, testBank } from './harness.js';

let b: TestBank;
let c: Client;
beforeAll(async () => {
  b = await testBank();
  c = await signIn(b);
});
afterAll(() => b.close());

const ids = async (member: string, from: string, to: string) => {
  const a = await accountsOf(b.db, member);
  return {
    from: String(a.find((x) => x.type === from)!.id),
    to: String(a.find((x) => x.type === to)!.id),
  };
};
const transfers = async () =>
  (await b.db.query<{ n: number }>('SELECT count(*)::int AS n FROM transfers')).rows[0]!.n;

describe('the transfer form', () => {
  it('draws its account options only by script', async () => {
    const r = await c.get(`members/${MEMBERS.demo}/transfer`);
    expect(r.body).toContain('Loading accounts');
    expect(r.body).not.toMatch(/Account ending in \d{4}/);
    for (const m of r.body.matchAll(/<script>([\s\S]*?)<\/script>/gi))
      expect(() => new Function(m[1]!)).not.toThrow();
  });

  it('refuses in the bank’s own words', async () => {
    const say = async (member: string, from: string, to: string, amount: string, memo = 'T1') =>
      (
        await c.post(`members/${member}/transfer`, {
          ...(await ids(member, from, to)),
          amount,
          memo,
        })
      ).body;
    expect(await say(MEMBERS.nearZero, 'checking', 'savings', '50.00')).toContain(
      'The amount is more than the available balance.',
    );
    expect(await say(MEMBERS.ira, 'ira', 'checking', '10')).toContain(
      'Transfers from this account type are not permitted.',
    );
    expect(await say(MEMBERS.restricted, 'checking', 'savings', '10')).toContain(
      'This account is restricted. Refer the member to a branch.',
    );
    expect(await say(MEMBERS.demo, 'checking', 'savings', '25000.01')).toContain(
      'Enter an amount between $0.01 and $25,000.00.',
    );
    expect(await say(MEMBERS.demo, 'checking', 'savings', 'ten dollars')).toContain(
      'Enter an amount between $0.01 and $25,000.00.',
    );
    expect(await say(MEMBERS.demo, 'checking', 'savings', '10', 'pay <script>')).toContain(
      'The memo may have up to 32',
    );
    expect(await say(MEMBERS.wealthy, 'savings', 'checking', '10001')).toContain(
      'Your operator role cannot transfer more than $10,000 per day.',
    );
    c.hazards = ['validation-error'];
    expect(await say(MEMBERS.demo, 'checking', 'savings', '10')).toContain(
      'Enter an amount between $0.01 and $25,000.00.',
    );
    c.hazards = null;
    expect(await transfers()).toBe(0);
  });
});

describe('a transfer under the threshold', () => {
  it('goes form, review, submit, and posts once with a confirmation number', async () => {
    const before = await accountsOf(b.db, MEMBERS.demo);
    const r = await c.post(`members/${MEMBERS.demo}/transfer`, {
      ...(await ids(MEMBERS.demo, 'checking', 'savings')),
      amount: '$200.00',
      memo: 'GB7K2Q',
    });
    expect(r.location).toBe(`/corelink/members/${MEMBERS.demo}/transfer/review`);
    const review = await c.get(r.location);
    for (const s of ['Review transfer', '$200.00', 'GB7K2Q', 'Submit transfer', 'Edit', 'Cancel'])
      expect(review.body).toContain(s);
    const done = await c.post(`members/${MEMBERS.demo}/transfer/submit`, {});
    expect(done.body).toMatch(/Transfer posted\. Confirmation number GB-\d{5}-[A-Z]\./);
    const after = await accountsOf(b.db, MEMBERS.demo);
    expect(after[0]!.currentCents).toBe(before[0]!.currentCents - 20_000);
    expect(after[1]!.currentCents).toBe(before[1]!.currentCents + 20_000);
    expect((await c.post(`members/${MEMBERS.demo}/transfer/submit`, {})).body).toContain(
      'There is no transfer to submit.',
    );
    expect(await transfers()).toBe(1);
  });

  it('keeps the values on Edit, and forgets them on Cancel', async () => {
    await c.post(`members/${MEMBERS.demo}/transfer`, {
      ...(await ids(MEMBERS.demo, 'checking', 'savings')),
      amount: '12.34',
      memo: 'EDITME',
    });
    const edit = await c.get(`members/${MEMBERS.demo}/transfer?edit=1`);
    expect(edit.body).toContain('VALUE="12.34"');
    expect(edit.body).toContain('VALUE="EDITME"');
    expect((await c.get(`members/${MEMBERS.demo}/transfer/cancel`)).location).toBe(
      `/corelink/members/${MEMBERS.demo}`,
    );
    expect((await c.get(`members/${MEMBERS.demo}/transfer/review`)).body).toContain(
      'There is no transfer to review.',
    );
  });
});

describe('a transfer over the threshold', () => {
  it('needs a supervisor’s approval code, sent to the supervisor, bound to this transfer', async () => {
    const n = await transfers();
    await c.post(`members/${MEMBERS.wealthy}/transfer`, {
      ...(await ids(MEMBERS.wealthy, 'savings', 'checking')),
      amount: '3000',
      memo: 'BIG1',
    });
    const page = await c.post(`members/${MEMBERS.wealthy}/transfer/submit`, {});
    expect(page.body).toContain('Supervisor approval required');
    expect(await transfers()).toBe(n);
    const code = await lastCode(b.db, await phoneOf(b.db, OPERATORS.supervisor.id));
    expect(code).toMatch(/^\d{6}$/);
    const approve = (supervisor: string, k: string) =>
      c.post(`members/${MEMBERS.wealthy}/transfer/approve`, { supervisor, code: k });
    expect((await approve(OPERATORS.service.id, code)).body).toContain(
      'That ID is not a supervisor.',
    );
    expect(
      (await approve(OPERATORS.supervisor.id, code === '000000' ? '111111' : '000000')).body,
    ).toContain('The approval code is not correct.');
    expect((await approve(OPERATORS.supervisor.id, code)).body).toMatch(
      /Transfer posted\. Confirmation number/,
    );
    const t = await b.db.query<{ approved_by: number | null }>(
      `SELECT approved_by FROM transfers WHERE memo = 'BIG1'`,
    );
    expect(t.rows[0]!.approved_by).not.toBeNull();
    expect((await c.post(`members/${MEMBERS.wealthy}/transfer/submit`, {})).body).toContain(
      'There is no transfer to submit.',
    );
  });
});

describe('the swallowed submit', () => {
  it('commits the transfer and loses the answer: a spinner or a gateway error, and the memo is in the history', async () => {
    const n = await transfers();
    await c.post(`members/${MEMBERS.demo}/transfer`, {
      ...(await ids(MEMBERS.demo, 'savings', 'checking')),
      amount: '5',
      memo: 'LOST1',
    });
    c.hazards = ['swallowed-submit'];
    const r = await c.post(`members/${MEMBERS.demo}/transfer/submit`, {});
    c.hazards = null;
    expect(r.body).not.toContain('Transfer posted');
    expect(r.status === 502 ? r.body : 'Processing').toMatch(/Bad Gateway|Processing/);
    expect(await transfers()).toBe(n + 1);
    const e = await b.db.query<{ description: string }>(
      `SELECT description FROM ledger_entries WHERE description LIKE '%LOST1%'`,
    );
    expect(e.rows.map((x) => x.description).sort()).toEqual([
      'TRANSFER IN LOST1',
      'TRANSFER OUT LOST1',
    ]);
  });
});

describe('confirmation prefixes', () => {
  it('are the brand’s initials', () => {
    expect(prefixOf('Generic Bank')).toBe('GB');
    expect(prefixOf('Example Credit Union')).toBe('ECU');
  });
});
