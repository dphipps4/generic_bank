// Memory's database, in plain SQL. Every write runs in one serializable transaction.
import pg from 'pg';

export interface Query {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db extends Query {
  /** Runs `fn` in one serializable transaction, again if Postgres could not serialize it. */
  serializable<T>(fn: (tx: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const TRIES = 5;

// Two writes that read and change the same rows: Postgres refuses one as a serialization failure.
// Run it again on what the other wrote.
const conflict = (e: unknown) => (e as { code?: string }).code === '40001';

export function pgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    query: (sql, params) => pool.query(sql, params) as never,
    async serializable(fn) {
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          const out = await fn(client as Query);
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (!conflict(e) || attempt === TRIES) throw e;
        } finally {
          client.release();
        }
      }
    },
    close: () => pool.end(),
  };
}
