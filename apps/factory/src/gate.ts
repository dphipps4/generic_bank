// The gate after a person's approval (plan, §10): the approved recommendation becomes a candidate
// version, its profile runs the hazard check against the bank, and on probation two clean runs
// promote it. A repaired version's promotion closes the bank's repair case, and memory is told, so
// its rules confirm what the probation runs bore out. The profile checked is the one the Runner
// will serve: the registry's, built from the same claims over the same base.
import { closeRepairCase, profileOf, type Sql } from '@gb/runs';
import { attemptOn, hazardCheck, HEALTHY, judge, type Sandbox } from './hazard-check.js';
import { candidate, checked, CLEAN_RUNS, probationRun, type Version } from './lifecycle.js';
import { type Memory, sendPromotion } from './memory.js';

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
  o: { sql: Sql; sandbox: Sandbox; memory?: Memory; log?: (line: string) => void },
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
    const check = await hazardCheck(attempt, sandbox.ledger);
    v = await checked(sql, v.id, check);
    if (!check.passed) {
      log(`  failed: ${check.failed.join(', ')}`);
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
