// The driver's states (plan, §10, Appendix L). An approved recommendation becomes a candidate
// version of the bank's driver. It goes on probation only once it passes the hazard check; one that
// fails stays a candidate, and its registry event names each hazard it failed. Two clean probation
// runs in a row promote it, which is what puts the task on the bank in GET /banks; at most four
// probation runs, and then it is a candidate again. Probation finds the version by its id, never
// by the bank's name. Every move writes a registry event and an audit entry.
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '@gb/runs';
import type { HazardCheck, Verdict } from './hazard-check.js';
import type { Claim } from './recommend.js';

/** Clean probation runs in a row that promote a version, and the most it gets. */
export const CLEAN_RUNS = 2;
export const PROBATION_RUNS = 4;

type State = 'draft' | 'candidate' | 'probation' | 'promoted' | 'retired';

export interface Version {
  id: string;
  driverId: string;
  tenant: string;
  task: string;
  version: number;
  state: State;
  /** The approved claims the profile is built from. */
  claims: Claim[];
}

const id = (p: string) => `${p}_${randomBytes(8).toString('hex')}`;

export async function versionOf(sql: Sql, versionId: string): Promise<Version | null> {
  const r = await sql.query<Version>(
    `SELECT v.id, v."driverId", d.tenant, d.task, v.version, v.state::text AS state, r.claims
       FROM "DriverVersion" v JOIN "Driver" d ON d.id = v."driverId"
       JOIN "Recommendation" r ON r."factoryRunId" = v."sourceFactoryRunId"
      WHERE v.id = $1`,
    [versionId],
  );
  return r.rows[0] ?? null;
}

/** Moves a version and writes why; a driver with nothing serving shows its version's state. */
async function move(sql: Sql, v: Version, to: State, by: string, reason: string) {
  await sql.query(`UPDATE "DriverVersion" SET state = $2::"DriverState" WHERE id = $1`, [v.id, to]);
  await sql.query(
    `UPDATE "Driver" SET state = $2::"DriverState" WHERE id = $1 AND "activeVersionId" IS NULL`,
    [v.driverId, to],
  );
  await sql.query(
    `INSERT INTO "RegistryEvent" (id, "driverId", "fromState", "toState", by, reason)
     VALUES ($1, $2, $3::"DriverState", $4::"DriverState", $5, $6)`,
    [id('re'), v.driverId, v.state, to, by, `v${v.version}: ${reason}`],
  );
  await sql.query(
    `INSERT INTO "AuditEntry" (id, actor, action, target, reason) VALUES ($1, $2, $3, $4, $5)`,
    [id('a'), by, `driver.${to}`, v.id, reason],
  );
  v.state = to;
}

/**
 * The approved recommendation of a factory run, as a candidate version of the bank's driver for the
 * run's task. Once per recommendation; asked again, it returns the same version.
 */
export async function candidate(sql: Sql, recommendationId: string): Promise<Version> {
  const r = (
    await sql.query<{ status: string; tenant: string; task: string; run: string; claims: Claim[] }>(
      `SELECT r.status, r.tenant, f.task, r."factoryRunId" AS run, r.claims
         FROM "Recommendation" r JOIN "FactoryRun" f ON f.id = r."factoryRunId" WHERE r.id = $1`,
      [recommendationId],
    )
  ).rows[0];
  if (r?.status !== 'approved')
    throw new Error(`recommendation ${recommendationId} is not approved by a person`);
  const made = (
    await sql.query<{ id: string }>(
      `SELECT id FROM "DriverVersion" WHERE "sourceFactoryRunId" = $1`,
      [r.run],
    )
  ).rows[0];
  if (made) return (await versionOf(sql, made.id))!;
  await sql.query(
    `INSERT INTO "Driver" (id, tenant, task) VALUES ($1, $2, $3) ON CONFLICT (tenant, task) DO NOTHING`,
    [id('drv'), r.tenant, r.task],
  );
  const driver = (
    await sql.query<{ id: string; next: number }>(
      `SELECT d.id, COALESCE(max(v.version), 0) + 1 AS next
         FROM "Driver" d LEFT JOIN "DriverVersion" v ON v."driverId" = d.id
        WHERE d.tenant = $1 AND d.task = $2 GROUP BY d.id`,
      [r.tenant, r.task],
    )
  ).rows[0]!;
  const v: Version = {
    id: id('dv'),
    driverId: driver.id,
    tenant: r.tenant,
    task: r.task,
    version: driver.next,
    state: 'candidate',
    claims: r.claims,
  };
  const sha = createHash('sha256').update(JSON.stringify(r.claims)).digest('hex');
  await sql.query(
    `INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state, "sourceFactoryRunId")
     VALUES ($1, $2, $3, $4, 'profile', 'draft', $5)`,
    [v.id, v.driverId, v.version, sha, r.run],
  );
  await sql.query(`UPDATE "Driver" SET "candidateVersionId" = $2 WHERE id = $1`, [
    v.driverId,
    v.id,
  ]);
  await move(
    sql,
    { ...v, state: 'draft' },
    'candidate',
    'the factory',
    `recommendation ${recommendationId} approved`,
  );
  return v;
}

const said = (v: Verdict) => `${v.hazard ?? 'control'} gave ${v.got}, expected ${v.expected}`;

/**
 * Records a candidate's hazard check (E2). Passed, it goes on probation; failed, it stays a
 * candidate, and the registry says which hazards failed and what each gave.
 */
export async function checked(sql: Sql, versionId: string, check: HazardCheck): Promise<Version> {
  const v = await versionOf(sql, versionId);
  if (v?.state !== 'candidate') throw new Error(`version ${versionId} is not a candidate`);
  await sql.query(
    `INSERT INTO "EvalResult" (id, "driverVersionId", rung, outcome, details)
     VALUES ($1, $2, 'E2', $3::"EvalOutcome", $4)`,
    [id('ev'), v.id, check.passed ? 'passed' : 'failed', JSON.stringify(check)],
  );
  if (check.passed)
    await move(
      sql,
      v,
      'probation',
      'the hazard check',
      `passed the control run and every forced hazard (${check.verdicts.length - 1})`,
    );
  else
    await move(
      sql,
      v,
      'candidate',
      'the hazard check',
      `failed: ${check.verdicts
        .filter((x) => !x.passed)
        .map(said)
        .join('; ')}`,
    );
  return v;
}

/**
 * Records one probation run (E5) of a version on probation. Two clean runs in a row promote it: the
 * driver serves it, and the version it replaces is retired. After four runs without that, it is a
 * candidate again.
 */
export async function probationRun(sql: Sql, versionId: string, run: Verdict): Promise<Version> {
  const v = await versionOf(sql, versionId);
  if (v?.state !== 'probation') throw new Error(`version ${versionId} is not on probation`);
  const before = (
    await sql.query<{ passed: boolean }>(
      `SELECT outcome = 'passed' AS passed FROM "EvalResult"
        WHERE "driverVersionId" = $1 AND rung = 'E5' ORDER BY (details->>'n')::int`,
      [v.id],
    )
  ).rows.map((x) => x.passed);
  const runs = [...before, run.passed];
  await sql.query(
    `INSERT INTO "EvalResult" (id, "driverVersionId", rung, outcome, details)
     VALUES ($1, $2, 'E5', $3::"EvalOutcome", $4)`,
    [id('ev'), v.id, run.passed ? 'passed' : 'failed', JSON.stringify({ n: runs.length, ...run })],
  );
  if (runs.slice(-CLEAN_RUNS).filter(Boolean).length === CLEAN_RUNS) {
    await sql.query(
      `UPDATE "DriverVersion" SET state = 'retired'
        WHERE id = (SELECT "activeVersionId" FROM "Driver" WHERE id = $1)`,
      [v.driverId],
    );
    await sql.query(
      `UPDATE "Driver" SET "previousVersionId" = "activeVersionId", "activeVersionId" = $2,
              "candidateVersionId" = NULL, state = 'promoted' WHERE id = $1`,
      [v.driverId, v.id],
    );
    await move(sql, v, 'promoted', 'probation', `${CLEAN_RUNS} clean probation runs in a row`);
  } else if (runs.length >= PROBATION_RUNS)
    await move(
      sql,
      v,
      'candidate',
      'probation',
      `${PROBATION_RUNS} probation runs without ${CLEAN_RUNS} clean in a row; the last gave ${run.got}`,
    );
  return v;
}
