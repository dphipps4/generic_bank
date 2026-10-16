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
import type { Sandbox } from '../../apps/factory/src/hazard-check.js';
import { sqlLedger } from '../../apps/factory/src/ledger.js';
import { DEFAULT_ROLES } from '../../apps/factory/src/models.js';
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
import { fakeModels } from '../../apps/factory/test/fakes.js';
import { executeRun } from '../../apps/runner/src/execute.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { oauth } from '../../packages/oauth/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { answerHumanTask, createRun, resultOf } from '../../packages/runs/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The demo, end to end, in mock mode: Generic Bank's hand-written driver reads a balance; the vendor
// ships its redesign and the same request escalates at the screen it does not know; the driver is
// taken out of service and a repair case opens. The factory repairs it from the case (the
// Supervisor and the Scout replaying the recording kept for a repair at this bank, through the
// gateway), a person approves in the Console, the hazard check and probation run against the
// redesigned bank, and the repaired version is promoted. The same request then reads the same
// balance through the new notice and the new menu, on the new version. Onboarding a bank reaches
// its review the same way. No key is used and nothing reaches a model.
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
let apiToken: string;
const store = memoryStore();
const consoleApp = Fastify();

/** The page as a tool result or an instruction shows it to the model. */
type View = {
  controls: { ref: string; role: string; name: string; options?: string[] }[];
  texts: string[];
};
const pageOf = (text: string): View | undefined => {
  try {
    return JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as View;
  } catch {
    return undefined;
  }
};
const has = (p: View, name: string) => p.controls.some((c) => c.name === name);
const ref = (p: View, role: string | null, name?: string) => {
  const c = p.controls.findLast(
    (x) => (role === null || x.role === role) && (name === undefined || x.name === name),
  );
  if (!c) throw new Error(`no ${role ?? 'control'} ${name ?? ''} on ${JSON.stringify(p)}`);
  return c.ref;
};
const lists = (p: View) => p.controls.filter((c) => c.options);
const SEARCH = `Search for member ${MEMBERS.demo}.`;
const FILL = 'Choose the first account to send from and the second to receive, then type 1.00.';
type Use = { tool: string; input: Record<string, unknown> };

/** The Scout's side of the script: what its model does for each instruction. */
const PLANS: Record<string, ((p: View) => Use)[]> = {
  'Sign in as the staff service account.': [
    (p) => ({
      tool: 'browser_type_credential',
      input: { ref: ref(p, 'textbox'), credential: 'user_id' },
    }),
    (p) => ({
      tool: 'browser_type_credential',
      input: { ref: ref(p, 'password'), credential: 'password' },
    }),
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Sign In') } }),
  ],
  'Have the code sent.': [
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Send code') } }),
  ],
  'Enter the code the bank sent.': [
    (p) => ({ tool: 'browser_enter_code', input: { ref: ref(p, 'textbox') } }),
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Verify') } }),
  ],
  'Press Continue to Online Banking.': [
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Continue to Online Banking') } }),
  ],
  'Open the Menu.': [(p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Menu ▾') } })],
  'Open Member Lookup.': [
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Member Lookup') } }),
  ],
  'Open Member Search.': [
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Member Search') } }),
  ],
  [SEARCH]: [
    (p) => ({ tool: 'browser_type', input: { ref: ref(p, 'textbox'), text: MEMBERS.demo } }),
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Search') } }),
  ],
  'Open the member.': [(p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Open') } })],
  'Open Statements on the first account.': [
    (p) => ({
      tool: 'browser_click',
      input: { ref: p.controls.find((c) => c.name === 'Statements')!.ref },
    }),
  ],
  'Open Transfer Funds.': [
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Transfer Funds') } }),
  ],
  [FILL]: [
    (p) => ({ tool: 'browser_choose', input: { ref: lists(p)[0]!.ref, option: 2 } }),
    (p) => ({ tool: 'browser_choose', input: { ref: lists(p)[1]!.ref, option: 3 } }),
    (p) => ({ tool: 'browser_type', input: { ref: ref(p, 'textbox'), text: '1.00' } }),
    (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Continue') } }),
  ],
};

/** The Supervisor's side: the next step from the goal and the latest page, on either look. */
function decide(goal: string, p: View): string {
  if (p.controls.some((c) => c.role === 'password')) return 'Sign in as the staff service account.';
  if (has(p, 'Send code')) return 'Have the code sent.';
  if (has(p, 'Verify')) return 'Enter the code the bank sent.';
  if (has(p, 'Continue to Online Banking')) return 'Press Continue to Online Banking.';
  const summary = p.texts.some((t) => t.includes('Available balance'));
  const search = has(p, 'Open')
    ? 'Open the member.'
    : has(p, 'Search')
      ? SEARCH
      : has(p, 'Member Lookup')
        ? 'Open Member Lookup.'
        : has(p, 'Menu ▾')
          ? 'Open the Menu.'
          : 'Open Member Search.';
  if (goal.includes('balances')) return summary ? 'stop' : search;
  if (goal.includes('statements')) {
    if (has(p, 'Show')) return 'stop';
    return summary ? 'Open Statements on the first account.' : search;
  }
  if (p.texts.includes('Review transfer')) return 'stop';
  if (lists(p).length === 2) return FILL;
  return summary ? 'Open Transfer Funds.' : search;
}

/**
 * The Supervisor's recommendation, from the run's frames: at onboarding, the bank's words, each on
 * the first frame that shows it, and a refusal it never made as a guess; at a repair, only what
 * changed, each on the frame of this run that shows it.
 */
function recommending(text: string, repair: boolean, results: number) {
  if (results) return { text: 'Recommended.' };
  const frames = [...text.matchAll(/^(f\d+): (\{.*\})$/gm)].map(([, r, json]) => ({
    ref: r!,
    ...(JSON.parse(json!) as { controls: string[]; texts: string[] }),
  }));
  const where = (pred: (f: (typeof frames)[number]) => boolean, what: string) => {
    const f = frames.find(pred);
    if (!f) throw new Error(`no frame shows ${what}`);
    return f.ref;
  };
  const control = (about: string, value: string): Claim => ({
    about,
    value,
    basis: 'seen',
    frames: [where((f) => f.controls.includes(value), value)],
  });
  const text_ = (about: string, value: string): Claim => ({
    about,
    value,
    basis: 'seen',
    frames: [where((f) => f.texts.some((t) => t.includes(value)), value)],
  });
  const claims = repair
    ? [
        control('words.memberSearch', 'Member Lookup'),
        control('words.activity', 'History'),
        control('words.menu', 'Menu ▾'),
        control('words.dismiss', 'Continue to Online Banking'),
        text_('screens.login.notice', "We've refreshed Online Banking"),
        text_('screens.console.home', 'Open the Menu and choose'),
      ]
    : [
        control('words.signIn', 'Sign In'),
        control('words.memberSearch', 'Member Search'),
        control('words.statements', 'Statements'),
        control('words.transfer', 'Transfer Funds'),
        control('words.continue', 'Continue'),
        text_('screens.member.summary', 'Available balance'),
        {
          about: 'refusals.insufficient_funds',
          value: 'The amount is more than the available balance.',
          basis: 'guess',
          frames: [where((f) => f.controls.includes('Continue'), 'the transfer form')],
        } satisfies Claim,
      ];
  return { tool: 'recommend', input: { claims } };
}

/** Both roles' models, scripted: the Supervisor answers in its form, the Scout follows its plan. */
function scripted() {
  return fakeModels((_provider, r) => {
    const said = r.items.flatMap((x) => ('user' in x ? [x.user] : []));
    const results = r.items.filter((x) => 'result' in x).length;
    if (r.system.includes('with the recommend tool'))
      return recommending(said[0]!, r.system.includes('the bank has changed'), results);
    if (r.system.startsWith('You are the Supervisor')) {
      const text = said[0]!;
      const goal = /^Goal: (.*)$/m.exec(text)![1]!;
      const [, at, json] = /Latest frame, (f\d+):\n(.*)$/s.exec(text)!;
      return {
        text: JSON.stringify({
          next: decide(goal, JSON.parse(json!) as View),
          reason: `the page in ${at} shows where the Scout is`,
          frames: [at],
        }),
      };
    }
    const at = r.items.findLastIndex((x) => 'user' in x && PLANS[x.user.split('\n')[0]!]);
    const instruction = (r.items[at] as { user: string }).user;
    const plan = PLANS[instruction.split('\n')[0]!]!;
    const done = r.items.slice(at + 1).flatMap((x) => ('result' in x ? [x.result] : []));
    const shown = done.map(pageOf).filter(Boolean).at(-1) ?? pageOf(instruction)!;
    return done.length < plan.length ? plan[done.length]!(shown) : { text: 'Done.' };
  });
}

beforeAll(async () => {
  [db, before, after] = await Promise.all([
    controlDb(),
    liveBank('generic'),
    liveBank('generic', { redesign: true }),
  ]);
  bank = before;
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
  browser = await Browser.launch({ hosts: [new URL(before.url).host, new URL(after.url).host] });
  dir = await mkdtemp(join(tmpdir(), 'gb-repair-'));
  // The gateway, as the factory serves it: the scripted models recorded, or the recordings replayed.
  factory = buildServer({
    gateway: gateway({
      ledger: sqlLedger(db),
      upstream: RECORD ? live(scripted(), dir) : upstreamFor({}, RECORDINGS),
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
  apiToken = (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
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
  it('onboards a bank: its three goals reached, its profile recommended and awaiting a person', async () => {
    const { runId, recommendationId } = await factoryRunAt('build');
    const rec = await recommendationOf(runId);
    expect(rec.id).toBe(recommendationId);
    expect(rec.status).toBe('open');
    expect(rec.claims.map((c) => c.basis)).toEqual([...Array<string>(6).fill('seen'), 'guess']);
    await onItsFrames(runId, rec.claims);
    const run = (
      await db.query(`SELECT mode, phase, status FROM "FactoryRun" WHERE id = $1`, [runId])
    ).rows[0];
    expect(run).toEqual({ mode: 'build', phase: 'REVIEW GATE', status: 'review' });
    // Nothing moved money: the transfer stopped at the bank's review page.
    expect((await before.db.query('SELECT 1 FROM transfers')).rows).toHaveLength(0);
  }, 600_000);

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
    const v = await gate({ sql: db, sandbox: sandbox() }, recommendationId!);
    expect(v.state).toBe('promoted');
    const banks = (
      await api.inject({ url: '/banks', headers: { authorization: `Bearer ${apiToken}` } })
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
  }, 1_200_000);
});
