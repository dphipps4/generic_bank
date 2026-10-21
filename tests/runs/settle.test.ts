// No run is left showing as running after its process stopped: an error no step caught, a signal,
// a crash. The net ends what is still open as failed, and touches nothing else.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbNow, failOpenFactoryRuns } from '../../apps/factory/src/settle.js';
import { failIfOpen } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';

let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(async () => {
  await db?.close();
});

const taskRun = (id: string, bank: string, ago = 0, factory = true) =>
  db.query(
    `INSERT INTO "TaskRun" (id, task, bank, "inputsMasked", status, "startedAt")
     VALUES ($1, 'factory', $2, $3, 'running', now() - make_interval(mins => $4))`,
    [id, bank, JSON.stringify(factory ? { factoryRun: id } : {}), ago],
  );
const factoryRun = (id: string, bank: string, ago = 0) =>
  db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status, "startedAt")
     VALUES ($1, $2, 'check-balance', 'build', 'SCOUT', 'running', now() - make_interval(mins => $3))`,
    [id, bank, ago],
  );
const statusOf = async (table: 'TaskRun' | 'FactoryRun', id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM "${table}" WHERE id = $1`, [id])).rows[0]
    ?.status;

describe('a run left open', () => {
  it('ends as failed, with the question it left a person cancelled', async () => {
    await taskRun('r_open', 'generic', 0, false);
    await db.query(
      `INSERT INTO "HumanTask" (id, "runId", kind, "contextMasked", deadline, resolvable)
       VALUES ('h_open', 'r_open', 'staff_code', '{}', now() + interval '5 minutes', true)`,
    );
    expect(await failIfOpen(db, 'r_open')).toBe(true);
    expect(await statusOf('TaskRun', 'r_open')).toBe('failed');
    const h = await db.query<{ status: string }>(
      `SELECT status FROM "HumanTask" WHERE id = 'h_open'`,
    );
    expect(h.rows[0]!.status).toBe('cancelled');
  });

  it('is left as it is once settled', async () => {
    await taskRun('r_done', 'generic', 0, false);
    await db.query(
      `UPDATE "TaskRun" SET status = 'succeeded', "settledAt" = now() WHERE id = 'r_done'`,
    );
    expect(await failIfOpen(db, 'r_done')).toBe(false);
    expect(await statusOf('TaskRun', 'r_done')).toBe('succeeded');
  });
});

describe('the factory net', () => {
  it("ends this process's open runs and their gate replays, and nothing else", async () => {
    await factoryRun('build-before', 'example', 1);
    await taskRun('build-before', 'example', 1);
    const since = await dbNow(db);
    await factoryRun('build-mine', 'example');
    await taskRun('build-mine', 'example');
    await taskRun('build-mine-check', 'example');
    await factoryRun('build-other', 'generic');
    expect(await failOpenFactoryRuns(db, 'example', { since })).toBe(3);
    expect(await statusOf('FactoryRun', 'build-mine')).toBe('failed');
    expect(await statusOf('TaskRun', 'build-mine')).toBe('failed');
    expect(await statusOf('TaskRun', 'build-mine-check')).toBe('failed');
    // Started before this process, or at another bank: not this process's to end.
    expect(await statusOf('FactoryRun', 'build-before')).toBe('running');
    expect(await statusOf('TaskRun', 'build-before')).toBe('running');
    expect(await statusOf('FactoryRun', 'build-other')).toBe('running');
  });

  it('ends a run older than the hard stop, and leaves a younger one running', async () => {
    await factoryRun('build-dead', 'sample', 90);
    await taskRun('build-dead-trusted', 'sample', 90);
    await factoryRun('build-alive', 'sample', 10);
    expect(await failOpenFactoryRuns(db, 'sample', { olderThanMs: 75 * 60_000 })).toBe(2);
    expect(await statusOf('FactoryRun', 'build-dead')).toBe('failed');
    expect(await statusOf('TaskRun', 'build-dead-trusted')).toBe('failed');
    expect(await statusOf('FactoryRun', 'build-alive')).toBe('running');
  });
});
