// The recorder (plan §A.6): every run the system settles leaves its episode in the outbox, in
// the same statement as the settlement, and the recorder sends it to the real Memory service, as the
// runner, signed. Memory being stopped never changes a task's result, each episode arrives exactly
// once, and nothing personal reaches the outbox or memory.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { episodes } from '../../apps/memory/src/episodes.js';
import { openMemory } from '../../apps/memory/src/memory.js';
import { buildServer } from '../../apps/memory/src/server.js';
import { memoryDb, SIGNING_KEY, testDoor, testEmbed, TOKENS } from '../../apps/memory/test/db.js';
import { executeRun } from '../../apps/runner/src/execute.js';
import { sendEpisodes } from '../../apps/runner/src/recorder.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { createRun, resultOf, settleRun } from '../../packages/runs/src/index.js';

const KEY = 'k'.repeat(40);
let control: Awaited<ReturnType<typeof controlDb>>;
let mem: Awaited<ReturnType<typeof memoryDb>>;
let server: ReturnType<typeof buildServer> | null = null;
let port = 0;

/** Memory, started (again) on the same address and the same database. */
async function startMemory() {
  const memory = openMemory(mem);
  server = buildServer({ db: mem, memory, door: testDoor(), writes: episodes(memory, testEmbed) });
  await server.listen({ host: '127.0.0.1', port });
  port = (server.server.address() as AddressInfo).port;
}
async function stopMemory() {
  await server?.close();
  server = null;
}

const writer = () => ({
  url: `http://127.0.0.1:${port}`,
  token: TOKENS.runner,
  signingKey: SIGNING_KEY,
});
const send = () => sendEpisodes(control, writer());

beforeAll(async () => {
  [control, mem] = await Promise.all([controlDb(), memoryDb()]);
  await startMemory();
});
afterAll(async () => {
  await stopMemory();
  await control?.close();
  await mem?.close();
});

const rows = async (db: { query: typeof control.query }, sql: string, params: unknown[] = []) =>
  (await db.query<Record<string, unknown>>(sql, params)).rows;

const MEMBER = '700123456';
const ACCOUNT = '4321';
const BALANCE = 987_654;

async function balanceRun(bank = 'generic') {
  const { runId } = await createRun(
    control,
    {
      task: 'check-balance',
      bank,
      clientId: null,
      inputs: { bank, memberId: MEMBER, account: ACCOUNT },
    },
    KEY,
  );
  return runId;
}

describe('the recorder', () => {
  it('sends a settled run’s episode to memory exactly once, and each settlement as one attempt', async () => {
    const runId = await balanceRun();
    await settleRun(control, runId, { status: 'escalated', code: 'stuck' });
    // A person resumes it, and it settles again.
    await control.query(
      `UPDATE "TaskRun" SET status = 'running', "settledAt" = NULL WHERE id = $1`,
      [runId],
    );
    await settleRun(control, runId, {
      status: 'succeeded',
      data: {
        availableCents: BALANCE,
        currentCents: BALANCE,
        accountLabel: 'Account ending in ****',
      },
    });

    expect(await send()).toBe(2);
    expect(
      await rows(
        mem,
        `SELECT id, kind::text, bank, vendor, task, outcome FROM "Run" WHERE id = $1`,
        [runId],
      ),
    ).toEqual([
      {
        id: runId,
        kind: 'task',
        bank: 'generic',
        vendor: 'corelink',
        task: 'check-balance',
        outcome: 'escalated',
      },
    ]);
    expect(
      await rows(mem, `SELECT n, outcome, failure FROM "Attempt" WHERE "runId" = $1 ORDER BY n`, [
        runId,
      ]),
    ).toEqual([
      { n: 1, outcome: 'escalated', failure: 'stuck' },
      { n: 2, outcome: 'succeeded', failure: null },
    ]);

    // Nothing waits, so nothing more is sent.
    const changes = await rows(mem, `SELECT seq FROM "ChangeLog"`);
    expect(await send()).toBe(0);
    // The Runner stopped between memory taking an episode and the outbox marking it sent: sent
    // again, memory already holds it and writes nothing.
    await control.query(`UPDATE "EpisodeOutbox" SET "sentAt" = NULL WHERE "runId" = $1`, [runId]);
    expect(await send()).toBe(2);
    expect(await rows(mem, `SELECT seq FROM "ChangeLog"`)).toEqual(changes);
    expect(await rows(mem, `SELECT n FROM "Attempt" WHERE "runId" = $1`, [runId])).toHaveLength(2);
    expect(await rows(control, `SELECT 1 FROM "EpisodeOutbox" WHERE "sentAt" IS NULL`)).toEqual([]);
  });

  it('with memory stopped, the run settles as it would; its episode arrives once memory is back', async () => {
    await stopMemory();
    // The Runner, carrying out a run with no promoted driver: it settles before any browser opens.
    const runId = await balanceRun('sample');
    const ending = await executeRun(runId, {
      sql: control,
      store: memoryStore(),
      sealKey: KEY,
      answerKey: 'q'.repeat(40),
      credentials: async () => ({ operatorId: 'teller0412', password: 'p'.repeat(16) }),
    });
    expect(ending).toEqual({ status: 'failed', code: 'no_driver', retryable: false });
    expect(await resultOf(control, runId)).toMatchObject({
      status: 'failed',
      code: 'no_driver',
      retryable: false,
    });

    // Memory does not answer: the episode waits.
    expect(await send()).toBe(0);
    expect(
      await rows(
        control,
        `SELECT n, outcome, failure, "sentAt" FROM "EpisodeOutbox" WHERE "runId" = $1`,
        [runId],
      ),
    ).toEqual([{ n: 1, outcome: 'failed', failure: 'no_driver', sentAt: null }]);

    await startMemory();
    expect(await send()).toBe(1);
    expect(await send()).toBe(0);
    expect(await rows(mem, `SELECT outcome, vendor FROM "Run" WHERE id = $1`, [runId])).toEqual([
      { outcome: 'failed', vendor: 'corelink' },
    ]);
    expect(await rows(mem, `SELECT n, failure FROM "Attempt" WHERE "runId" = $1`, [runId])).toEqual(
      [{ n: 1, failure: 'no_driver' }],
    );
    expect(await rows(mem, `SELECT 1 FROM "ChangeLog" WHERE "runId" = $1`, [runId])).toHaveLength(
      2,
    );
  });

  it('never holds or sends anything personal, and memory’s privacy screen refuses what would be', async () => {
    const clean = await balanceRun();
    await settleRun(control, clean, {
      status: 'succeeded',
      data: {
        availableCents: BALANCE,
        currentCents: BALANCE,
        accountLabel: 'Account ending in ****',
      },
    });
    // An episode carrying an account number, as a bug might write one, ahead of a clean one.
    const leaky = await balanceRun();
    await settleRun(control, leaky, { status: 'failed', code: 'app_error' });
    await control.query(
      `UPDATE "EpisodeOutbox" SET failure = $2, at = at - interval '1 minute' WHERE "runId" = $1`,
      [leaky, '4111 1111 1111 1111'],
    );

    expect(await send()).toBe(2);
    // Memory refused the leaky attempt whole, and said why without the value; the outbox will not
    // send it again, and the clean episode behind it went.
    expect(
      await rows(control, `SELECT refused, "sentAt" FROM "EpisodeOutbox" WHERE "runId" = $1`, [
        leaky,
      ]),
    ).toEqual([{ refused: 'privacy_screen: account number', sentAt: null }]);
    expect(await rows(mem, `SELECT 1 FROM "Attempt" WHERE "runId" = $1`, [leaky])).toEqual([]);
    expect(await rows(mem, `SELECT n FROM "Attempt" WHERE "runId" = $1`, [clean])).toEqual([
      { n: 1 },
    ]);
    expect(await send()).toBe(0);

    // The run's inputs and result are in the control database, sealed or settled; none of them is
    // in the outbox, nor anywhere in memory.
    const outbox = JSON.stringify(
      await rows(control, `SELECT * FROM "EpisodeOutbox" WHERE "runId" = $1`, [clean]),
    );
    const held = JSON.stringify([
      await rows(mem, `SELECT * FROM "Run"`),
      await rows(mem, `SELECT * FROM "Attempt"`),
      await rows(mem, `SELECT * FROM "ChangeLog"`),
    ]);
    // Quoted or whole, so a hash that happens to hold the same digits is no match.
    for (const v of [MEMBER, `"${ACCOUNT}"`, String(BALANCE), '4111 1111']) {
      expect(outbox).not.toContain(v);
      expect(held).not.toContain(v);
    }
  });
});
