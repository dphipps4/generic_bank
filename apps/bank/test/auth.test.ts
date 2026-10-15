import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkCode,
  checkPassword,
  createSession,
  IDLE_MS,
  loadSession,
  maskEmail,
  maskPhone,
  operatorById,
  sendCode,
  setSession,
  touch,
  trustedOperator,
  trustWorkstation,
} from '../src/auth.js';
import { connectInProcess, type Db, migrate } from '../src/db.js';
import { OPERATORS, seed } from '../src/seed.js';
import { TENANTS } from '../src/tenants.js';

const T0 = new Date('2026-06-15T15:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const PW = 'service-password-for-tests';
let db: Db;

beforeAll(async () => {
  db = await connectInProcess();
  await migrate(db);
  await seed(
    db,
    TENANTS.generic,
    { servicePassword: PW, supervisorPassword: 'supervisor-password-for-tests' },
    T0,
  );
}, 60_000);
afterAll(() => db.close());

const lastCode = async (address: string) => {
  const r = await db.query<{ body: string }>(
    'SELECT body FROM messages WHERE address = $1 ORDER BY id DESC LIMIT 1',
    [address],
  );
  return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
};

describe('password sign-in', () => {
  it('accepts the right password and refuses a wrong one, in the bank’s words', async () => {
    expect((await checkPassword(db, OPERATORS.service.id, PW, T0)).ok).toBe(true);
    expect(await checkPassword(db, OPERATORS.service.id, 'wrong', T0)).toEqual({
      ok: false,
      reason: 'bad-credentials',
    });
    expect(await checkPassword(db, '9999', PW, T0)).toEqual({
      ok: false,
      reason: 'bad-credentials',
    });
  });

  it('refuses a locked operator even with the right password', async () => {
    expect(await checkPassword(db, OPERATORS.locked.id, PW, T0)).toEqual({
      ok: false,
      reason: 'locked',
    });
  });

  it('locks an Operator ID after five failures in fifteen minutes, for thirty minutes', async () => {
    const id = OPERATORS.supervisor.id;
    for (let i = 0; i < 4; i++)
      expect((await checkPassword(db, id, 'nope', at(i * 1000))).ok).toBe(false);
    expect(await checkPassword(db, id, 'nope', at(5000))).toEqual({ ok: false, reason: 'locked' });
    expect(await checkPassword(db, id, 'supervisor-password-for-tests', at(29 * 60_000))).toEqual({
      ok: false,
      reason: 'locked',
    });
    expect((await checkPassword(db, id, 'supervisor-password-for-tests', at(31 * 60_000))).ok).toBe(
      true,
    );
  });
});

describe('codes', () => {
  it('arrive in the operator’s inbox and work once', async () => {
    const o = (await operatorById(db, OPERATORS.service.id))!;
    await sendCode(db, o, 'sign-in', 'text', 'Generic Bank', T0);
    const code = await lastCode(o.phone);
    expect(await checkCode(db, o.pk, 'sign-in', code, at(1000))).toBe('ok');
    expect(await checkCode(db, o.pk, 'sign-in', code, at(2000))).toBe('expired');
  });

  it('say "not correct" for a wrong code, and expire after three tries', async () => {
    const o = (await operatorById(db, OPERATORS.service.id))!;
    await sendCode(db, o, 'sign-in', 'email', 'Generic Bank', T0);
    const code = await lastCode(o.email);
    for (let i = 0; i < 3; i++)
      expect(
        await checkCode(db, o.pk, 'sign-in', '000000' === code ? '111111' : '000000', T0),
      ).toBe('wrong');
    expect(await checkCode(db, o.pk, 'sign-in', code, T0)).toBe('expired');
  });

  it('expire after five minutes', async () => {
    const o = (await operatorById(db, OPERATORS.service.id))!;
    await sendCode(db, o, 'sign-in', 'text', 'Generic Bank', T0);
    expect(await checkCode(db, o.pk, 'sign-in', await lastCode(o.phone), at(5 * 60_000 + 1))).toBe(
      'expired',
    );
  });

  it('bind an approval code to the transfer it was sent for', async () => {
    const sup = (await operatorById(db, OPERATORS.supervisor.id))!;
    await sendCode(db, sup, 'approval', 'text', 'Generic Bank', T0, 'REF-1');
    const code = await lastCode(sup.phone);
    expect(await checkCode(db, sup.pk, 'approval', code, T0, 'REF-2')).toBe('expired');
  });

  it('say where a code went without saying all of it', () => {
    expect(maskPhone('+1 555 010412')).toBe('(***) ***-0412');
    expect(maskEmail('op0412@generic.bank.localhost')).toBe('o***@generic.bank.localhost');
  });
});

describe('sessions', () => {
  it('end after ten idle minutes', async () => {
    const o = (await operatorById(db, OPERATORS.service.id))!;
    const t = await createSession(db, o.pk, 'active', T0);
    expect(await touch(db, (await loadSession(db, t))!, at(IDLE_MS - 1000))).toBe(true);
    expect(await touch(db, (await loadSession(db, t))!, at(2 * IDLE_MS))).toBe(false);
    expect((await loadSession(db, t))!.state).toBe('ended');
  });

  it('end early when the early-expiry hazard set a time', async () => {
    const o = (await operatorById(db, OPERATORS.service.id))!;
    const t = await createSession(db, o.pk, 'active', T0);
    await setSession(db, t, { expires_early_at: at(60_000) });
    expect(await touch(db, (await loadSession(db, t))!, at(61_000))).toBe(false);
  });

  it('keep a pending transfer as JSON', async () => {
    const t = await createSession(db, 1, 'active', T0);
    await setSession(db, t, { pending: { amountCents: 500, memo: 'GB1' } });
    expect((await loadSession(db, t))!.pending).toEqual({ amountCents: 500, memo: 'GB1' });
    expect(await loadSession(db, 'no-such-token')).toBeNull();
  });
});

describe('trusted workstations', () => {
  it('remember the operator for thirty days, then forget', async () => {
    const o = (await operatorById(db, OPERATORS.service.id))!;
    const t = await trustWorkstation(db, o.pk, T0);
    expect((await trustedOperator(db, t, at(29 * 86_400_000)))?.operatorId).toBe(
      OPERATORS.service.id,
    );
    expect(await trustedOperator(db, t, at(31 * 86_400_000))).toBeNull();
  });
});
