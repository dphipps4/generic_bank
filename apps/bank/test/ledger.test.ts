import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectInProcess, type Db, migrate } from '../src/db.js';
import {
  accountsOf,
  checkTransfer,
  findMember,
  maskedName,
  parseDollars,
  postTransfer,
  REFUSAL_TEXT,
} from '../src/ledger.js';
import { MEMBERS, OPERATORS, seed } from '../src/seed.js';
import { TENANTS } from '../src/tenants.js';

const NOW = new Date('2026-06-15T15:00:00Z');
const SECRETS = {
  servicePassword: 'service-password-for-tests',
  supervisorPassword: 'supervisor-password-for-tests',
};
let db: Db;
let servicePk: number;

const accountOfType = async (member: string, type: string) => {
  const a = (await accountsOf(db, member)).find((x) => x.type === type);
  if (!a) throw new Error(`no ${type} for ${member}`);
  return a;
};

beforeAll(async () => {
  db = await connectInProcess();
  await migrate(db);
  await seed(db, TENANTS.generic, SECRETS, NOW);
  const r = await db.query<{ pk: number }>('SELECT pk FROM operators WHERE operator_id = $1', [
    OPERATORS.service.id,
  ]);
  servicePk = r.rows[0]!.pk;
}, 60_000);
afterAll(() => db.close());

describe('the ledger', () => {
  it('names a member only as an initial and a surname', async () => {
    expect(maskedName((await findMember(db, MEMBERS.demo))!)).toBe('A. Sample');
    expect(await findMember(db, MEMBERS.missing)).toBeNull();
  });

  it('always balances to zero', async () => {
    const r = await db.query<{ total: number; bad: number }>(
      `SELECT (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM ledger_entries) AS total,
              (SELECT count(*)::int FROM (SELECT txn FROM ledger_entries GROUP BY txn HAVING SUM(amount_cents) <> 0) x) AS bad`,
    );
    expect(r.rows[0]).toEqual({ total: 0, bad: 0 });
  });

  it('shows holds in available but not in current', async () => {
    const c = await accountOfType(MEMBERS.demo, 'checking');
    expect(c.availableCents).toBeLessThan(c.currentCents);
  });

  it('parses money the way an operator types it', () => {
    expect(parseDollars('$1,234.50')).toBe(123_450);
    expect(parseDollars('12')).toBe(1200);
    expect(parseDollars('1.234')).toBeNull();
    expect(parseDollars('-5')).toBeNull();
  });
});

describe('transfer checks, in the bank’s own words', () => {
  const ask = async (member: string, fromType: string, toType: string, amountCents: number) => {
    const from = await accountOfType(member, fromType);
    const to = await accountOfType(member, toType);
    return checkTransfer(
      db,
      {
        memberNumber: member,
        fromId: from.id,
        toId: to.id,
        amountCents,
        memo: 'TEST',
        operatorPk: servicePk,
      },
      NOW,
    );
  };

  it('allows an ordinary transfer', async () => {
    expect(await ask(MEMBERS.demo, 'checking', 'savings', 20_000)).toBeNull();
  });
  it('refuses an amount outside $0.01 to $25,000.00', async () => {
    expect(await ask(MEMBERS.demo, 'checking', 'savings', 0)).toBe('validation');
    expect(await ask(MEMBERS.demo, 'checking', 'savings', 2_500_001)).toBe('validation');
  });
  it('refuses more than the available balance', async () => {
    expect(await ask(MEMBERS.nearZero, 'checking', 'savings', 500)).toBe('insufficient-funds');
  });
  it('refuses transfers out of an IRA or a CD', async () => {
    expect(await ask(MEMBERS.ira, 'ira', 'checking', 10_000)).toBe('not-permitted');
    expect(await ask(MEMBERS.cd, 'cd', 'checking', 10_000)).toBe('not-permitted');
  });
  it('refuses a restricted account', async () => {
    expect(await ask(MEMBERS.restricted, 'checking', 'savings', 10_000)).toBe('restricted');
  });
  it('refuses past the operator’s daily limit', async () => {
    expect(await ask(MEMBERS.wealthy, 'savings', 'checking', 1_000_001)).toBe('daily-limit');
  });
  it('has a message for every refusal', () => {
    expect(REFUSAL_TEXT['insufficient-funds']).toBe(
      'The amount is more than the available balance.',
    );
  });
});

describe('posting a transfer', () => {
  it('moves the money, keeps the ledger balanced and records a state change', async () => {
    const from = await accountOfType(MEMBERS.demo, 'checking');
    const to = await accountOfType(MEMBERS.demo, 'savings');
    const conf = await postTransfer(
      db,
      {
        memberNumber: MEMBERS.demo,
        fromId: from.id,
        toId: to.id,
        amountCents: 12_345,
        memo: 'GB7K2',
        operatorPk: servicePk,
        approvedBy: null,
        prefix: 'GB',
      },
      NOW,
    );
    expect(conf).toMatch(/^GB-\d{5}-[A-Z]$/);
    expect((await accountOfType(MEMBERS.demo, 'checking')).currentCents).toBe(
      from.currentCents - 12_345,
    );
    expect((await accountOfType(MEMBERS.demo, 'savings')).currentCents).toBe(
      to.currentCents + 12_345,
    );
    const sc = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM state_changes WHERE kind = 'transfer'`,
    );
    expect(sc.rows[0]!.n).toBe(1);
  });

  it('counts posted transfers toward the daily limit', async () => {
    const from = await accountOfType(MEMBERS.wealthy, 'savings');
    const to = await accountOfType(MEMBERS.wealthy, 'checking');
    const q = {
      memberNumber: MEMBERS.wealthy,
      fromId: from.id,
      toId: to.id,
      memo: 'LIMIT',
      operatorPk: servicePk,
    };
    expect(await checkTransfer(db, { ...q, amountCents: 980_000 }, NOW)).toBeNull();
    await postTransfer(db, { ...q, amountCents: 980_000, approvedBy: null, prefix: 'GB' }, NOW);
    expect(await checkTransfer(db, { ...q, amountCents: 100_000 }, NOW)).toBe('daily-limit');
  });
});
