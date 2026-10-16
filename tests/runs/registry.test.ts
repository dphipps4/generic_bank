import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun } from '../../apps/runner/src/execute.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { answerHumanTask, createRun, resultOf } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The registry, as the Runner reads it: a run uses the version that serves the task, and says
// which. Generic Bank's hand-written driver meets the vendor's redesign and faults; it is taken out
// of service, a repair case opens, and the next run is refused before any browser opens. A
// repaired version, the approved claims over the hand-written profile, then serves, and the
// balance is read through the new notice and the new menu.

const KEY = 'k'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let before: LiveBank;
let after: LiveBank;
let bank: LiveBank;
let answering: NodeJS.Timeout;

beforeAll(async () => {
  [db, before, after] = await Promise.all([
    controlDb(),
    liveBank('generic'),
    liveBank('generic', { redesign: true }),
  ]);
  bank = before;
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
  // The person at the staff phone: answers each open staff-code task with the code the bank sent.
  answering = setInterval(async () => {
    const open = await db.query<{ id: string }>(
      `SELECT id FROM "HumanTask" WHERE status = 'open' AND kind = 'staff_code'`,
    );
    for (const t of open.rows) {
      const m = await bank.db.query<{ body: string }>(
        'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
      );
      const code = /(\d{6})/.exec(m.rows[0]?.body ?? '')?.[1];
      if (code) await answerHumanTask(db, t.id, code, 'staff@test', ANSWER_KEY);
    }
  }, 300);
}, 120_000);
afterAll(async () => {
  clearInterval(answering);
  await before?.close();
  await after?.close();
  await db?.close();
});

const deps = {
  store: memoryStore(),
  sealKey: KEY,
  answerKey: ANSWER_KEY,
  credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
};

async function checkBalance(o: { launch?: () => Promise<never> } = {}) {
  const { runId } = await createRun(
    db,
    {
      task: 'check-balance',
      bank: 'generic',
      clientId: null,
      inputs: { bank: 'generic', memberId: MEMBERS.demo, account: 'Everyday Checking' },
    },
    KEY,
  );
  await executeRun(runId, { ...deps, sql: db, ...o });
  const run = (
    await db.query<{ version: string | null }>(
      `SELECT "driverVersionId" AS version FROM "TaskRun" WHERE id = $1`,
      [runId],
    )
  ).rows[0]!;
  const steps = (
    await db.query<{ name: string }>(`SELECT name FROM "Step" WHERE "runId" = $1 ORDER BY seq`, [
      runId,
    ])
  ).rows.map((s) => s.name);
  return { runId, result: await resultOf(db, runId), version: run.version, steps };
}

const driver = async () =>
  (
    await db.query<{ state: string; active: string | null }>(
      `SELECT state::text, "activeVersionId" AS active FROM "Driver" WHERE tenant = 'generic' AND task = 'check-balance'`,
    )
  ).rows[0]!;

const available = async () =>
  (await accountsOf(bank.db, MEMBERS.demo)).find((a) => a.nickname === 'Everyday Checking')!
    .availableCents;

describe('the version that serves, and a fault that takes it out of service', () => {
  it('serves the hand-written version, demotes it on the redesign, and serves the repaired one', async () => {
    // Before the redesign: the hand-written version reads the balance, and the run says so.
    const ok = await checkBalance();
    expect(ok.result).toMatchObject({
      status: 'succeeded',
      data: { availableCents: await available() },
    });
    expect(ok.version).toBe('dv_generic_check_balance_1');

    // The vendor ships its redesign: the same request escalates at the screen it does not know.
    bank = after;
    await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
    const broke = await checkBalance();
    expect(broke.result).toMatchObject({ status: 'escalated', code: 'unknown_screen' });
    expect(broke.steps.at(-1)).toBe('unknown');

    // It is out of service with nothing to fall back to, and one repair case is open.
    expect(await driver()).toEqual({ state: 'demoted', active: null });
    const [v1] = (
      await db.query<{ state: string }>(
        `SELECT state::text FROM "DriverVersion" WHERE id = 'dv_generic_check_balance_1'`,
      )
    ).rows;
    expect(v1!.state).toBe('demoted');
    const cases = await db.query(
      `SELECT tenant, task, status, "runId", "versionId", "consecutiveFailures" FROM "RepairCase"`,
    );
    expect(cases.rows).toEqual([
      {
        tenant: 'generic',
        task: 'check-balance',
        status: 'open',
        runId: broke.runId,
        versionId: 'dv_generic_check_balance_1',
        consecutiveFailures: 1,
      },
    ]);
    const events = await db.query<{ toState: string; reason: string }>(
      `SELECT "toState"::text, reason FROM "RegistryEvent" WHERE "driverId" = 'drv_generic_check_balance' ORDER BY at`,
    );
    expect(events.rows.at(-1)).toEqual({
      toState: 'demoted',
      reason: `run ${broke.runId}: a screen the driver does not know; no version serves`,
    });

    // The next request is refused before any browser opens.
    let launched = 0;
    const refused = await checkBalance({ launch: async () => (launched++, null as never) });
    expect(refused.result).toMatchObject({ status: 'failed', code: 'no_driver' });
    expect(launched).toBe(0);

    // A repair, approved: only what changed, over the hand-written profile it starts from.
    const claims = [
      ['words.memberSearch', 'Member Lookup'],
      ['words.activity', 'History'],
      ['words.menu', 'Menu ▾'],
      ['words.dismiss', 'Continue to Online Banking'],
      ['screens.login.notice', "We've refreshed Online Banking"],
      ['screens.console.home', 'Open the Menu and choose'],
    ].map(([about, value]) => ({ about, value, basis: 'seen', frames: ['f1'] }));
    await db.query(
      `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status, "baseVersionId")
       VALUES ('fr_repair', 'generic', 'check-balance', 'repair', 'DONE', 'done', 'dv_generic_check_balance_1')`,
    );
    await db.query(
      `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, claims, status)
       VALUES ('rec_repair', 'fr_repair', 'generic', $1, 'approved')`,
      [JSON.stringify(claims)],
    );
    await db.query(
      `INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state, "sourceFactoryRunId")
       VALUES ('dv_repaired', 'drv_generic_check_balance', 2, 'x', 'profile', 'promoted', 'fr_repair')`,
    );
    await db.query(
      `UPDATE "Driver" SET state = 'promoted', "activeVersionId" = 'dv_repaired' WHERE id = 'drv_generic_check_balance'`,
    );

    // The same request reads the same balance, through the notice and the menu, on the new version.
    const back = await checkBalance();
    expect(back.result).toMatchObject({
      status: 'succeeded',
      data: { availableCents: await available() },
    });
    expect(back.version).toBe('dv_repaired');
    expect(back.steps).toEqual(expect.arrayContaining(['notice', 'console', 'balance']));
  }, 600_000);
});
