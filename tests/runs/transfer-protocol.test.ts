import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENERIC_BANK, pressIntent } from '../../packages/drivers/src/index.js';
import { journal, resultOf } from '../../packages/runs/src/index.js';
import { type Harness, stallsAt, transferHarness, until } from './transfer-harness.js';

// The swallowed-submit protocol (plan, §F.2, §D.4): the submit is never retried blindly. An unclear
// result reads the history; a run that resumes after its journaled submit goes to the history and
// never to the button; a run that lost its browser while parked signs in fresh and checks the
// screen against the grant. The bank's ledger is the judge: never two postings for one grant. The
// swallowed submit itself, which waits out the bank's endless "Processing" page, is in tests/long.

let h: Harness;
beforeAll(async () => {
  h = await transferHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const presses = async (runId: string) =>
  (await h.journalOf(runId)).filter((l) => l.intent.startsWith('press ') && !l.result);

describe('the swallowed-submit protocol', () => {
  it('a browser killed while parked: a fresh sign-in after approval, checked against the grant, one posting', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 3_100 });
    const before = h.browsers.length;
    const done = h.execute(runId);
    const task = await h.approval(runId);
    // The browser holding the review page dies, as a crashed browser does.
    h.browsers[before]!.cdp.close();
    expect(await h.act(task, 'approve')).toBe(200);
    expect(await done).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    expect(await h.postings(memoToken)).toBe(1);
    expect(h.browsers.length - before).toBe(2);
    // After approval, the run signed in again and prepared the transfer once more.
    const steps = (await h.stepsOf(runId)).map((s) => s.name);
    const resumed = steps.indexOf('resume');
    expect(resumed).toBeGreaterThan(0);
    expect(steps.slice(resumed)).toEqual(expect.arrayContaining(['sign in', 'transfer', 'submit']));
    expect((await presses(runId)).map((l) => l.action)).toEqual([null, 'pressed']);
  }, 300_000);

  it('a worker that stops while parked: the resumed run waits on the same approval and posts once', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 3_300 });
    const before = h.browsers.length;
    // The first worker stops dead the moment it starts waiting for the decision.
    void h.execute(runId, {
      sql: stallsAt(h.db, (q) => q.includes('LEFT JOIN "ApprovalGrant"')),
    });
    const task = await h.approval(runId);
    await until(async () => h.browsers.length > before, 10_000);
    h.browsers[before]!.cdp.close();

    const resumed = h.execute(runId);
    expect(await h.act(task, 'approve')).toBe(200);
    expect(await resumed).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
    expect(await h.postings(memoToken)).toBe(1);
    const approvals = await h.db.query(
      `SELECT id FROM "HumanTask" WHERE "runId" = $1 AND kind = 'approval'`,
      [runId],
    );
    expect(approvals.rows).toHaveLength(1);
  }, 300_000);

  it('a worker that stops between the press and its record: the resumed run reads the history and never presses', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 3_700 });
    const before = h.browsers.length;
    // The first worker presses, and stops dead before it can write that it did.
    void h.execute(runId, {
      sql: stallsAt(h.db, (q, p) => q.includes('INSERT INTO "JournalEntry"') && p[4] === 'pressed'),
    });
    expect(await h.act(await h.approval(runId), 'approve')).toBe(200);
    await until(async () => (await h.postings(memoToken)) === 1, 180_000);
    h.browsers[before]!.cdp.close();
    expect((await presses(runId)).map((l) => l.action)).toEqual([null]);

    expect(await h.execute(runId)).toMatchObject({
      status: 'succeeded',
      data: { confirmation: memoToken, seenInHistory: true },
    });
    expect(await h.postings(memoToken)).toBe(1);
    // The resumed run wrote no intent and no press of its own: it only read.
    expect((await presses(runId)).map((l) => l.action)).toEqual([null]);
    const grant = await h.db.query<{ usedAt: Date | null }>(
      'SELECT "usedAt" FROM "ApprovalGrant" WHERE "runId" = $1',
      [runId],
    );
    expect(grant.rows).toHaveLength(1);
  }, 300_000);

  it('a journaled intent with no posting: the history finds nothing, and the outcome is for a person', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 3_900 });
    // A run that stopped after writing its intent, before the click.
    await journal(h.db, runId, { intent: pressIntent(GENERIC_BANK, memoToken) });
    expect(await h.execute(runId)).toMatchObject({
      status: 'escalated',
      code: 'ambiguous_outcome',
    });
    expect(await resultOf(h.db, runId)).toMatchObject({
      status: 'escalated',
      code: 'ambiguous_outcome',
    });
    expect(await h.postings(memoToken)).toBe(0);
    // It went straight to the history: no approval asked for, no review page, no submit.
    const tasks = await h.db.query(
      `SELECT id FROM "HumanTask" WHERE "runId" = $1 AND kind = 'approval'`,
      [runId],
    );
    expect(tasks.rows).toHaveLength(0);
    const steps = (await h.stepsOf(runId)).map((s) => s.name);
    expect(steps).toContain('history');
    expect(steps).not.toContain('transfer');
    expect(steps).not.toContain('submit');
  }, 300_000);
});
