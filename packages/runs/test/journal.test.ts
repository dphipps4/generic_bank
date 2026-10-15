import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlDb } from '../../oauth/test/control.js';
import { createRun, journal, verifyJournal } from '../src/index.js';

const KEY = 'j'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(() => db.close());

const run = async () =>
  (
    await createRun(
      db,
      {
        task: 'transfer',
        bank: 'generic',
        clientId: null,
        inputs: { bank: 'generic', memberId: '40017732', account: '7890' },
      },
      KEY,
    )
  ).runId;

async function threeEntries(runId: string) {
  await journal(db, runId, { intent: 'press Submit transfer under grant g_1' });
  await journal(db, runId, { intent: 'press Submit transfer under grant g_1', action: 'pressed' });
  await journal(db, runId, {
    intent: 'read the confirmation',
    result: 'confirmation GB-48213-K',
  });
}

describe('the journal', () => {
  it('chains each run’s entries from its own origin, and verifies', async () => {
    const a = await run();
    const b = await run();
    await threeEntries(a);
    await threeEntries(b);
    expect(await verifyJournal(db, a)).toEqual({ ok: true, runs: 1, entries: 3 });
    const all = await verifyJournal(db);
    expect(all.ok).toBe(true);
  });

  it('breaks at the entry whose words were changed', async () => {
    const a = await run();
    await threeEntries(a);
    await db.query(
      `UPDATE "JournalEntry" SET result = 'confirmation GB-00000-X' WHERE "runId" = $1 AND seq = 3`,
      [a],
    );
    expect(await verifyJournal(db, a)).toEqual({
      ok: false,
      runId: a,
      seq: 3,
      reason: 'its content was changed',
    });
  });

  it('breaks where an entry was removed from the middle', async () => {
    const a = await run();
    await threeEntries(a);
    await db.query(`DELETE FROM "JournalEntry" WHERE "runId" = $1 AND seq = 2`, [a]);
    expect(await verifyJournal(db, a)).toMatchObject({
      ok: false,
      seq: 3,
      reason: 'entry 2 is missing',
    });
  });

  it('breaks where an entry was rewritten with a fresh hash of its own', async () => {
    const a = await run();
    await threeEntries(a);
    // A forger recomputes entry 2's own hash; entry 3 no longer follows it.
    const { hashOf } = await import('../src/journal.js');
    const r = (
      await db.query<{ seq: number; intent: string; prevHash: string; at: Date }>(
        `SELECT seq, intent, "prevHash", at FROM "JournalEntry" WHERE "runId" = $1 AND seq = 2`,
        [a],
      )
    ).rows[0]!;
    const forged = hashOf({ runId: a, ...r, action: 'did not press', result: null });
    await db.query(
      `UPDATE "JournalEntry" SET action = 'did not press', "rowHash" = $2 WHERE "runId" = $1 AND seq = 2`,
      [a, forged],
    );
    expect(await verifyJournal(db, a)).toMatchObject({
      ok: false,
      seq: 3,
      reason: 'it does not follow the entry before it',
    });
  });
});
