// The net under every way a factory run can stop: an error no step caught, a signal from the hard
// stop, a crash. Whatever this process left open ends as failed, and so does a run left open by a
// process that died long enough ago that nothing can still be running it.
import { failIfOpen, type Sql } from '@gb/runs';

/** Which open runs to end: this process's (started since it began), or those older than a limit. */
export type Open = { since: string } | { olderThanMs: number };

/** Ends the bank's open factory runs, and their gate replays, as failed; returns how many. */
export async function failOpenFactoryRuns(sql: Sql, bank: string, open: Open): Promise<number> {
  const [when, at] =
    'since' in open
      ? ['"startedAt" >= $2::timestamp', open.since]
      : [`"startedAt" < now() - make_interval(secs => $2::int / 1000)`, open.olderThanMs];
  const runs = await sql.query<{ id: string }>(
    `UPDATE "FactoryRun" SET status = 'failed', phase = 'DONE', "lastActivityAt" = now()
      WHERE tenant = $1 AND status = 'running' AND ${when} RETURNING id`,
    [bank, at],
  );
  // A factory run's trail, and each gate replay's, is a task run marked as the factory's.
  const trails = await sql.query<{ id: string }>(
    `SELECT id FROM "TaskRun"
      WHERE bank = $1 AND "settledAt" IS NULL AND "inputsMasked" ? 'factoryRun' AND ${when}`,
    [bank, at],
  );
  for (const t of trails.rows) await failIfOpen(sql, t.id);
  return runs.rows.length + trails.rows.length;
}

/** The database's clock now, as the control database writes "startedAt". */
export async function dbNow(sql: Sql): Promise<string> {
  return (await sql.query<{ t: string }>(`SELECT now()::timestamp(3)::text AS t`)).rows[0]!.t;
}
