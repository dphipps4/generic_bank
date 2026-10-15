import { createRun, openHumanTask } from '../../runs/src/index.js';
import { issueGrant, type Sql, type TransferValues } from '../src/index.js';

export const KEY = 's'.repeat(40);

export const REVIEW: TransferValues = {
  fromRef: '****7890',
  toRef: '****1234',
  amountCents: 12_500,
  memoToken: 'GBX 7Q4M',
};

/** A transfer run parked for approval, and the person's approval task. */
export async function parkedRun(db: Sql): Promise<{ runId: string; humanTaskId: string }> {
  const { runId } = await createRun(
    db,
    { task: 'transfer', bank: 'generic', clientId: null, inputs: { bank: 'generic' } },
    KEY,
  );
  const humanTaskId = await openHumanTask(
    db,
    runId,
    'approval',
    { amountCents: REVIEW.amountCents },
    new Date(Date.now() + 15 * 60_000),
  );
  return { runId, humanTaskId };
}

/** A run a person approved, with the review page's values, at `now`. */
export async function approvedRun(db: Sql, now = new Date(), values = REVIEW) {
  const run = await parkedRun(db);
  const grant = await issueGrant(db, { ...run, ...values }, now);
  return { ...run, ...grant };
}
