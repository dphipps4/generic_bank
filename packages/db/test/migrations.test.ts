import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

// The control database's migrations, applied in order to a real (in-process) Postgres, the way
// `prisma migrate deploy` applies them in compose.

const dir = join(import.meta.dirname, '../prisma/migrations');
const migrations = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe('control database migrations', () => {
  it('apply in order, each on top of the last', async () => {
    const db = new PGlite();
    for (const m of migrations) await db.exec(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
    const tables = await db.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = tables.rows.map((r) => r.t);
    for (const t of ['TaskRun', 'ApiClient', 'ApiCode', 'TokenFamily', 'ApiToken'])
      expect(names).toContain(t);
    await db.close();
  });

  it('keep the runs that existed when "tenant" became "bank"', async () => {
    const db = new PGlite();
    const [first, ...rest] = migrations;
    await db.exec(readFileSync(join(dir, first!, 'migration.sql'), 'utf8'));
    await db.exec(
      `INSERT INTO "TaskRun" (id, task, tenant, "inputsMasked", "idempotencyKey") VALUES ('r1', 'check-balance', 'generic', '{}', 'k1')`,
    );
    for (const m of rest) await db.exec(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
    const r = await db.query<{ bank: string }>(`SELECT bank FROM "TaskRun" WHERE id = 'r1'`);
    expect(r.rows[0]!.bank).toBe('generic');
    await db.query(
      `INSERT INTO "TaskRun" (id, task, bank, "inputsMasked") VALUES ('r2', 'check-balance', 'generic', '{}')`,
    );
    await db.close();
  });

  it('keep human tasks when take-over becomes an escalation', async () => {
    const db = new PGlite();
    const at = migrations.indexOf('0005_human_steps');
    for (const m of migrations.slice(0, at))
      await db.exec(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
    await db.exec(
      `INSERT INTO "TaskRun" (id, task, bank, "inputsMasked") VALUES ('r1', 'transfer', 'generic', '{}');
       INSERT INTO "HumanTask" (id, "runId", kind, "contextMasked", deadline)
         VALUES ('h1', 'r1', 'take_over', '{}', now()), ('h2', 'r1', 'staff_code', '{}', now())`,
    );
    for (const m of migrations.slice(at))
      await db.exec(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
    const r = await db.query<{ id: string; kind: string; resolvable: boolean; asks: number }>(
      `SELECT id, kind::text AS kind, resolvable, asks FROM "HumanTask" ORDER BY id`,
    );
    expect(r.rows).toEqual([
      { id: 'h1', kind: 'escalation', resolvable: true, asks: 0 },
      { id: 'h2', kind: 'staff_code', resolvable: true, asks: 0 },
    ]);
    await db.query(
      `INSERT INTO "HumanTask" (id, "runId", kind, "contextMasked", deadline) VALUES ('h3', 'r1', 'supervisor_code', '{}', now())`,
    );
    await db.close();
  });
});
