import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Db, Query } from '../src/db.js';

export const MIGRATIONS = join(import.meta.dirname, '../prisma/migrations');

export const migrations = () =>
  readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

/** An empty in-process Postgres with pgvector, as the compose Postgres gives memory. */
export const emptyDb = () => new PGlite({ extensions: { vector } });

/** The memory database for a test: every real migration applied, writes serializable. */
export async function memoryDb(): Promise<Db & { pg: PGlite }> {
  const pg = emptyDb();
  for (const m of migrations())
    await pg.exec(readFileSync(join(MIGRATIONS, m, 'migration.sql'), 'utf8'));
  return {
    pg,
    query: (sql, params) => pg.query(sql, params) as never,
    serializable: (fn) =>
      pg.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        return fn(tx as Query);
      }),
    close: () => pg.close(),
  };
}
