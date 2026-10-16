import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer as buildApi } from '../../apps/api/src/server.js';
import { recommendationPages } from '../../apps/console/src/pages/recommendations.js';
import { gate } from '../../apps/factory/src/gate.js';
import { gateway } from '../../apps/factory/src/gateway.js';
import { memoryClient } from '../../apps/factory/src/memory.js';
import type { Sandbox } from '../../apps/factory/src/hazard-check.js';
import { sqlLedger } from '../../apps/factory/src/ledger.js';
import { DEFAULT_ROLES } from '../../apps/factory/test/fakes.js';
import type { Claim } from '../../apps/factory/src/recommend.js';
import { factoryRun, type Mode } from '../../apps/factory/src/run.js';
import { buildServer } from '../../apps/factory/src/server.js';
import {
  live,
  type Recorded,
  type Request,
  unpictured,
  upstreamFor,
} from '../../apps/factory/src/upstream.js';
import { executeRun } from '../../apps/runner/src/execute.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { oauth } from '../../packages/oauth/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { answerHumanTask, createRun, resultOf } from '../../packages/runs/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';
import { memoryService } from '../support/memory.js';
import { scripted } from '../support/scripted.js';

// The demo, end to end, in mock mode: Generic Bank's hand-written driver reads a balance; the vendor
// ships its redesign and the same request escalates at the screen it does not know; the driver is
// taken out of service and a repair case opens. The factory repairs it from the case (the
// Supervisor and the Scout replaying the recording kept for a repair at this bank, through the
// gateway, from memory's knowledge pack) and writes what it taught to memory; a person approves in
// the Console, the hazard check and probation run against the redesigned bank, and the repaired
// version is promoted, which memory reads as the proof of the lesson the repair saw. The same
// request then reads the same balance through the new notice and the new menu, on the new version.
// Onboarding a bank reaches its review the same way. No key is used and nothing reaches a model.
//
// FACTORY_RECORD=1 records the scripted models through the gateway instead, and keeps each run's
// recording in apps/factory/recordings, where `just onboard` and `just repair` replay it with no key.

const RECORDINGS = 'apps/factory/recordings';
const RECORD = process.env.FACTORY_RECORD === '1';
const TOKEN = 'gateway-token-for-tests-0123456789abcdef';
const KEY = 'k'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);

let db: Awaited<ReturnType<typeof controlDb>>;
let before: LiveBank;
let after: LiveBank;
let bank: LiveBank;
let browser: Browser;
let answering: NodeJS.Timeout;
let factory: ReturnType<typeof buildServer>;
let factoryUrl: string;
let dir: string;
let api: Awaited<ReturnType<typeof buildApi>>;
/** A fresh access token: the test can outlive one (they last 15 minutes) on a busy machine. */
let apiToken: () => Promise<string>;
const store = memoryStore();
const consoleApp = Fastify();
let memory: Awaited<ReturnType<typeof memoryService>>;

beforeAll(async () => {
  [db, before, after, memory] = await Promise.all([
    controlDb(),
    liveBank('generic'),
    liveBank('generic', { redesign: true }),
    memoryService(),
  ]);
  bank = before;
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
  browser = await Browser.launch({ hosts: [new URL(before.url).host, new URL(after.url).host] });
  dir = await mkdtemp(join(tmpdir(), 'gb-repair-'));
  // The gateway, as the factory serves it: the scripted models recorded, or the recordings replayed.
  factory = buildServer({
    gateway: gateway({
      ledger: sqlLedger(db),
      upstream: RECORD ? live(scripted('generic', MEMBERS.demo), dir) : upstreamFor({}, RECORDINGS),
    }),
    token: TOKEN,
    mode: RECORD ? 'live' : 'mock',
  });
  await factory.listen({ host: '127.0.0.1', port: 0 });
  factoryUrl = `http://127.0.0.1:${(factory.server.address() as AddressInfo).port}`;
  recommendationPages(consoleApp, {
    sql: db,
    whoIs: () => ({ email: 'ada@generic-bank.local', role: 'approver' }),
  });
  await consoleApp.ready();
  const o = oauth(db, KEY);
  api = await buildApi({ oauth: o, sql: db, sealKey: KEY, enqueue: async () => {} });
  const c = await o.createClient({ name: 't', scopes: ['tasks:read'], createdBy: 'a' });
  apiToken = async () => (await o.issueDirect(c.clientId, 'the test')).access_token;
  // The person at the staff phone: answers each staff-code task, the Runner's and the Scout's,
  // with the code the bank sent, through the Console's inbox.
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
  await browser?.close();
  await factory?.close();
  await api?.close();
  await consoleApp.close();
  await before?.close();
  await after?.close();
  await memory?.close();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

/** A factory run, as `just onboard` or `just repair` starts it; recorded, its recording is kept. */
async function factoryRunAt(mode: Mode) {
  const out = await factoryRun(
    {
      sql: db,
      store,
      browser,
      factoryUrl,
      gatewayToken: TOKEN,
      roles: DEFAULT_ROLES,
      credentials: { operatorId: OPERATORS.service.id, password: PASSWORDS.service },
      answerKey: ANSWER_KEY,
      member: MEMBERS.demo,
      memory: memoryClient(memory.factory),
    },
    { bank: 'generic', mode },
  );
  if (RECORD) {
    // Kept as the replay reads it: the agents' own turns, and only the shape of what the bank showed.
    const lines = (await readFile(join(dir, `${out.runId}.jsonl`), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Recorded)
      .map((l) => JSON.stringify({ ...l, request: unpictured(l.request) as Request }));
    await writeFile(join(RECORDINGS, `${mode}-generic.jsonl`), `${lines.join('\n')}\n`);
  }
  return out;
}

/** The lessons a run proposed or added its evidence to, each at its current version, seen first. */
const lessonsOf = async (runId: string) =>
  (
    await memory.db.query<{ seen: boolean; state: string; role: string }>(
      `SELECT v.seen, v.state::text AS state, v.role::text AS role
         FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current
        WHERE l.id IN (SELECT "lessonId" FROM "LessonVersion" WHERE "runId" = $1)
        ORDER BY v.seen DESC`,
      [runId],
    )
  ).rows;

async function checkBalance() {
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
  let browsers = 0;
  await executeRun(runId, {
    sql: db,
    store,
    sealKey: KEY,
    answerKey: ANSWER_KEY,
    credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
    launch: () => (browsers++, Browser.launch()),
  });
  const version = (
    await db.query<{ v: string | null }>(
      `SELECT "driverVersionId" AS v FROM "TaskRun" WHERE id = $1`,
      [runId],
    )
  ).rows[0]!.v;
  const steps = (
    await db.query<{ name: string }>(`SELECT name FROM "Step" WHERE "runId" = $1 ORDER BY seq`, [
      runId,
    ])
  ).rows.map((s) => s.name);
  return { runId, result: await resultOf(db, runId), version, steps, browsers };
}

const ledger = async (member: string, account: string) =>
  (await accountsOf(bank.db, member)).find((a) => a.nickname === account)?.availableCents ?? null;

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
  ledger,
});

const recommendationOf = async (runId: string) =>
  (
    await db.query<{ id: string; status: string; claims: Claim[] }>(
      `SELECT id, status, claims FROM "Recommendation" WHERE "factoryRunId" = $1`,
      [runId],
    )
  ).rows[0]!;

/** Each claim marked seen is on the frame of the run it cites. */
async function onItsFrames(runId: string, claims: Claim[]) {
  for (const c of claims.filter((x) => x.basis === 'seen'))
    for (const r of c.frames) {
      const m = JSON.parse(
        (await store.get(`runs/${runId}/${r.slice(1).padStart(3, '0')}.json`))!.toString(),
      ) as { controls: { name: string }[]; texts: { text: string }[] };
      const words = [...m.controls.map((x) => x.name), ...m.texts.map((t) => t.text)];
      expect(
        words.some((w) => w.includes(c.value)),
        `${c.about} on ${r}`,
      ).toBe(true);
    }
}

describe('a bank redesigns, the crawl breaks, the factory repairs it', () => {
  it('breaks on the redesign, is taken out of service, is repaired, approved, checked, promoted and recovers', async () => {
    // The hand-written driver reads the balance.
    const first = await checkBalance();
    expect(first.result).toMatchObject({
      status: 'succeeded',
      data: { availableCents: await ledger(MEMBERS.demo, 'Everyday Checking') },
    });
    expect(first.version).toBe('dv_generic_check_balance_1');

    // The vendor's redesign: the same request stops, safely, at the page it has never seen.
    bank = after;
    await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
    const broke = await checkBalance();
    expect(broke.result).toMatchObject({ status: 'escalated', code: 'unknown_screen' });

    // That fault takes the driver out of service, and a repair case opens; the next request is
    // refused before any browser opens.
    const refused = await checkBalance();
    expect(refused.result).toMatchObject({ status: 'failed', code: 'no_driver' });
    expect(refused.browsers).toBe(0);
    const [open] = (
      await db.query<{ runId: string; status: string }>(
        `SELECT "runId", status FROM "RepairCase" WHERE tenant = 'generic' AND task = 'check-balance'`,
      )
    ).rows;
    expect(open).toEqual({ runId: broke.runId, status: 'open' });

    // The factory repairs it: only what changed, every claim on a frame of the repair run.
    const { runId, recommendationId } = await factoryRunAt('repair');
    const rec = await recommendationOf(runId);
    expect(rec.claims.map((c) => c.about)).toEqual([
      'words.memberSearch',
      'words.activity',
      'words.menu',
      'words.dismiss',
      'screens.login.notice',
      'screens.console.home',
    ]);
    await onItsFrames(runId, rec.claims);
    expect(
      (await db.query(`SELECT mode, "baseVersionId" FROM "FactoryRun" WHERE id = $1`, [runId]))
        .rows[0],
    ).toEqual({ mode: 'repair', baseVersionId: 'dv_generic_check_balance_1' });

    // A person approves it in the Console; the gate runs: the hazard check, then probation.
    const approved = await consoleApp.inject({
      method: 'POST',
      url: `/recommendations/${recommendationId}/approve`,
      payload: { reason: 'the new words are on the frames' },
    });
    expect(approved.json()).toEqual({ ok: true, status: 'approved' });
    // One hazard of each kind of result is enough here; the factory's real gate runs them all.
    const v = await gate(
      {
        sql: db,
        sandbox: sandbox(),
        memory: memoryClient(memory.factory),
        hazards: ['promo', 'permission-denial', 'service-unavailable'],
      },
      recommendationId!,
    );
    expect(v.state).toBe('promoted');
    // Memory read the promotion from its probation runs: the lesson the repair saw is confirmed,
    // and its guess, the onboarding's guess too, stays a proposal.
    expect(await lessonsOf(runId)).toEqual([
      expect.objectContaining({ seen: true, state: 'confirmed', role: 'system' }),
      expect.objectContaining({ seen: false, state: 'proposed', role: 'factory' }),
    ]);
    const banks = (
      await api.inject({ url: '/banks', headers: { authorization: `Bearer ${await apiToken()}` } })
    ).json<{ id: string; tasks: { task: string; crawlerVersion: string }[] }[]>();
    expect(banks.find((b) => b.id === 'generic')!.tasks).toContainEqual({
      task: 'check-balance',
      crawlerVersion: `v${v.version}`,
    });
    expect(
      (await db.query(`SELECT status FROM "RepairCase" WHERE "runId" = $1`, [broke.runId])).rows,
    ).toEqual([{ status: 'closed' }]);

    // The same request reads the same balance again, through the notice and the menu, on the
    // repaired version, and no model runs in it.
    const calls = (await db.query(`SELECT count(*)::int AS n FROM "ModelCall"`)).rows[0];
    const back = await checkBalance();
    expect(back.result).toMatchObject({
      status: 'succeeded',
      data: { availableCents: await ledger(MEMBERS.demo, 'Everyday Checking') },
    });
    expect(back.version).toBe(v.id);
    expect(back.steps).toEqual(expect.arrayContaining(['notice', 'console', 'balance']));
    expect((await db.query(`SELECT count(*)::int AS n FROM "ModelCall"`)).rows[0]).toEqual(calls);
  }, 240_000);
});
