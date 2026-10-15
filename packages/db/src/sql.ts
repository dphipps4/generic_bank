import pg from 'pg';

/** SQL against the control database, for services that need a few plain queries. */
export interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  close(): Promise<void>;
}

// Prisma writes UTC into `timestamp` columns that carry no zone; pg would read them as local
// time, so every time would be off by the machine's offset from UTC.
const TIMESTAMP = 1114;
const utc = (v: string) => new Date(`${v.replace(' ', 'T')}Z`);

export function sql(url: string): Sql {
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    types: {
      getTypeParser: ((oid: number, format?: string) =>
        oid === TIMESTAMP ? utc : pg.types.getTypeParser(oid, format as never)) as never,
    },
  });
  return {
    query: (q, params) => pool.query(q, params as unknown[]) as never,
    close: () => pool.end(),
  };
}
