// A repair starts from where the table last broke: the bank's repair case names the latest failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driverFault, openRepairCase } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';

let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(async () => {
  await db?.close();
});

const fault = (runId: string) =>
  driverFault(db, { tenant: 'sample', task: 'check-balance', versionId: null, runId, why: 'test' });

describe('the repair case', () => {
  it('names the latest failure, and counts each one', async () => {
    await fault('build-first-check');
    expect((await openRepairCase(db, 'sample', 'check-balance'))?.runId).toBe('build-first-check');
    await fault('repair-second-trusted');
    const c = await openRepairCase(db, 'sample', 'check-balance');
    expect(c?.runId).toBe('repair-second-trusted');
    const n = await db.query<{ n: number }>(
      `SELECT "consecutiveFailures" AS n FROM "RepairCase" WHERE id = $1`,
      [c!.id],
    );
    expect(n.rows[0]!.n).toBe(2);
  });
});
