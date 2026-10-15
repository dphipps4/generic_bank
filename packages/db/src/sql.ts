import pg from 'pg';

/** SQL against the control database, for services that need a few plain queries. */
export interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  close(): Promise<void>;
}

// Prisma writes UTC into `timestamp` columns that carry no zone; pg would read them as local
// time, so every time would be off by the machine's offset from UTC. The same holds the other way:
// pg writes a Date as local time, which a zone-less column keeps as if it were UTC. So the session
// runs in UTC (now() is UTC) and every Date goes in as UTC, wherever the process runs.
const TIMESTAMP = 1114;
const utc = (v: string) => new Date(`${v.replace(' ', 'T')}Z`);
const asUtc = (params?: unknown[]) => params?.map((p) => (p instanceof Date ? p.toISOString() : p));

export function sql(url: string): Sql {
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    options: '-c TimeZone=UTC',
    types: {
      getTypeParser: ((oid: number, format?: string) =>
        oid === TIMESTAMP ? utc : pg.types.getTypeParser(oid, format as never)) as never,
    },
  });
  return {
    query: (q, params) => pool.query(q, asUtc(params)) as never,
    close: () => pool.end(),
  };
}
