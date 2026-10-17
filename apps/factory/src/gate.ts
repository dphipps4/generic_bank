// The gate after a person's approval (plan, §7): the approved recommendation becomes a candidate
// version, its profile runs the hazard check against the bank, and on probation two clean runs
// promote it. A repaired version's promotion closes the bank's repair case, and memory is told, so
// its rules confirm what the probation runs bore out. The profile checked is the one the Runner
// will serve: the registry's, built from the same claims over the same base. A control run that
// fails keeps its frames and opens the bank's repair case, so the Supervisor repairs the version
// from where it stopped.
import { randomBytes } from 'node:crypto';
import type { HazardName } from '@gb/contracts';
import type { FrameStore } from '@gb/evidence';
import type { ScreenModel } from '@gb/screen';
import { closeRepairCase, profileOf, type Sql } from '@gb/runs';
import { attemptOn, hazardCheck, HEALTHY, judge, type Sandbox } from './hazard-check.js';
import { candidate, checked, CLEAN_RUNS, probationRun, type Version } from './lifecycle.js';
import { type Memory, sendPromotion, vendorOf } from './memory.js';
import { openTrail } from './trail.js';

/** Waits until a person decides the recommendation in the Console; true when approved. */
export async function decided(
  sql: Sql,
  recommendationId: string,
  o: { pollMs?: number; deadlineMs?: number } = {},
): Promise<boolean> {
  const until = Date.now() + (o.deadlineMs ?? 7 * 24 * 3_600_000);
  while (Date.now() < until) {
    const r = await sql.query<{ status: string }>(
      `SELECT status FROM "Recommendation" WHERE id = $1`,
      [recommendationId],
    );
    const status = r.rows[0]?.status;
    if (!status) throw new Error(`no recommendation ${recommendationId}`);
    if (status !== 'open') return status === 'approved';
    await new Promise((x) => setTimeout(x, o.pollMs ?? 500));
  }
  return false;
}

export async function gate(
  o: {
    sql: Sql;
    sandbox: Sandbox;
    /** Where the control run's frames are kept; without one, a failed control opens no case. */
    store?: FrameStore;
    memory?: Memory;
    log?: (line: string) => void;
    /** Only these hazards in the hazard check (a test's short list); every hazard otherwise. */
    hazards?: readonly HazardName[];
  },
  recommendationId: string,
): Promise<Version> {
  const { sql, sandbox } = o;
  const log = o.log ?? (() => undefined);
  let v = await candidate(sql, recommendationId);
  const bank = (
    await sql.query<{ url: string }>('SELECT url FROM "Bank" WHERE id = $1', [v.tenant])
  ).rows[0];
  const profile = await profileOf(sql, v.id);
  if (!bank || !profile) throw new Error(`version ${v.id} has no profile to check`);
  const attempt = attemptOn(sandbox, { ...profile, url: bank.url });

  if (v.state === 'candidate') {
    log(`v${v.version}: the hazard check`);
    const runId = `check-${v.tenant}-${randomBytes(4).toString('hex')}`;
    const c = await sandbox.credentials();
    const trail = o.store
      ? await openTrail({
          sql,
          store: o.store,
          runId,
          task: v.task,
          bank: v.tenant,
          known: [c.operatorId, c.password],
        })
      : null;
    const record = trail && {
      step: async (s: { name: string; action?: string; outcome?: string }, m: ScreenModel | null) =>
        void (await trail.step({ name: s.name, action: s.action, outcome: s.outcome }, m)),
      learn: (values: string[]) => void trail.policy.known.push(...values),
    };
    const check = await hazardCheck(attempt, sandbox.ledger, o.hazards, record ?? undefined);
    const control = check.verdicts[0]!;
    if (trail)
      await sql.query(
        `UPDATE "TaskRun" SET status = $2::"TaskStatus", "settledAt" = now() WHERE id = $1`,
        [
          runId,
          control.passed
            ? 'succeeded'
            : control.got.startsWith('escalated')
              ? 'escalated'
              : 'failed',
        ],
      );
    v = await checked(sql, v.id, check);
    if (!check.passed) {
      log(`  failed: ${check.failed.join(', ')}`);
      if (trail && !control.passed) {
        await openCaseAt(sql, { tenant: v.tenant, task: v.task, runId, versionId: v.id });
        log(`  ${control.got}; a repair case is open: just repair ${v.tenant}`);
        if (o.memory) {
          const why = await sendFailure(o.memory, sql, v, runId, control.got);
          log(why ? `  memory has not taken the failure (${why})` : '  memory told of the failure');
        }
      }
      return v;
    }
  }
  while (v.state === 'probation') {
    const run = await judge(attempt, sandbox.ledger, null, HEALTHY.expected);
    log(`v${v.version}: a probation run: ${run.got}`);
    v = await probationRun(sql, v.id, run);
  }
  if (v.state === 'promoted') {
    await closeRepairCase(sql, v.tenant, v.task);
    log(`v${v.version}: promoted; it serves ${v.task} at ${v.tenant}`);
    // Memory's rules read the promotion from its probation runs. Its being down never undoes the
    // promotion; the gate, run again, sends it again.
    if (o.memory) {
      const why = await sendPromotion(o.memory, sql, v, CLEAN_RUNS);
      log(
        why ? `  memory has not taken the promotion (${why}): run the gate again` : '  memory told',
      );
    }
  }
  return v;
}

/**
 * The bank's repair case, pointed at the version whose control run failed and at that run: a
 * repair starts from that version's profile and is shown that run's frames.
 */
async function openCaseAt(
  sql: Sql,
  c: { tenant: string; task: string; runId: string; versionId: string },
) {
  await sql.query(
    `INSERT INTO "RepairCase" (id, tenant, task, "consecutiveFailures", "lastFailureAt", "runId", "versionId")
     VALUES ($1, $2, $3, 1, now(), $4, $5)
     ON CONFLICT (tenant, task) WHERE status = 'open'
     DO UPDATE SET "consecutiveFailures" = "RepairCase"."consecutiveFailures" + 1,
       "lastFailureAt" = now(), "runId" = EXCLUDED."runId", "versionId" = EXCLUDED."versionId"`,
    [`rc_${randomBytes(8).toString('hex')}`, c.tenant, c.task, c.runId, c.versionId],
  );
}

/**
 * A control run that failed, as memory's episode of it: a run of this version with its outcome,
 * and one attempt whose failure says what the driver looked for and did not find. The next run's
 * knowledge pack serves it among the bank's latest attempts.
 */
async function sendFailure(
  memory: Memory,
  sql: Sql,
  v: Version,
  runId: string,
  got: string,
): Promise<string | null> {
  const outcome = got.startsWith('escalated') ? 'escalated' : 'failed';
  const stopped = (
    await sql.query<{ outcome: string | null; at: Date }>(
      `SELECT outcome, "startedAt" AS at FROM "Step" WHERE "runId" = $1 ORDER BY seq DESC LIMIT 1`,
      [runId],
    )
  ).rows[0];
  const vendor = await vendorOf(sql, v.tenant);
  const at = stopped?.at ?? new Date();
  try {
    const run = await memory.write('episodes/runs', {
      id: runId,
      kind: 'task',
      bank: v.tenant,
      ...(vendor ? { vendor } : {}),
      task: v.task,
      driver: v.id,
      outcome,
      startedAt: at,
    });
    if (run.status >= 300 && run.body.error !== 'run_exists') return `${run.status}`;
    const attempt = await memory.write('episodes/attempts', {
      runId,
      n: 1,
      outcome,
      failure: (stopped?.outcome ?? got).slice(0, 200),
      at,
    });
    return attempt.status >= 300 && attempt.body.error !== 'attempt_exists'
      ? `${attempt.status}`
      : null;
  } catch (e) {
    return `memory did not answer: ${(e as Error).message}`;
  }
}
