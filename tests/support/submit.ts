import { afterAll, beforeAll } from 'vitest';
import {
  type DriverContext,
  GENERIC_BANK,
  prepareTransfer,
  type Review,
  submitTransfer,
  type TransferInput,
} from '../../packages/drivers/src/index.js';
import { consumeGrant, issueGrant } from '../../packages/guardrails/src/index.js';
import { createRun, journal, openHumanTask, verifyJournal } from '../../packages/runs/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import type { HazardName } from '../../apps/bank/src/hazards.js';
import { OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from './banks.js';

// Preparing and submitting a transfer by hand, under a grant a test issues, against the real
// Generic Bank: shared by the browser test and the long suite's swallowed submit. The bank's own
// ledger is the judge: never two postings for one grant.

let bank: LiveBank;
let browser: Browser;
let db: Awaited<ReturnType<typeof controlDb>>;
/** Starts the bank, a browser and the control database for the calling test file. */
export function submitHarness() {
  beforeAll(async () => {
    [bank, browser, db] = await Promise.all([liveBank('generic'), Browser.launch(), controlDb()]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await bank?.close();
    await db?.close();
  });
  return { transfer, postings, token, verify: (runId: string) => verifyJournal(db, runId) };
}

/** The grant binds values, not wording: account labels are compared masked, as the grant keeps them. */
const values = (r: Review, memoToken: string) => ({
  fromRef: r.from.replace(/\d/g, '*'),
  toRef: r.to.replace(/\d/g, '*'),
  amountCents: r.amountCents,
  memoToken,
});
export const postings = async (memoToken: string) =>
  Number(
    (
      await bank.db.query<{ n: string }>('SELECT count(*) AS n FROM transfers WHERE memo LIKE $1', [
        `${memoToken}%`,
      ])
    ).rows[0]!.n,
  );

function context(page: Awaited<ReturnType<Browser['newPage']>>): DriverContext {
  return {
    page,
    profile: { ...GENERIC_BANK, url: bank.url },
    credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
    askHuman: async () => {
      const r = await bank.db.query<{ body: string }>(
        'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
      );
      return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
    },
    learn: () => undefined,
    step: () => undefined,
    now: () => new Date(),
  };
}

/** Prepares on a held page, has a person approve (a grant for what was read), then submits. */
export async function transfer(
  input: TransferInput,
  o: { grantAmount?: number; hazards?: HazardName[]; replay?: boolean } = {},
) {
  const { runId } = await createRun(
    db,
    { task: 'transfer', bank: 'generic', clientId: null, inputs: { bank: 'generic', ...input } },
    'k'.repeat(40),
  );
  const page = await browser.newPage();
  if (o.hazards)
    await page.call('Network.setExtraHTTPHeaders', { headers: bank.forced(o.hazards) });
  const ctx = context(page);
  try {
    const prepared = await prepareTransfer(ctx, input);
    if (prepared.status !== 'succeeded') return { runId, out: prepared };
    const task = await openHumanTask(db, runId, 'approval', {}, new Date(Date.now() + 60_000));
    const granted = values(prepared.data, input.memoToken);
    await issueGrant(db, {
      ...granted,
      amountCents: o.grantAmount ?? granted.amountCents,
      humanTaskId: task,
      runId,
    });
    const hooks = {
      consume: async (r: Review) => {
        const g = await consumeGrant(db, { runId, screen: values(r, input.memoToken) });
        return g.ok ? { ok: true as const } : { ok: false as const, reason: g.reason };
      },
      journal: async (line: { intent: string; action?: string; result?: string }) =>
        void (await journal(db, runId, line)),
      supervisorCode: async () => {
        const r = await bank.db.query<{ body: string }>(
          'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
        );
        return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
      },
      supervisorId: OPERATORS.supervisor.id,
    };
    const out = await submitTransfer(ctx, input, hooks);
    // A second submit of the same transfer, under the same (now used) grant.
    const replay = o.replay ? await submitTransfer(ctx, input, hooks) : null;
    return { runId, out, replay };
  } finally {
    await page.close();
  }
}

export const token = () => `GBX ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
