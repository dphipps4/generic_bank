import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labRoutes } from '../../apps/api/src/lab.js';
import { buildServer } from '../../apps/api/src/server.js';
import { inboxPages } from '../../apps/console/src/pages/inbox.js';
import { labPages, throughTheApi } from '../../apps/console/src/pages/lab.js';
import { executeRun, type RunDeps } from '../../apps/runner/src/execute.js';
import { withForcedHazards } from '../../apps/runner/src/forced.js';
import { OUTCOMES } from '../../packages/contracts/src/index.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { oauth } from '../../packages/oauth/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { resultOf } from '../../packages/runs/src/index.js';
import { OPERATORS } from '../../apps/bank/src/seed.js';
import { HMAC, type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The hazard lab, end to end: an admin starts a run in the Console, the Console starts it through
// the Task API's lab door, the Runner signs the forced hazard into its header, the real Generic Bank
// obeys it, and the run ends in the result the lab showed beside the hazard.

const SEAL = 's'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let answering: NodeJS.Timeout;
let api: Awaited<ReturnType<typeof buildServer>>;
const consoleApp = Fastify();
const runs = new Map<string, Promise<unknown>>();

beforeAll(async () => {
  [db, bank] = await Promise.all([controlDb(), liveBank('generic')]);
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
  const tokens = oauth(db, 't'.repeat(40));
  const deps: RunDeps = {
    sql: db,
    store: memoryStore(),
    sealKey: SEAL,
    answerKey: ANSWER_KEY,
    credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
  };
  // The queue, in-process: the Runner takes the run as its workflow would.
  const enqueue = async (runId: string) =>
    void runs.set(
      runId,
      withForcedHazards(runId, deps, HMAC).then((d) => executeRun(runId, d)),
    );
  api = await buildServer({ oauth: tokens, sql: db, sealKey: SEAL, enqueue });
  labRoutes(api, { sql: db, sealKey: SEAL, enqueue });
  await api.listen({ host: '127.0.0.1', port: 0 });
  const port = (api.server.address() as { port: number }).port;

  const admin = () => ({ email: 'ada@generic-bank.local', role: 'admin' as const });
  labPages(consoleApp, {
    sql: db,
    whoIs: admin,
    start: throughTheApi({ sql: db, tokens, apiUrl: `http://127.0.0.1:${port}` }),
  });
  inboxPages(consoleApp, { sql: db, answerKey: ANSWER_KEY, whoIs: admin });
  await consoleApp.ready();
  // The person at the staff phone answers each staff code in the inbox.
  answering = setInterval(async () => {
    const open = await db.query<{ id: string }>(
      `SELECT id FROM "HumanTask" WHERE status = 'open' AND kind = 'staff_code'`,
    );
    for (const t of open.rows) {
      const m = await bank.db.query<{ body: string }>(
        'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
      );
      const code = /(\d{6})/.exec(m.rows[0]?.body ?? '')?.[1];
      if (code)
        await consoleApp.inject({
          method: 'POST',
          url: `/human-tasks/${t.id}/answer`,
          payload: { code },
        });
    }
  }, 500);
}, 120_000);
afterAll(async () => {
  clearInterval(answering);
  await consoleApp.close();
  await api?.close();
  await bank?.close();
  await db?.close();
});

const o = OUTCOMES['check-balance'];

describe('a run started in the hazard lab', () => {
  for (const hazard of ['permission-denial', 'promo'] as const) {
    const want = o.hazards.find((c) => c.hazard === hazard)!.expected;
    it(`with ${hazard} forced ends in ${want.status}${want.code ? `: ${want.code}` : ''}`, async () => {
      const r = await consoleApp.inject({
        method: 'POST',
        url: '/lab',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams([
          ['bank', 'generic'],
          ['task', 'check-balance'],
          ['member', '0'],
          ['hazards', hazard],
        ]).toString(),
      });
      const runId = new URL(r.headers.location as string, 'http://x').searchParams.get('run');
      expect(runId, String(r.headers.location)).toMatch(/^r_/);
      await runs.get(runId!);
      const got = (await resultOf(db, runId!))!;
      expect(
        got.status === 'succeeded'
          ? { status: got.status }
          : { status: got.status, code: got.code },
      ).toEqual(want);
      const html = (await consoleApp.inject({ url: '/lab' })).body;
      expect(html).toContain(`<a href="/runs/${runId}">`);
    }, 240_000);
  }
});
