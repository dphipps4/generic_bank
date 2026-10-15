import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAdmin } from '../src/admin.js';
import { hazards } from '../src/hazards.js';
import { buildInbox } from '../src/inbox.js';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS } from '../src/seed.js';
import { TENANTS } from '../src/tenants.js';
import { signIn, type TestBank, testBank } from './harness.js';

const TOKEN = 'a'.repeat(40);
let b: TestBank;
beforeAll(async () => {
  b = await testBank();
});
afterAll(() => b.close());

const adminOf = () =>
  buildAdmin(
    {
      t: TENANTS.generic,
      db: b.db,
      now: () => b.clock.now,
      uiVersion: 1,
      hazards: hazards({
        profile: 'none',
        seed: 1,
        forceable: false,
        hmacKey: '',
        log: () => undefined,
      }),
    },
    TOKEN,
  );

describe('the bank-admin API', () => {
  it('answers only to the bank-admin token, and refuses a short one at start', async () => {
    const admin = await adminOf();
    expect((await admin.inject({ url: '/state' })).statusCode).toBe(401);
    expect(
      (
        await admin.inject({
          url: '/state',
          headers: { authorization: `Bearer ${'b'.repeat(40)}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await admin.inject({ url: '/healthz' })).statusCode).toBe(200);
    await expect(buildAdmin({} as never, 'short')).rejects.toThrow('at least 32');
  });

  it('reports the ledger’s truth, not the page’s: transfers, state changes and balances', async () => {
    const admin = await adminOf();
    const get = async (url: string) =>
      JSON.parse((await admin.inject({ url, headers: { authorization: `Bearer ${TOKEN}` } })).body);
    expect((await get('/state')).stateChanges).toBe(0);
    const c = await signIn(b);
    const [from, to] = await accountsOf(b.db, MEMBERS.demo);
    await c.post(`members/${MEMBERS.demo}/transfer`, {
      from: String(from!.id),
      to: String(to!.id),
      amount: '7.00',
      memo: 'TRUTH1',
    });
    await c.post(`members/${MEMBERS.demo}/transfer/submit`, {});
    const state = await get('/state');
    expect(state.byKind).toEqual({ transfer: 1 });
    expect(state.transfers[0]).toMatchObject({
      member: MEMBERS.demo,
      amountCents: 700,
      memo: 'TRUTH1',
      approved: false,
    });
    const balances = await get(`/members/${MEMBERS.demo}/balances`);
    expect(balances[0].currentCents).toBe(from!.currentCents - 700);
    expect((await get('/messages')).length).toBeGreaterThan(0);
  });
});

describe('the inbox', () => {
  it('shows each bank’s texts and emails, newest first', async () => {
    await signIn(b);
    const inbox = await buildInbox([{ t: TENANTS.generic, db: b.db }]);
    const r = await inbox.inject({ url: '/' });
    expect(r.body).toContain('Generic Bank');
    expect(r.body).toMatch(/your CoreLink sign-in code is \d{6}/);
    expect(r.body).toContain('http-equiv="refresh"');
    expect(JSON.parse((await inbox.inject({ url: '/healthz' })).body).banks).toEqual(['generic']);
  });
});
