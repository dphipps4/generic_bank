// Forced hazards on a run (plan, §A.3). The hazard lab names them when it starts a run; they are kept
// beside the run's masked inputs, where anyone reading the run sees them, and the Runner signs them
// into the one header a forceable bank obeys. The signature is the bank's own scheme: the names
// sorted and joined with commas, then an HMAC-SHA256 of that list.
import { createHmac } from 'node:crypto';
import { type HazardName, isHazard } from '@gb/contracts';

interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export const HAZARD_HEADER = 'x-hazards';

/** The header that forces exactly `names` on a bank holding `key`. */
export function hazardHeader(names: readonly HazardName[], key: string): Record<string, string> {
  const list = [...names].sort().join(',');
  return {
    [HAZARD_HEADER]: `${list};${createHmac('sha256', key).update(list).digest('hex')}`,
  };
}

/** The hazards a run was started under; none for a run started by an API client. */
export async function forcedHazardsOf(sql: Sql, runId: string): Promise<HazardName[]> {
  const r = await sql.query<{ forced: unknown }>(
    `SELECT "inputsMasked"->'forcedHazards' AS forced FROM "TaskRun" WHERE id = $1`,
    [runId],
  );
  const forced = r.rows[0]?.forced;
  return Array.isArray(forced) ? forced.filter((n): n is HazardName => isHazard(String(n))) : [];
}
