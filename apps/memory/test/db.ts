import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Db, Query } from '../src/db.js';
import { door, sign, SIGNATURE } from '../src/door.js';
import { DIMENSIONS, type Embed } from '../src/embed.js';
import type { Role } from '../src/memory.js';

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

export const TOKENS = {
  runner: 'r'.repeat(40),
  factory: 'f'.repeat(40),
  curator: 'c'.repeat(40),
  system: 'y'.repeat(40),
} as const;
export const SIGNING_KEY = 'm'.repeat(40);

export const testDoor = () => door({ tokens: TOKENS, signingKey: SIGNING_KEY });

/** A signed write, as a role's client sends it. */
export function signedPost(
  app: { inject: (o: object) => Promise<{ statusCode: number; json(): unknown }> },
  write: string,
  body: unknown,
  role: Role,
) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: `/${write}`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKENS[role]}`,
      [SIGNATURE]: sign(SIGNING_KEY, 'POST', `/${write}`, payload),
    },
    payload,
  });
}

/** The model's stand-in in tests: each word hashed to a dimension, so the same words in any order
 *  or case are the same vector, and a text with other words is far from it. */
export const testEmbed: Embed = async (text) => {
  const v = new Array<number>(DIMENSIONS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    v[createHash('sha256').update(w).digest().readUInt32BE(0) % DIMENSIONS]! += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
};
