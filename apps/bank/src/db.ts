// The bank's own database. In the containers it is Postgres in bank-db; in tests it is PGlite,
// the same Postgres compiled to run in-process. Both answer `query(sql, params)` with rows.

type Query = <R = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: R[] }>;

export interface Db {
  query: Query;
  /** Runs `fn` on one connection inside BEGIN and COMMIT; any throw rolls it back. */
  transaction<T>(fn: (query: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function connectPostgres(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  // Sums of bigint come back as strings by default; balances are always summed in cents.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    query: async (sql, params) => pool.query(sql, params as unknown[]) as never,
    transaction: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(async (sql, params) => c.query(sql, params as unknown[]) as never);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function connectInProcess(): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const db = new PGlite({
    parsers: { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) },
  });
  return {
    query: async (sql, params) => db.query(sql, params) as never,
    transaction: (fn) =>
      db.transaction((tx) => fn(async (sql, params) => tx.query(sql, params) as never)),
    close: () => db.close(),
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS operators (
  pk serial PRIMARY KEY,
  operator_id text UNIQUE NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('teller', 'senior teller', 'supervisor')),
  locked boolean NOT NULL DEFAULT false,
  locked_until timestamptz,
  phone text NOT NULL,
  email text NOT NULL,
  daily_limit_cents bigint NOT NULL
);
ALTER TABLE operators DROP COLUMN IF EXISTS totp_secret;
CREATE TABLE IF NOT EXISTS credentials (
  operator_pk int PRIMARY KEY REFERENCES operators(pk),
  hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS workstations (
  token text PRIMARY KEY,
  operator_pk int NOT NULL REFERENCES operators(pk),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sign_in_attempts (
  id serial PRIMARY KEY,
  operator_id text NOT NULL,
  ok boolean NOT NULL,
  at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  number text PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'closed'))
);
CREATE TABLE IF NOT EXISTS accounts (
  id serial PRIMARY KEY,
  member_number text REFERENCES members(number),
  type text NOT NULL CHECK (type IN ('checking', 'savings', 'money market', 'ira', 'cd', 'suspense')),
  nickname text NOT NULL,
  number text UNIQUE NOT NULL,
  restriction text CHECK (restriction IN ('refer to branch'))
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  txn text NOT NULL,
  account_id int NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL,
  pending boolean NOT NULL DEFAULT false,
  description text NOT NULL,
  posted_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_entries_account ON ledger_entries (account_id, posted_at);
CREATE TABLE IF NOT EXISTS transfers (
  id serial PRIMARY KEY,
  member_number text NOT NULL REFERENCES members(number),
  from_account int NOT NULL REFERENCES accounts(id),
  to_account int NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL,
  memo text NOT NULL,
  operator_pk int NOT NULL REFERENCES operators(pk),
  approved_by int REFERENCES operators(pk),
  confirmation text UNIQUE NOT NULL,
  status text NOT NULL CHECK (status IN ('posted')),
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS one_time_codes (
  id serial PRIMARY KEY,
  operator_pk int NOT NULL REFERENCES operators(pk),
  purpose text NOT NULL CHECK (purpose IN ('sign-in', 'approval')),
  channel text NOT NULL,
  code text NOT NULL,
  tries int NOT NULL DEFAULT 0,
  used boolean NOT NULL DEFAULT false,
  ref text,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  operator_pk int REFERENCES operators(pk),
  state text NOT NULL CHECK (state IN ('code', 'handoff', 'active', 'ended')),
  handoff text,
  pending jsonb,
  promo_shown boolean NOT NULL DEFAULT false,
  last_seen timestamptz NOT NULL,
  expires_early_at timestamptz
);
CREATE TABLE IF NOT EXISTS messages (
  id serial PRIMARY KEY,
  mailbox text NOT NULL CHECK (mailbox IN ('phone', 'email')),
  address text NOT NULL,
  body text NOT NULL,
  at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS hazard_events (
  id bigserial PRIMARY KEY,
  hazard text NOT NULL,
  path text NOT NULL,
  forced boolean NOT NULL,
  at timestamptz NOT NULL
);
ALTER TABLE hazard_events ADD COLUMN IF NOT EXISTS detail text;
CREATE TABLE IF NOT EXISTS state_changes (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  detail jsonb NOT NULL,
  at timestamptz NOT NULL
);
`;

export async function migrate(db: Db): Promise<void> {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim())) {
    if (stmt) await db.query(stmt);
  }
}
