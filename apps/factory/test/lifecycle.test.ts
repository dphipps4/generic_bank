// The driver's states: an approved recommendation is a candidate; the hazard check, judged by the
// outcome table and the bank's ledger, puts it on probation or keeps it a candidate and names the
// hazard; two clean probation runs in a row promote it, and GET /banks then lists the task. The
// driver's runs here are a fake; the browser test runs the same check against the real bank.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HazardName, OUTCOMES } from '@gb/contracts';
import { banks } from '../../api/src/catalog.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { type Attempt, hazardCheck, HEALTHY, judge } from '../src/hazard-check.js';
import { candidate, checked, probationRun, versionOf } from '../src/lifecycle.js';
import type { Claim } from '../src/recommend.js';

const CENTS = 480_000;
const ledger = async () => CENTS;
const CLAIMS: Claim[] = [{ about: 'words.signIn', value: 'Log In', basis: 'seen', frames: ['f1'] }];

/** A driver that gives the outcome table's result for every hazard but the ones it breaks on. */
const driver =
  (breaks: Partial<Record<HazardName, 'unknown_screen'>> = {}, cents = CENTS): Attempt =>
  async ([hazard]) => {
    if (hazard && breaks[hazard]) return { status: 'escalated', code: breaks[hazard] };
    const want = hazard
      ? OUTCOMES['check-balance'].hazards.find((c) => c.hazard === hazard)!.expected
      : HEALTHY.expected;
    return want.status === 'succeeded'
      ? {
          status: 'succeeded',
          data: {
            accountLabel: 'Share ****1234-S01',
            availableCents: cents,
            currentCents: cents,
            asOf: '',
          },
        }
      : { status: want.status as 'failed', code: want.code! };
  };

let db: Awaited<ReturnType<typeof controlDb>>;
beforeEach(async () => {
  db = await controlDb();
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ('run1', 'example', 'check-balance', 'build', 'REVIEW GATE', 'done')`,
  );
  await db.query(
    `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, claims) VALUES ('rec1', 'run1', 'example', $1)`,
    [JSON.stringify(CLAIMS)],
  );
});
afterEach(() => db.close());

const approve = () =>
  db.query(
    `UPDATE "Recommendation" SET status = 'approved', "decidedBy" = 'ada' WHERE id = 'rec1'`,
  );
const served = async () => (await banks(db)).find((b) => b.id === 'example')!.tasks;
const events = async () =>
  (
    await db.query<{ fromState: string; toState: string; reason: string }>(
      `SELECT "fromState", "toState", reason FROM "RegistryEvent" e JOIN "Driver" d ON d.id = e."driverId"
        WHERE d.tenant = 'example' ORDER BY e.at, e.ctid`,
    )
  ).rows;

describe('the hazard check', () => {
  it('passes a profile that gives the table’s result for the control run and every hazard', async () => {
    const c = await hazardCheck(driver(), ledger);
    expect(c.passed).toBe(true);
    expect(c.failed).toEqual([]);
    expect(c.verdicts.map((v) => v.hazard)).toEqual([
      null,
      ...OUTCOMES['check-balance'].hazards.map((h) => h.hazard),
    ]);
  });

  it('names the hazard a profile breaks on, and what it gave', async () => {
    const c = await hazardCheck(driver({ promo: 'unknown_screen' }), ledger);
    expect(c.failed).toEqual(['promo']);
    expect(c.verdicts.find((v) => v.hazard === 'promo')).toEqual({
      hazard: 'promo',
      expected: 'succeeded',
      got: 'escalated: unknown_screen',
      passed: false,
    });
  });

  it('takes the bank’s ledger over the crawler’s word, and stops when the control run fails', async () => {
    const c = await hazardCheck(driver({}, 100), ledger);
    expect(c).toEqual({
      passed: false,
      failed: ['control'],
      verdicts: [
        {
          hazard: null,
          expected: 'succeeded',
          got: "succeeded, but it read 100 cents where the bank's ledger has 480000",
          passed: false,
        },
      ],
    });
  });
});

describe('candidate, probation, promoted', () => {
  it('makes a candidate only of a recommendation a person approved', async () => {
    await expect(candidate(db, 'rec1')).rejects.toThrow(/is not approved by a person/);
    await approve();
    const v = await candidate(db, 'rec1');
    expect(v).toMatchObject({
      tenant: 'example',
      task: 'check-balance',
      version: 1,
      state: 'candidate',
    });
    expect((await candidate(db, 'rec1')).id).toBe(v.id);
    expect(await events()).toEqual([
      { fromState: 'draft', toState: 'candidate', reason: 'v1: recommendation rec1 approved' },
    ]);
  });

  it('keeps a profile that fails one hazard a candidate, and says which', async () => {
    await approve();
    const v = await candidate(db, 'rec1');
    await checked(db, v.id, await hazardCheck(driver({ 'late-rows': 'unknown_screen' }), ledger));
    expect((await versionOf(db, v.id))!.state).toBe('candidate');
    await expect(
      probationRun(db, v.id, await judge(driver(), ledger, null, HEALTHY.expected)),
    ).rejects.toThrow(/is not on probation/);
    expect((await events()).at(-1)).toEqual({
      fromState: 'candidate',
      toState: 'candidate',
      reason: 'v1: failed: late-rows gave escalated: unknown_screen, expected succeeded',
    });
    expect(await served()).toEqual([]);
  });

  it('puts a profile that passes every hazard on probation; two clean runs promote it into GET /banks', async () => {
    await approve();
    const v = await candidate(db, 'rec1');
    await checked(db, v.id, await hazardCheck(driver(), ledger));
    expect((await versionOf(db, v.id))!.state).toBe('probation');
    const clean = () => judge(driver(), ledger, null, HEALTHY.expected);
    await probationRun(db, v.id, await clean());
    expect(await served()).toEqual([]);
    await probationRun(db, v.id, await clean());
    expect((await versionOf(db, v.id))!.state).toBe('promoted');
    expect(await served()).toEqual([{ task: 'check-balance', crawlerVersion: 'v1' }]);
    expect((await events()).map((e) => e.toState)).toEqual(['candidate', 'probation', 'promoted']);
  });

  it('counts clean runs in a row, and four runs without two return it to candidate', async () => {
    await approve();
    const v = await candidate(db, 'rec1');
    await checked(db, v.id, await hazardCheck(driver(), ledger));
    const clean = await judge(driver(), ledger, null, HEALTHY.expected);
    const fault = await judge(driver({}, 1), ledger, null, HEALTHY.expected);
    for (const r of [clean, fault, clean]) await probationRun(db, v.id, r);
    expect((await versionOf(db, v.id))!.state).toBe('probation');
    await probationRun(db, v.id, fault);
    expect((await versionOf(db, v.id))!.state).toBe('candidate');
    expect((await events()).at(-1)!.reason).toMatch(
      /^v1: 4 probation runs without 2 clean in a row; the last gave succeeded, but it read 1 cents/,
    );
    expect(await served()).toEqual([]);
  });
});
