// The hazard check against the real Generic Bank in Chrome: a recommendation a person approved in
// the Console becomes a candidate; its profile runs a control run and then every hazard the outcome
// table lists, forced alone, each judged by the table's result and the bank's own ledger; it goes
// on probation, and two clean probation runs promote it, so GET /banks lists the task. No model
// is involved and no key is used.
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';
import { recommendationPages } from '../../apps/console/src/pages/recommendations.js';
import {
  attemptOn,
  hazardCheck,
  HEALTHY,
  judge,
  profileFrom,
  type Sandbox,
} from '../../apps/factory/src/hazard-check.js';
import { candidate, checked, probationRun, versionOf } from '../../apps/factory/src/lifecycle.js';
import type { Claim } from '../../apps/factory/src/recommend.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { OPERATORS } from '../../apps/bank/src/seed.js';
import { OUTCOMES } from '../../packages/contracts/src/index.js';
import { GENERIC_BANK } from '../../packages/drivers/src/index.js';
import { oauth } from '../../packages/oauth/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { Browser } from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let browser: Browser;
let api: Awaited<ReturnType<typeof buildServer>>;
/** A fresh access token: the test can outlive one (they last 15 minutes) on a busy machine. */
let token: () => Promise<string>;
const console_ = Fastify();

beforeAll(async () => {
  [db, bank, browser] = await Promise.all([controlDb(), liveBank('generic'), Browser.launch()]);
  // No crawler serves Generic Bank's balance yet: the factory is to earn it.
  await db.query(`DELETE FROM "RegistryEvent" WHERE "driverId" = 'drv_generic_check_balance'`);
  await db.query(`DELETE FROM "DriverVersion" WHERE "driverId" = 'drv_generic_check_balance'`);
  await db.query(`DELETE FROM "Driver" WHERE id = 'drv_generic_check_balance'`);
  const o = oauth(db, 'k'.repeat(40));
  api = await buildServer({ oauth: o, sql: db, sealKey: 'r'.repeat(40), enqueue: async () => {} });
  const c = await o.createClient({ name: 't', scopes: ['tasks:read'], createdBy: 'a' });
  token = async () => (await o.issueDirect(c.clientId, 'the test')).access_token;
  recommendationPages(console_, {
    sql: db,
    whoIs: () => ({ email: 'ada@generic-bank.local', role: 'approver' }),
  });
  await console_.ready();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
  await api?.close();
  await console_.close();
  await db?.close();
});

const seen = (about: string, value: string): Claim => ({
  about,
  value,
  basis: 'seen',
  frames: ['f1'],
});
// The Supervisor's claims about Generic Bank, as its recommend tool kept them.
const CLAIMS: Claim[] = [
  seen('words.signIn', 'Sign In'),
  seen('words.memberSearch', 'Member Search'),
  seen('words.statements', 'Statements'),
  seen('words.transfer', 'Transfer Funds'),
  seen('words.continue', 'Continue'),
  seen('words.submitTransfer', 'Submit transfer'),
  {
    about: 'refusals.insufficient_funds',
    value: 'The amount is more than the available balance.',
    basis: 'guess',
    frames: ['f1'],
  },
];

const sandbox = (): Sandbox => ({
  browser,
  forced: (names) => bank.forced(names),
  credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
  code: async () => {
    const r = await bank.db.query<{ body: string }>(
      'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
    );
    return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
  },
  ledger: async (member, account) =>
    (await accountsOf(bank.db, member)).find((a) => a.nickname === account)?.availableCents ?? null,
});

const listed = async () =>
  (await api.inject({ url: '/banks', headers: { authorization: `Bearer ${await token()}` } }))
    .json<{ id: string; tasks: { task: string; crawlerVersion: string }[] }[]>()
    .find((b) => b.id === 'generic')!
    .tasks.filter((t) => t.task === 'check-balance');

describe('the hazard check, then probation, against Generic Bank', () => {
  it('passes every forced hazard before probation; two clean runs promote it into GET /banks', async () => {
    await db.query(
      `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
       VALUES ('fr1', 'generic', 'check-balance', 'build', 'REVIEW GATE', 'done')`,
    );
    await db.query(
      `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, claims) VALUES ('rec1', 'fr1', 'generic', $1)`,
      [JSON.stringify(CLAIMS)],
    );
    // A person approves it in the Console, the guess ticked.
    const approved = await console_.inject({
      method: 'POST',
      url: '/recommendations/rec1/approve',
      payload: { reason: 'every word is on the frames', tick: [7] },
    });
    expect(approved.json()).toEqual({ ok: true, status: 'approved' });

    const v = await candidate(db, 'rec1');
    expect(v.state).toBe('candidate');
    const attempt = attemptOn(sandbox(), profileFrom({ ...GENERIC_BANK, url: bank.url }, v.claims));
    const check = await hazardCheck(attempt, sandbox().ledger);
    expect(check.failed).toEqual([]);
    expect(check.verdicts).toHaveLength(1 + OUTCOMES['check-balance'].hazards.length);
    await checked(db, v.id, check);
    expect((await versionOf(db, v.id))!.state).toBe('probation');
    expect(await listed()).toEqual([]);

    for (let n = 0; n < 2; n++)
      await probationRun(db, v.id, await judge(attempt, sandbox().ledger, null, HEALTHY.expected));
    expect((await versionOf(db, v.id))!.state).toBe('promoted');
    expect(await listed()).toEqual([{ task: 'check-balance', crawlerVersion: 'v1' }]);
  }, 1_200_000);
});
