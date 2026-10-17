// The registry (plan, §7): which version of a bank's crawler serves a task. The first fault demotes
// the version that served: the one before it serves again, or with none, nothing does, and a repair
// case opens.
import { randomBytes } from 'node:crypto';

interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

/** The version serving a task at a bank; null when nothing serves it, or the bank is frozen. */
export async function serving(
  sql: Sql,
  tenant: string,
  task: string,
): Promise<{ versionId: string | null } | null> {
  // A frozen bank runs nothing until a person clears the freeze (plan, §7).
  const d = (
    await sql.query<{ active: string | null }>(
      `SELECT "activeVersionId" AS active FROM "Driver"
        WHERE tenant = $1 AND task = $2 AND state = 'promoted'
          AND NOT EXISTS (SELECT 1 FROM "Freeze" WHERE tenant = $1 AND "clearedAt" IS NULL)`,
      [tenant, task],
    )
  ).rows[0];
  return d ? { versionId: d.active } : null;
}

/**
 * A driver fault in a run (an unknown screen, a targeting failure; never the bank's own error):
 * the version that ran it is demoted, if it still serves, and the bank and task's repair case
 * opens, or counts one more failure if it is open already. Returns whether the version was demoted.
 */
export async function driverFault(
  sql: Sql,
  o: { tenant: string; task: string; versionId: string | null; runId: string; why: string },
): Promise<boolean> {
  const d = (
    await sql.query<{ id: string; previous: string | null }>(
      `UPDATE "Driver" n SET "activeVersionId" = o."previousVersionId", "previousVersionId" = NULL,
              state = CASE WHEN o."previousVersionId" IS NULL THEN 'demoted' ELSE 'promoted' END::"DriverState"
         FROM "Driver" o
        WHERE n.id = o.id AND o.tenant = $1 AND o.task = $2 AND o.state = 'promoted'
          AND o."activeVersionId" IS NOT DISTINCT FROM $3
        RETURNING n.id, o."previousVersionId" AS previous`,
      [o.tenant, o.task, o.versionId],
    )
  ).rows[0];
  if (d) {
    if (o.versionId)
      await sql.query(`UPDATE "DriverVersion" SET state = 'demoted' WHERE id = $1`, [o.versionId]);
    if (d.previous)
      await sql.query(`UPDATE "DriverVersion" SET state = 'promoted' WHERE id = $1`, [d.previous]);
    const reason = `run ${o.runId}: ${o.why}; ${d.previous ? 'the previous version serves' : 'no version serves'}`;
    await sql.query(
      `INSERT INTO "RegistryEvent" (id, "driverId", "fromState", "toState", by, reason)
       VALUES ($1, $2, 'promoted', 'demoted', 'the runner', $3)`,
      [id('re'), d.id, reason],
    );
    await sql.query(
      `INSERT INTO "AuditEntry" (id, actor, action, target, reason) VALUES ($1, 'the runner', 'driver.demoted', $2, $3)`,
      [id('a'), o.versionId ?? d.id, reason],
    );
  }
  await sql.query(
    `INSERT INTO "RepairCase" (id, tenant, task, "consecutiveFailures", "lastFailureAt", "runId", "versionId")
     VALUES ($1, $2, $3, 1, now(), $4, $5)
     ON CONFLICT (tenant, task) WHERE status = 'open'
     DO UPDATE SET "consecutiveFailures" = "RepairCase"."consecutiveFailures" + 1, "lastFailureAt" = now()`,
    [id('rc'), o.tenant, o.task, o.runId, o.versionId],
  );
  return !!d;
}

/** The open repair case of a bank and task, if there is one. */
export async function openRepairCase(
  sql: Sql,
  tenant: string,
  task: string,
): Promise<{ id: string; runId: string | null; versionId: string | null } | null> {
  const r = await sql.query<{ id: string; runId: string | null; versionId: string | null }>(
    `SELECT id, "runId", "versionId" FROM "RepairCase" WHERE tenant = $1 AND task = $2 AND status = 'open'`,
    [tenant, task],
  );
  return r.rows[0] ?? null;
}

/** A repaired version is promoted: the bank and task's repair case closes. */
export async function closeRepairCase(sql: Sql, tenant: string, task: string) {
  await sql.query(
    `UPDATE "RepairCase" SET status = 'closed', "lastSuccessAt" = now()
      WHERE tenant = $1 AND task = $2 AND status = 'open'`,
    [tenant, task],
  );
}
