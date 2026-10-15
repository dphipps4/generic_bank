import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// Submitting a transfer once, under a grant, and confirming it in the account's history (plan,
// §F.1 steps 4 and 5, §F.2). The bank's own ledger is the judge: never two postings for one grant.

let bank: LiveBank;
let browser: Browser;
let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  [bank, browser, db] = await Promise.all([liveBank('generic'), Browser.launch(), controlDb()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
  await db?.close();
});

/** The grant binds values, not wording: account labels are compared masked, as the grant keeps them. */
const values = (r: Review, memoToken: string) => ({
  fromRef: r.from.replace(/\d/g, '*'),
  toRef: r.to.replace(/\d/g, '*'),
  amountCents: r.amountCents,
  memoToken,
});
const postings = async (memoToken: string) =>
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
async function transfer(
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

const token = () => `GBX ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

describe('submitting a transfer under a grant', () => {
  it('posts once, reads the confirmation, finds it in the history, and journals each step', async () => {
    const memoToken = token();
    const { runId, out } = await transfer({
      memberId: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 12_500,
      memoToken,
    });
    expect(out).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    if (out.status === 'succeeded') expect(out.data.confirmation).toMatch(/^GB-/);
    expect(await postings(memoToken)).toBe(1);
    expect(await verifyJournal(db, runId)).toMatchObject({ ok: true, entries: 4 });
  }, 300_000);

  it('refuses the click when the grant is for a different amount, and posts nothing', async () => {
    const memoToken = token();
    const { out } = await transfer(
      {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 12_500,
        memoToken,
      },
      { grantAmount: 99_900 },
    );
    expect(out).toMatchObject({ status: 'escalated', code: 'guard_tripped' });
    expect(await postings(memoToken)).toBe(0);
  }, 300_000);

  it('never uses a grant twice', async () => {
    const memoToken = token();
    const { out, replay } = await transfer(
      {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 4_000,
        memoToken,
      },
      { replay: true },
    );
    expect(out.status).toBe('succeeded');
    expect(replay).toMatchObject({ status: 'escalated', code: 'guard_tripped' });
    expect(await postings(memoToken)).toBe(1);
  }, 300_000);

  it('answers the supervisor page over the threshold with the code the bank sent', async () => {
    const memoToken = token();
    const { out } = await transfer({
      memberId: MEMBERS.demo,
      from: 'Rainy Day Savings',
      to: 'Everyday Checking',
      amountCents: 300_000,
      memoToken,
    });
    expect(out).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    expect(await postings(memoToken)).toBe(1);
  }, 300_000);

  it('after a swallowed submit, reads the history instead of pressing again: one posting', async () => {
    const memoToken = token();
    const { out } = await transfer(
      {
        memberId: MEMBERS.demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 2_500,
        memoToken,
      },
      { hazards: ['swallowed-submit'] },
    );
    expect(out).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    expect(await postings(memoToken)).toBe(1);
  }, 300_000);
});
