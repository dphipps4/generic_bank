// The rules (plan §8, §A.6): one run's contradiction disputes a lesson and two retire it, and a
// person retires one by hand; each leaves the versions the plan gives it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { episodes } from '../src/episodes.js';
import { knowledgeRoutes } from '../src/knowledge.js';
import type { Role } from '../src/memory.js';
import { buildServer } from '../src/server.js';
import { memoryDb, signedPost, testDoor, testEmbed, TOKENS } from './db.js';

let db: Awaited<ReturnType<typeof memoryDb>>;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  db = await memoryDb();
  app = buildServer({ db, door: testDoor(), writes: episodes(db, testEmbed) });
  knowledgeRoutes(app, db, testEmbed);
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const HASH = 'ab'.repeat(32);

const send = (write: string, body: unknown, role: Role) => signedPost(app, write, body, role);
const post = async (write: string, body: unknown, role: Role = 'factory') => {
  const r = await send(write, body, role);
  expect(r.statusCode, JSON.stringify(r.json())).toBeLessThan(300);
  return r.json() as Record<string, unknown>;
};
const get = async (url: string) =>
  (
    await app.inject({ url, headers: { authorization: `Bearer ${TOKENS.factory}` } })
  ).json() as Record<string, unknown>;

/** A run, recorded now. */
const run = async (id: string, bank: string, extra: Record<string, unknown> = {}) =>
  post(
    'episodes/runs',
    {
      id,
      kind: 'task',
      bank,
      vendor: 'corelink',
      outcome: 'succeeded',
      startedAt: new Date().toISOString(),
      ...extra,
    },
    'factory',
  );

const propose = async (runId: string, text: string, scope = 'tenant', seen = true) =>
  (
    await post('lessons/proposals', {
      runId,
      text,
      area: 'statements',
      scope,
      confidence: 'medium',
      seen,
      frames: [`${runId}/001`],
      evidenceHash: HASH,
    })
  ).lesson as string;

const contradiction = (
  lessonId: string,
  runId: string,
  reason = 'the list sorted the other way',
) => ({
  lessonId,
  runId,
  reason,
  frames: [`${runId}/002`],
  evidenceHash: HASH,
});

const versions = async (id: string) =>
  (
    await db.query<Record<string, unknown>>(
      `SELECT version, state::text AS state, scope::text AS scope, bank, vendor, "retiredAtBanks",
         role::text AS role, "runId", reason, text, evidence
       FROM "LessonVersion" WHERE "lessonId" = $1 ORDER BY version`,
      [id],
    )
  ).rows;
const current = async (id: string) =>
  (await db.query<{ current: number }>(`SELECT current FROM "Lesson" WHERE id = $1`, [id])).rows[0]!
    .current;
const served = async (id: string) => (await versions(id))[(await current(id)) - 1]!;

describe('contradictions', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await run('c-gen', 'generic');
    await run('c-ex', 'example');
    for (const id of ['x1', 'x2', 'x3']) await run(id, 'example', { outcome: 'failed' });
    await run('g1', 'generic', { outcome: 'failed' });
    ids.tenant = await propose('c-ex', 'Example puts the balance in the third column.');
    ids.vendor = await propose(
      'c-gen',
      'CoreLink shows the member name above the accounts.',
      'vendor',
    );
  });

  it('one run disputes a lesson; the same run again changes nothing; a second retires it', async () => {
    const one = await post('facts/invalidate', contradiction(ids.tenant!, 'x1'));
    expect(one).toMatchObject({ written: true, rule: 'dispute', state: 'disputed', against: 1 });
    expect(await served(ids.tenant!)).toMatchObject({
      version: 2,
      state: 'disputed',
      role: 'factory',
      runId: 'x1',
      reason: 'the list sorted the other way',
    });
    // Still served, with its reason.
    const pack = (await get('/knowledge/pack?bank=example&vendor=corelink')) as {
      tiers: { disputed: { id: string; label: string }[] };
    };
    expect(pack.tiers.disputed).toContainEqual(
      expect.objectContaining({ id: ids.tenant, label: 'disputed: the list sorted the other way' }),
    );

    const again = await send('facts/invalidate', contradiction(ids.tenant!, 'x1'), 'factory');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ written: false });
    expect(await versions(ids.tenant!)).toHaveLength(2);

    expect(await post('facts/invalidate', contradiction(ids.tenant!, 'x2'))).toMatchObject({
      rule: 'retire',
      state: 'retired',
      against: 2,
    });
    const last = await served(ids.tenant!);
    expect(last).toMatchObject({ version: 3, state: 'retired' });
    expect(
      (last.evidence as { run: string; contradicts?: boolean }[]).filter((c) => c.contradicts),
    ).toHaveLength(2);
  });

  it('retires a lesson wrong at one bank there only, and everywhere once a second bank says so', async () => {
    await post('facts/invalidate', contradiction(ids.vendor!, 'x1'));
    expect(await post('facts/invalidate', contradiction(ids.vendor!, 'x2'))).toMatchObject({
      rule: 'retire at the bank',
      state: 'disputed',
    });
    expect(await served(ids.vendor!)).toMatchObject({
      state: 'disputed',
      retiredAtBanks: ['example'],
    });
    const at = async (bank: string) =>
      JSON.stringify(await get(`/knowledge/pack?bank=${bank}&vendor=corelink`)).includes(
        ids.vendor!,
      );
    expect(await at('example')).toBe(false);
    expect(await at('generic')).toBe(true);

    expect(await post('facts/invalidate', contradiction(ids.vendor!, 'g1'))).toMatchObject({
      rule: 'retire',
      state: 'retired',
    });
    expect(await at('generic')).toBe(false);
  });

  it('needs the frames that show it, and a lesson memory holds', async () => {
    const { frames: _, ...bare } = contradiction(ids.tenant!, 'x3');
    expect((await send('facts/invalidate', bare, 'factory')).statusCode).toBe(400);
    const none = await send('facts/invalidate', contradiction('L-none', 'x3'), 'factory');
    expect(none.statusCode).toBe(409);
  });
});

describe('a person', () => {
  it('retires a lesson at one bank, then everywhere; saying so again changes nothing', async () => {
    await run('r-gen', 'generic');
    const id = await propose('r-gen', 'CoreLink lists the newest statement first.', 'vendor');
    expect(
      await post(
        'lessons/retire',
        { lessonId: id, reason: 'not here', bank: 'example' },
        'curator',
      ),
    ).toMatchObject({ written: true });
    expect(await served(id)).toMatchObject({
      state: 'proposed',
      retiredAtBanks: ['example'],
      role: 'curator',
    });
    const again = await send(
      'lessons/retire',
      { lessonId: id, reason: 'not here', bank: 'example' },
      'curator',
    );
    expect(again.statusCode).toBe(200);
    expect(
      await post('lessons/retire', { lessonId: id, reason: 'wrong' }, 'curator'),
    ).toMatchObject({ written: true });
    expect(await served(id)).toMatchObject({ version: 3, state: 'retired', reason: 'wrong' });
    expect(
      (await send('lessons/retire', { lessonId: 'L-none', reason: 'x' }, 'curator')).statusCode,
    ).toBe(409);
  });
});
