import { describe, expect, it } from 'vitest';
import { connectInProcess, migrate } from '../src/db.js';
import { hash32, rng } from '../src/rng.js';
import { TENANTS } from '../src/tenants.js';

describe('the bank database', () => {
  it('migrates, and migrating again changes nothing', async () => {
    const db = await connectInProcess();
    await migrate(db);
    await migrate(db);
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(r.rows[0]!.n).toBe(13);
    await db.close();
  });

  it('rolls back a transaction that throws', async () => {
    const db = await connectInProcess();
    await migrate(db);
    await expect(
      db.transaction(async (q) => {
        await q(
          `INSERT INTO members (number, first_name, last_name, status) VALUES ('1', 'A', 'B', 'active')`,
        );
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM members');
    expect(r.rows[0]!.n).toBe(0);
    await db.close();
  });

  it('refuses a member status the product does not have', async () => {
    const db = await connectInProcess();
    await migrate(db);
    await expect(
      db.query(
        `INSERT INTO members (number, first_name, last_name, status) VALUES ('1', 'A', 'B', 'frozen')`,
      ),
    ).rejects.toThrow();
    await db.close();
  });
});

describe('the four banks', () => {
  const all = Object.values(TENANTS);

  it('each have their own base path, database and markup seed', () => {
    for (const k of ['basePath', 'database', 'markupSeed'] as const) {
      expect(new Set(all.map((t) => t[k])).size).toBe(all.length);
    }
  });

  it('word the same account differently', () => {
    expect(TENANTS.generic.accountWording('1234567890')).toBe('Account ending in 7890');
    expect(TENANTS.example.accountWording('1234567890')).toBe('Share ****7890-S01');
    expect(TENANTS.sample.accountWording('1234567890')).toBe('Acct 1234-5678-90');
  });

  it('ask for a supervisor at their own thresholds', () => {
    expect(all.map((t) => t.supervisorThresholdCents)).toEqual([250_000, 100_000, 50_000, 200_000]);
  });
});

describe('the seeded generator', () => {
  it('gives the same sequence for the same seed, and a different one otherwise', () => {
    const a = rng(hash32('x'));
    const b = rng(hash32('x'));
    const c = rng(hash32('y'));
    const seq = (r: ReturnType<typeof rng>) => Array.from({ length: 5 }, () => r.int(0, 1000));
    const sa = seq(a);
    expect(seq(b)).toEqual(sa);
    expect(seq(c)).not.toEqual(sa);
  });
});
