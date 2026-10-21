// The gate against bank 1, with no model: a table runs live through the crawler's loop before a
// person sees it, on exactly what an approval would promote. One that fails never reaches a
// person's approval; one that passes the plain run, the run from a trusted browser and the run with
// the confirmation dialog forced waits for it.
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
/** Each replay's task run, as the Console shows it: none is left running. */
const replaysOf = async (id: string) =>
  (
    await db.query<{ id: string; status: string; settled: boolean }>(
      `SELECT id, status, "settledAt" IS NOT NULL AS settled FROM "TaskRun" WHERE id LIKE $1 ORDER BY "startedAt"`,
      [`${id}-%`],
    )
  ).rows.map((r) => [r.id.slice(id.length + 1), r.status, r.settled]);
/** The run the bank's open repair case names: where the table last broke. */
const caseRun = async () =>
  (
    await db.query<{ runId: string }>(
      `SELECT "runId" FROM "RepairCase" WHERE tenant = 'generic' AND task = 'check-balance' AND status = 'open'`,
    )
  ).rows[0]?.runId;
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
    expect(await caseRun()).toBe(`${id}-check`);
    expect(await replaysOf(id)).toEqual([['check', 'failed', true]]);
  }, 240_000);

  it('recommends a table that passes the plain run and the forced dialog', async () => {
    const id = await aRun();
    const g = await gate(deps(), { factoryRunId: id, url: bank.url, table: bank1, ...input });
    expect(g.runs.map((r) => [r.hazard, !!r.trusted, r.ok])).toEqual([
      [null, false, true],
      [null, true, true],
      ['confirm-dialog and promo', false, true],
    ]);
    // The balance, the review and the activity, each checked.
    for (const r of g.runs)
      expect(r.said).toMatch(
        /^the balance read \d+ cents; the review read \$1\.00; the activity opened/,
      );
    expect(g.recommendationId).not.toBeNull();
    expect(await statusOf(id)).toBe('open');
    expect(await replaysOf(id)).toEqual([
      ['check', 'succeeded', true],
      ['trusted', 'succeeded', true],
      ['hazards', 'succeeded', true],
    ]);
  }, 240_000);

  it('fails a route whose returning sign-in serves the transfer and the activity alone, from a trusted browser', async () => {
    // As run 29's route was: it starts at the sign-in page, as a learned route does, and its
    // returning sign-in holds steps for the transfer and the activity only. The plain run passes:
    // the balance meets the full sign-in, the rest the returning one. From a browser the bank
    // trusts, the balance has nothing to do there.
    const t: Table = structuredClone(bank1);
    t.home = 'signin';
    const back = t.rows.find((r) => r.page === 'welcome back')!;
    back.do = { transfer: back.do.any!, history: back.do.any! };
    const id = await aRun();
    const g = await gate(deps(), { factoryRunId: id, url: bank.url, table: t, ...input });
    expect(g.runs.map((r) => [!!r.trusted, r.ok])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(g.runs[1]!.said).toMatch(/stuck \(nothing to do on the welcome back page\)/);
    expect(g.recommendationId).toBeNull();
    // The case names the replay that failed, so a repair starts there.
    expect(await caseRun()).toBe(`${id}-trusted`);
    expect(await statusOf(id)).toBe('failed');
  }, 240_000);

  it('passes a route that covers only the balance on the balance alone', async () => {
    const t: Table = structuredClone(bank1);
    const ends = t.ends as Partial<Table['ends']>;
    delete ends.transfer;
    delete ends.history;
    t.rows = t.rows.filter(
      (r) => !['transfer form', 'review', 'posted', 'activity'].includes(r.page),
    );
    for (const r of t.rows) {
      delete r.do.transfer;
      delete r.do.history;
    }
    const id = await aRun();
    const g = await gate(deps(), { factoryRunId: id, url: bank.url, table: t, ...input });
    expect(g.runs.map((r) => [r.hazard, !!r.trusted, r.ok])).toEqual([
      [null, false, true],
      [null, true, true],
      ['confirm-dialog and promo', false, true],
    ]);
    for (const r of g.runs) expect(r.said).toMatch(/^the balance read \d+ cents$/);
    expect(g.recommendationId).not.toBeNull();
  }, 240_000);

  it('fails a route whose activity end is not the activity', async () => {
    const t: Table = structuredClone(bank1);
    t.ends.history = 'posted';
    const id = await aRun();
    const g = await gate(deps(), { factoryRunId: id, url: bank.url, table: t, ...input });
    expect(g.recommendationId).toBeNull();
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]!.ok).toBe(false);
    expect(g.runs[0]!.said).toMatch(/stuck \(nothing to do on the activity page\)/);
    expect(await statusOf(id)).toBe('failed');
  }, 240_000);

  it('fails a route that covers nothing an approval would promote, without running it', async () => {
    const t: Table = structuredClone(bank1);
    const ends = t.ends as Partial<Table['ends']>;
    delete ends.balance;
    delete ends.history;
    const id = await aRun();
    const g = await gate(deps(), { factoryRunId: id, url: bank.url, table: t, ...input });
    expect(g.recommendationId).toBeNull();
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]!.said).toMatch(/covers nothing a person could approve/);
    expect(await statusOf(id)).toBe('failed');
  });
});
