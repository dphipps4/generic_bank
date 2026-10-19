// The gate against bank 1, with no model: a table runs live through the crawler's loop before a
// person sees it. One that fails never reaches a person's approval; one that passes the plain run
// and the run with the confirmation dialog forced waits for it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gate } from '../../apps/factory/src/gate.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { bank1, type Table } from '../../packages/crawler/src/index.js';
import { memoryStore } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { type Browser, launch } from '../../packages/runtime/src/index.js';
import { HMAC, type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

let bank: LiveBank;
let browser: Browser;
let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  [bank, browser, db] = await Promise.all([liveBank('generic'), launch(), controlDb()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
  await db?.close();
});

const deps = () => ({
  sql: db,
  store: memoryStore(),
  browser,
  credentials: { operatorId: OPERATORS.service.id, password: PASSWORDS.service },
  code: async () =>
    (await bank.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`)).code,
  hazardKey: HMAC,
});
async function aRun(): Promise<string> {
  const id = `build-gate-${Math.random().toString(16).slice(2, 10)}`;
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status) VALUES ($1, 'generic', 'check-balance', 'build', 'DONE', 'succeeded')`,
    [id],
  );
  return id;
}
const statusOf = async (id: string) =>
  (
    await db.query<{ status: string }>(
      `SELECT status FROM "Recommendation" WHERE "factoryRunId" = $1`,
      [id],
    )
  ).rows[0]?.status;
const input = {
  bank: 'generic',
  member: MEMBERS.demo,
  from: 'Everyday Checking',
  to: 'Rainy Day Savings',
};

describe('the gate', () => {
  it('keeps a table that fails its live run from a person', async () => {
    const broken: Table = structuredClone(bank1);
    broken.rows.find((r) => r.page === 'summary')!.shows = ['Balances at a glance'];
    const id = await aRun();
    const g = await gate(deps(), { factoryRunId: id, url: bank.url, table: broken, ...input });
    expect(g.recommendationId).toBeNull();
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]!.said).toMatch(/unknown_screen/);
    expect(await statusOf(id)).toBe('failed');
  }, 240_000);

  it('recommends a table that passes the plain run and the forced dialog', async () => {
    const id = await aRun();
    const g = await gate(deps(), { factoryRunId: id, url: bank.url, table: bank1, ...input });
    expect(g.runs.map((r) => [r.hazard, r.ok])).toEqual([
      [null, true],
      ['confirm-dialog', true],
    ]);
    expect(g.recommendationId).not.toBeNull();
    expect(await statusOf(id)).toBe('open');
  }, 240_000);
});
