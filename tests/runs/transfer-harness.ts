// Transfer runs carried out by the Runner against the real Generic Bank, with the control database's
// real migrations, for the tests in this folder. People act only through the Console's API: a small
// loop plays whoever reads the codes the bank sends (the staff phone, the supervisor's phone), and a
// test decides each approval as a person would. The bank's own ledger is the judge of what moved.
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { inboxPages } from '../../apps/console/src/pages/inbox.js';
import { executeRun, type RunDeps } from '../../apps/runner/src/execute.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { createRun, newMemoToken } from '../../packages/runs/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { liveBank, PASSWORDS } from '../support/banks.js';

export const KEY = 'k'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);

export interface Transfer {
  memberId?: string;
  from?: string;
  to?: string;
  amountCents?: number;
  memo?: string;
}

export type Harness = Awaited<ReturnType<typeof transferHarness>>;

export async function transferHarness() {
  const [db, bank] = await Promise.all([controlDb(), liveBank('generic')]);
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
  const consoleApp = Fastify();
  inboxPages(consoleApp, {
    sql: db,
    answerKey: ANSWER_KEY,
    whoIs: () => ({ email: 'staff@test', role: 'approver' }),
  });
  await consoleApp.ready();

  // The people at the phones: each open code task is answered with the last code sent to them.
  const phoneOf = { staff_code: OPERATORS.service.id, supervisor_code: OPERATORS.supervisor.id };
  const answering = setInterval(async () => {
    const open = await db.query<{ id: string; kind: keyof typeof phoneOf }>(
      `SELECT id, kind FROM "HumanTask" WHERE status = 'open' AND kind IN ('staff_code', 'supervisor_code')`,
    );
    for (const t of open.rows) {
      const m = await bank.db.query<{ body: string }>(
        `SELECT m.body FROM messages m JOIN operators o ON m.address IN (o.phone, o.email)
          WHERE o.operator_id = $1 ORDER BY m.id DESC LIMIT 1`,
        [phoneOf[t.kind]],
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

  const browsers: Browser[] = [];
  const store = memoryStore();

  return {
    db,
    bank,
    store,
    /** Every browser a run launched, in order. */
    browsers,
    /** Starts a transfer run, as the API would: the run, with the memo token minted and sealed. */
    async start(t: Transfer = {}) {
      const memoToken = newMemoToken();
      const { runId } = await createRun(
        db,
        {
          task: 'transfer',
          bank: 'generic',
          clientId: 'gbc_t',
          inputs: {
            bank: 'generic',
            memberId: t.memberId ?? MEMBERS.demo,
            from: t.from ?? 'Everyday Checking',
            to: t.to ?? 'Rainy Day Savings',
            amountCents: t.amountCents ?? 12_500,
            ...(t.memo ? { memo: t.memo } : {}),
            memoToken,
            idempotencyKey: randomBytes(8).toString('hex'),
          },
        },
        KEY,
      );
      return { runId, memoToken };
    },

    /** Carries out a run, as the Runner's workflow does; a resumed run is the same call again. */
    execute: (runId: string, o: Partial<RunDeps> = {}) => executeRun(runId, harnessDeps(o)),

    /** The run's open approval task, once the run has parked on the review page. */
    async approval(runId: string, limitMs = 180_000): Promise<string> {
      return until(async () => {
        const r = await db.query<{ id: string }>(
          `SELECT id FROM "HumanTask" WHERE "runId" = $1 AND kind = 'approval' AND status = 'open'`,
          [runId],
        );
        return r.rows[0]?.id;
      }, limitMs);
    },

    /** A person acts on a task from the Console, with a reason; the HTTP status it answered. */
    async act(taskId: string, action: 'approve' | 'reject' | 'take-over' | 'cancel') {
      const r = await consoleApp.inject({
        method: 'POST',
        url: `/human-tasks/${taskId}/${action}`,
        payload: { reason: 'checked with the member on the phone' },
      });
      return r.statusCode;
    },

    /** How many transfers the bank posted carrying this memo token: the ledger's word. */
    async postings(memoToken: string): Promise<number> {
      const r = await bank.db.query<{ n: string }>(
        'SELECT count(*) AS n FROM transfers WHERE memo LIKE $1',
        [`${memoToken}%`],
      );
      return Number(r.rows[0]!.n);
    },

    async stepsOf(runId: string) {
      return (
        await db.query<{ name: string; action: string | null; outcome: string | null }>(
          'SELECT name, action, outcome FROM "Step" WHERE "runId" = $1 ORDER BY seq',
          [runId],
        )
      ).rows;
    },

    async close() {
      clearInterval(answering);
      await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));
      await consoleApp.close();
      await bank.close();
      await db.close();
    },
  };

  function harnessDeps(o: Partial<RunDeps> = {}): RunDeps {
    return {
      sql: db,
      store,
      sealKey: KEY,
      answerKey: ANSWER_KEY,
      credentials: async () => ({
        operatorId: OPERATORS.service.id,
        password: PASSWORDS.service,
        supervisorId: OPERATORS.supervisor.id,
      }),
      launch: async () => {
        const b = await Browser.launch(o.headers ? { headers: o.headers } : {});
        browsers.push(b);
        return b;
      },
      pollMs: 250,
      ...o,
    };
  }
}

async function until<T>(
  read: () => Promise<T | undefined | null | false>,
  limitMs: number,
): Promise<T> {
  const end = Date.now() + limitMs;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 250));
  }
}
