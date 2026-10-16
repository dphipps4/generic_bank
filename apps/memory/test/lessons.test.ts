// Episodes and lessons (plan §8, §A.6): runs and their attempts, hypotheses, proposals that
// cite their frames, and near-duplicates that grow a held lesson. Each write is read back from the
// tables and the change log it leaves.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { episodes } from '../src/episodes.js';
import { openMemory, type Role } from '../src/memory.js';
import { buildServer } from '../src/server.js';
import { memoryDb, signedPost, testDoor, testEmbed, TOKENS } from './db.js';

let db: Awaited<ReturnType<typeof memoryDb>>;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  db = await memoryDb();
  const memory = openMemory(db);
  app = buildServer({ db, memory, door: testDoor(), writes: episodes(memory, testEmbed) });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const post = (write: string, body: unknown, role: Role = 'factory') =>
  signedPost(app, write, body, role);

const count = async (table: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]!.n;

const lastChange = async () =>
  (await db.query(`SELECT * FROM "ChangeLog" ORDER BY seq DESC LIMIT 1`)).rows[0];

/** The write is refused with `status`, and nothing at all is written. */
async function refused(write: string, body: unknown, status: number, role: Role = 'factory') {
  const tables = ['Run', 'Attempt', 'Hypothesis', 'Lesson', 'LessonVersion', 'Reliance'];
  const before = await Promise.all([...tables, 'ChangeLog'].map(count));
  const r = await post(write, body, role);
  expect(r.statusCode, JSON.stringify(r.json())).toBe(status);
  expect(await Promise.all([...tables, 'ChangeLog'].map(count))).toEqual(before);
  return r.json() as Record<string, unknown>;
}

const run = (id: string, bank = 'generic', vendor = 'corelink') => ({
  id,
  kind: 'factory',
  bank,
  vendor: vendor || undefined,
  outcome: 'succeeded',
  startedAt: '2026-03-04T05:06:07.000Z',
  model: 'claude-sonnet-4-5',
  prompts: { supervisor: 'v3' },
});

const HASH = 'ab'.repeat(32);

const ADVICE =
  'One member can hold several accounts. Choose the account by identity, never by its position.';

const proposal = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId,
  text: ADVICE,
  area: 'targeting',
  scope: 'tenant',
  confidence: 'medium',
  seen: true,
  frames: [`${runId}/003`, `${runId}/004`],
  evidenceHash: HASH,
  model: 'claude-sonnet-4-5',
  prompts: { supervisor: 'v3' },
  ...extra,
});

const versions = async (lessonId: string) =>
  (
    await db.query<Record<string, unknown>>(
      `SELECT version, text, scope::text, bank, vendor, state::text, confidence::text, seen, evidence,
              role::text, "runId", reason, embedding IS NOT NULL AS embedded
       FROM "LessonVersion" WHERE "lessonId" = $1 ORDER BY version`,
      [lessonId],
    )
  ).rows;

const current = async (lessonId: string) =>
  (await db.query<{ current: number }>(`SELECT current FROM "Lesson" WHERE id = $1`, [lessonId]))
    .rows[0]!.current;

describe('episodes', () => {
  it('records a run once, with its change-log row', async () => {
    const r = await post('episodes/runs', run('run-1'), 'runner');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ run: 'run-1' });
    expect(await lastChange()).toMatchObject({
      role: 'runner',
      action: 'episodes/runs',
      entity: 'Run',
      entityId: 'run-1',
      runId: 'run-1',
      data: { bank: 'generic', vendor: 'corelink', outcome: 'succeeded' },
    });
    const e = await refused('episodes/runs', run('run-1'), 409, 'runner');
    expect(e).toMatchObject({ error: 'run_exists' });
  });

  it('refuses an attempt with no run, 409, and records one of a run', async () => {
    const attempt = {
      runId: 'run-none',
      n: 1,
      outcome: 'failed',
      failure: 'code_never_arrived',
      frames: ['run-none/001'],
      at: '2026-03-04T05:07:00.000Z',
    };
    expect(await refused('episodes/attempts', attempt, 409)).toMatchObject({ error: 'no_run' });

    const r = await post('episodes/attempts', { ...attempt, runId: 'run-1' });
    expect(r.statusCode).toBe(201);
    const row = (await db.query(`SELECT * FROM "Attempt" WHERE "runId" = 'run-1'`)).rows;
    expect(row).toEqual([
      expect.objectContaining({ n: 1, failure: 'code_never_arrived', frames: ['run-none/001'] }),
    ]);
    expect(await lastChange()).toMatchObject({ entity: 'Attempt', entityId: 'run-1/1' });
    expect(await refused('episodes/attempts', { ...attempt, runId: 'run-1' }, 409)).toMatchObject({
      error: 'attempt_exists',
    });
  });

  it('records a hypothesis of a run, at the run’s bank, and none without a run', async () => {
    const h = { runId: 'run-1', text: 'This bank probably needs a wait after the staff code.' };
    const r = await post('hypotheses', h);
    expect(r.statusCode).toBe(201);
    const { hypothesis } = r.json() as { hypothesis: string };
    expect(
      (await db.query(`SELECT bank, text FROM "Hypothesis" WHERE id = $1`, [hypothesis])).rows,
    ).toEqual([{ bank: 'generic', text: h.text }]);
    expect(await refused('hypotheses', { ...h, runId: 'run-none' }, 409)).toMatchObject({
      error: 'no_run',
    });
  });
});

describe('lessons', () => {
  let held = '';

  beforeAll(async () => {
    for (const r of [
      run('run-2'),
      run('run-3'),
      run('run-4'),
      run('run-5', 'example', 'corelink'),
      run('run-6', 'solo', ''),
    ])
      expect((await post('episodes/runs', r)).statusCode).toBe(201);
  });

  it('refuses a lesson that cites no frame, and one of no run', async () => {
    const e = await refused('lessons/proposals', proposal('run-2', { frames: [] }), 400);
    expect(e).toMatchObject({ error: 'bad_body', issues: [{ path: ['frames'] }] });
    expect(
      await refused('lessons/proposals', { ...proposal('run-2'), frames: undefined }, 400),
    ).toMatchObject({ error: 'bad_body' });
    expect(
      await refused('lessons/proposals', proposal('run-none', { frames: ['run-none/1'] }), 409),
    ).toMatchObject({ error: 'no_run' });
  });

  it('refuses a lesson of more than three sentences, with no confidence, or not marked seen or guess', async () => {
    const long = 'Wait for the page. Read the list. Check the total. Then report it.';
    for (const body of [
      proposal('run-2', { text: long }),
      proposal('run-2', { confidence: 'certain' }),
      { ...proposal('run-2'), confidence: undefined },
      { ...proposal('run-2'), seen: undefined },
      proposal('run-2', { seen: 'guess' }),
    ])
      expect(await refused('lessons/proposals', body, 400)).toMatchObject({ error: 'bad_body' });
  });

  it('holds a new lesson as proposed, citing its run, frames and evidence hash', async () => {
    const r = await post('lessons/proposals', proposal('run-2', { seen: false }));
    expect(r.statusCode).toBe(201);
    const out = r.json() as { lesson: string; version: number; merged: boolean };
    expect(out).toMatchObject({ version: 1, merged: false });
    held = out.lesson;
    expect(await current(held)).toBe(1);
    expect(await versions(held)).toEqual([
      expect.objectContaining({
        version: 1,
        text: ADVICE,
        scope: 'tenant',
        bank: 'generic',
        vendor: 'corelink',
        state: 'proposed',
        confidence: 'medium',
        seen: false,
        evidence: [{ run: 'run-2', frames: ['run-2/003', 'run-2/004'], hash: HASH, seen: false }],
        role: 'factory',
        runId: 'run-2',
        embedded: true,
      }),
    ]);
    expect(await lastChange()).toMatchObject({
      role: 'factory',
      action: 'lessons/proposals',
      entity: 'Lesson',
      entityId: held,
      runId: 'run-2',
      data: { version: 1, merged: false, state: 'proposed', seen: false },
    });
  });

  it('grows the held lesson’s evidence with a near-duplicate, and adds no lesson', async () => {
    const lessons = await count('Lesson');
    // The same advice, worded in another order and case.
    const again =
      'Choose the account by identity, never by its position; one member can hold several accounts.';
    const r = await post('lessons/proposals', proposal('run-3', { text: again }), 'runner');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ lesson: held, version: 2, merged: true });
    expect(await count('Lesson')).toBe(lessons);
    expect(await current(held)).toBe(2);

    const [, v2] = await versions(held);
    // Seen on run-3's frames: the lesson is seen now. Its text and confidence are the held ones.
    expect(v2).toMatchObject({
      text: ADVICE,
      state: 'proposed',
      seen: true,
      role: 'runner',
      runId: 'run-3',
      reason: 'a near-duplicate proposal added its evidence',
      evidence: [
        { run: 'run-2', seen: false },
        { run: 'run-3', frames: ['run-3/003', 'run-3/004'], hash: HASH, seen: true },
      ],
    });
    expect(await lastChange()).toMatchObject({
      entity: 'Lesson',
      entityId: held,
      runId: 'run-3',
      data: { version: 2, merged: true, similarity: 1 },
    });
  });

  it('never lets a guess stand for what was seen', async () => {
    const r = await post('lessons/proposals', proposal('run-4', { seen: false }));
    expect(r.json()).toMatchObject({ lesson: held, version: 3, merged: true });
    const [, , v3] = await versions(held);
    // The lesson stays seen, by run-3; run-4's citation is marked a guess.
    expect(v3).toMatchObject({ seen: true });
    expect((v3!.evidence as { run: string; seen: boolean }[]).map((c) => [c.run, c.seen])).toEqual([
      ['run-2', false],
      ['run-3', true],
      ['run-4', false],
    ]);
  });

  it('keeps a lesson apart when its scope, its bank or its advice differs', async () => {
    const lessons = await count('Lesson');
    const apart = [
      proposal('run-5'), // the same advice at another bank
      proposal('run-2', { scope: 'vendor' }), // for every CoreLink bank
      proposal('run-2', { scope: 'pattern' }), // for every bank
      proposal('run-2', {
        text: 'Wait for the statements list to finish loading before counting its rows.',
      }),
    ];
    for (const body of apart) {
      const r = await post('lessons/proposals', body);
      expect(r.json()).toMatchObject({ merged: false, version: 1 });
      expect((r.json() as { lesson: string }).lesson).not.toBe(held);
    }
    expect(await count('Lesson')).toBe(lessons + apart.length);
    // A second vendor proposal of the same advice, from another bank of the vendor, merges.
    expect(
      (await post('lessons/proposals', proposal('run-5', { scope: 'vendor' }))).json(),
    ).toMatchObject({ merged: true, version: 2 });
    expect(
      await refused('lessons/proposals', proposal('run-6', { scope: 'vendor' }), 409),
    ).toMatchObject({ error: 'no_vendor' });
  });

  it('records the lessons a run relied on once, at their current version', async () => {
    const r = await post('lessons/relied-on', { runId: 'run-4', lessonIds: [held] }, 'runner');
    expect(r.statusCode).toBe(201);
    expect((await db.query(`SELECT "runId", "lessonId", version FROM "Reliance"`)).rows).toEqual([
      { runId: 'run-4', lessonId: held, version: 3 },
    ]);
    expect(await lastChange()).toMatchObject({
      action: 'lessons/relied-on',
      entity: 'Run',
      entityId: 'run-4',
      data: { reliedOn: [{ lessonId: held, version: 3 }] },
    });

    const changes = await count('ChangeLog');
    const again = await post('lessons/relied-on', { runId: 'run-4', lessonIds: [held] });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ written: false });
    expect(await count('ChangeLog')).toBe(changes);

    expect(
      await refused('lessons/relied-on', { runId: 'run-4', lessonIds: [held, 'L-none'] }, 409),
    ).toMatchObject({ error: 'no_lesson' });
    expect(
      await refused('lessons/relied-on', { runId: 'run-none', lessonIds: [held] }, 409),
    ).toMatchObject({ error: 'no_run' });
  });

  it('leaves a change log that verifies', async () => {
    const v = await app.inject({
      url: '/history/verify',
      headers: { authorization: `Bearer ${TOKENS.curator}` },
    });
    expect(v.json()).toMatchObject({ ok: true });
  });
});
