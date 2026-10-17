import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, types } from '@electric-sql/pglite';
import type { Sql } from '../src/index.js';

// Prisma writes UTC into timestamp columns that carry no zone; read them back as UTC, or every
// time is off by the machine's offset from UTC.
const parsers = { [types.TIMESTAMP]: (v: string) => new Date(`${v.replace(' ', 'T')}Z`) };

// Every real migration, applied once per test worker; each database starts from a copy of it.
let migrated: Promise<Blob> | undefined;
async function migrate(): Promise<Blob> {
  const dir = join(import.meta.dirname, '../../db/prisma/migrations');
  const db = new PGlite();
  for (const m of readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    await db.exec(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
  }
  const data = await db.dumpDataDir('none');
  await db.close();
  return data;
}

/** The control database for a test: an in-process Postgres with every real migration applied. */
export async function controlDb(): Promise<Sql & { close(): Promise<void> }> {
  const db = new PGlite({ loadDataDir: await (migrated ??= migrate()), parsers });
  // The control database runs in UTC, as it does in compose: now() must agree with the Dates we write.
  await db.exec(`SET TIME ZONE 'UTC'`);
  return { query: (sql, params) => db.query(sql, params) as never, close: () => db.close() };
}
