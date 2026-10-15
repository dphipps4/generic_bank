import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectInProcess, type Db, migrate } from '../src/db.js';
import { MEMBERS, OPERATORS, seed } from '../src/seed.js';
import { TENANTS } from '../src/tenants.js';

const NOW = new Date('2026-06-15T15:00:00Z');
const SECRETS = {
  servicePassword: 'service-password-for-tests',
  supervisorPassword: 'supervisor-password-for-tests',
};
let db: Db;

beforeAll(async () => {
  db = await connectInProcess();
  await migrate(db);
  await seed(db, TENANTS.generic, SECRETS, NOW);
}, 60_000);
afterAll(() => db.close());

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;

describe('the seed', () => {
  it('runs once: a second run changes nothing', async () => {
    expect(await seed(db, TENANTS.generic, SECRETS, NOW)).toBe(false);
  });

  it('creates the service account, a supervisor and a locked teller', async () => {
    const ops = (
      await db.query<{ operator_id: string; role: string; locked: boolean }>(
        'SELECT operator_id, role, locked FROM operators ORDER BY operator_id',
      )
    ).rows;
    expect(ops).toEqual([
      { operator_id: OPERATORS.locked.id, role: 'teller', locked: true },
      { operator_id: OPERATORS.service.id, role: 'senior teller', locked: false },
      { operator_id: OPERATORS.supervisor.id, role: 'supervisor', locked: false },
    ]);
  });

  it('stores passwords only as argon2 hashes', async () => {
    const c = await one<{ hash: string }>(
      'SELECT c.hash FROM credentials c JOIN operators o ON o.pk = c.operator_pk WHERE o.operator_id = $1',
      [OPERATORS.service.id],
    );
    expect(c.hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(c.hash, SECRETS.servicePassword)).toBe(true);
  });

  it('has 25 members, one for every case the brief names, and never the missing one', async () => {
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM members')).n).toBe(25);
    const demo = await one<{ first_name: string; last_name: string }>(
      'SELECT * FROM members WHERE number = $1',
      [MEMBERS.demo],
    );
    expect(`${demo.first_name} ${demo.last_name}`).toBe('Alex Sample');
    expect(
      (
        await one<{ status: string }>('SELECT status FROM members WHERE number = $1', [
          MEMBERS.closed,
        ])
      ).status,
    ).toBe('closed');
    const types = async (m: string) =>
      (
        await db.query<{ type: string }>(
          'SELECT type FROM accounts WHERE member_number = $1 ORDER BY id',
          [m],
        )
      ).rows.map((r) => r.type);
    expect(await types(MEMBERS.ira)).toContain('ira');
    expect(await types(MEMBERS.cd)).toContain('cd');
    const restricted = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM accounts WHERE member_number = $1 AND restriction = 'refer to branch'`,
      [MEMBERS.restricted],
    );
    expect(restricted.n).toBe(1);
    expect(
      (await db.query('SELECT 1 FROM members WHERE number = $1', [MEMBERS.missing])).rows,
    ).toHaveLength(0);
  });

  it('writes twelve months of history in balanced pairs', async () => {
    const r = await one<{ total: number; bad: number; months: number }>(
      `SELECT (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM ledger_entries) AS total,
              (SELECT count(*)::int FROM (SELECT txn FROM ledger_entries GROUP BY txn HAVING SUM(amount_cents) <> 0) x) AS bad,
              (SELECT count(DISTINCT date_trunc('month', posted_at))::int FROM ledger_entries) AS months`,
    );
    expect(r.total).toBe(0);
    expect(r.bad).toBe(0);
    expect(r.months).toBe(13);
  });

  it('is the same every time for the same bank, and different for another', async () => {
    const run = async (t: typeof TENANTS.generic) => {
      const other = await connectInProcess();
      await migrate(other);
      await seed(other, t, SECRETS, NOW);
      const rows = (
        await other.query('SELECT number, first_name, last_name FROM members ORDER BY number')
      ).rows;
      await other.close();
      return rows;
    };
    const mine = (
      await db.query('SELECT number, first_name, last_name FROM members ORDER BY number')
    ).rows;
    expect(await run(TENANTS.generic)).toEqual(mine);
    expect(await run(TENANTS.example)).not.toEqual(mine);
  }, 60_000);
});
