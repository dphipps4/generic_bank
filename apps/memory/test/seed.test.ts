// The seed (plan §8): the starting knowledge through memory's own door, as the curator, with one
// approval for the whole set; the catalog and the lessons read at any version.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogRoutes, curated } from '../src/curated.js';
import { episodes } from '../src/episodes.js';
import { openMemory } from '../src/memory.js';
import { seed, SeedRefused } from '../src/seed.js';
import { buildServer } from '../src/server.js';
import { memoryDb, signedPost, SIGNING_KEY, testDoor, testEmbed, TOKENS } from './db.js';

const SEEDS = join(import.meta.dirname, '../../../seeds/memory');
const manifest = JSON.parse(readFileSync(join(SEEDS, 'manifest.json'), 'utf8')) as {
  set: string;
  approval: { reason: string };
};
const entries = (file: string) =>
  (JSON.parse(readFileSync(join(SEEDS, `${file}.json`), 'utf8')) as { entries: { id: string }[] })
    .entries;

async function memoryService() {
  const db = await memoryDb();
  const memory = openMemory(db);
  const writes = { ...episodes(memory, testEmbed), ...curated(memory, testEmbed) };
  const app = buildServer({ db, memory, door: testDoor(), writes });
  catalogRoutes(app, db);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const count = async (sql: string) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0]!.n;
  return { db, app, url, count };
}

const curator = { token: TOKENS.curator, signingKey: SIGNING_KEY };

describe('the seed', () => {
  let m: Awaited<ReturnType<typeof memoryService>>;
  beforeAll(async () => {
    m = await memoryService();
  });
  afterAll(async () => {
    await m.app.close();
    await m.db.close();
  });

  const get = (url: string) =>
    m.app.inject({ url, headers: { authorization: `Bearer ${TOKENS.runner}` } });

  it('serves on a fresh database every entry the manifest counts, and the chain verifies', async () => {
    const out = await seed({ dir: SEEDS, url: m.url, ...curator });
    const counts = { rules: 19, checks: 7, lessons: 268, scenarios: 49, approaches: 46 };
    expect(out).toEqual({ served: counts, written: 389, approved: 389 });

    for (const [kind, n] of [
      ['rule', 19],
      ['check', 7],
      ['scenario', 49],
      ['approach', 46],
    ] as const)
      expect(await m.count(`"CatalogEntry" WHERE kind = '${kind}' AND current = 1`), kind).toBe(n);
    expect(await m.count(`"Lesson" WHERE current = 1`)).toBe(268);
    // Seeded lessons are curated patterns, embedded for search, resting on no run's frames.
    expect(
      await m.count(
        `"LessonVersion" WHERE state = 'confirmed' AND scope = 'pattern' AND role = 'curator'
           AND bank IS NULL AND vendor IS NULL AND NOT seen AND evidence = '[]'
           AND embedding IS NOT NULL AND why IS NOT NULL AND cardinality(signals) > 0`,
      ),
    ).toBe(268);

    // One change-log row per entry, then one approval for the whole set, all by the curator.
    expect(await m.count(`"ChangeLog" WHERE action = 'curated' AND role = 'curator'`)).toBe(389);
    const approvals = (
      await m.db.query<{ entityId: string; data: { reason: string; versions: unknown[] } }>(
        `SELECT "entityId", data FROM "ChangeLog" WHERE action = 'curated/approve'`,
      )
    ).rows;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      entityId: manifest.set,
      data: { reason: manifest.approval.reason },
    });
    expect(approvals[0]!.data.versions).toHaveLength(389);
    expect((await get('/history/verify')).json()).toEqual({ ok: true, rows: 390 });
  }, 120_000);

  it('writes nothing when it runs again', async () => {
    const before = await m.count(`"ChangeLog"`);
    const out = await seed({ dir: SEEDS, url: m.url, ...curator });
    expect(out).toMatchObject({ written: 0, approved: 0 });
    expect(out.served.lessons).toBe(268);
    expect(await m.count(`"ChangeLog"`)).toBe(before);
  }, 120_000);

  it('reads the catalog and the lessons as served, and at any version', async () => {
    const rules = (await get('/rules')).json() as { entries: { key: string }[] };
    expect(rules.entries.map((e) => e.key)).toEqual(
      entries('rules')
        .map((e) => e.id)
        .sort(),
    );
    const r01 = entries('rules').find((e) => e.id === 'R01')!;
    expect((await get('/rules/R01')).json()).toMatchObject({ version: 1, current: 1, body: r01 });
    for (const path of ['/checks', '/scenarios', '/approaches'])
      expect(((await get(path)).json() as { entries: unknown[] }).entries.length).toBeGreaterThan(
        0,
      );

    const l1 = entries('lessons')[0] as { id: string; lesson: string; signals: string[] };
    expect((await get(`/lessons/${l1.id}`)).json()).toMatchObject({
      key: l1.id,
      version: 1,
      text: l1.lesson,
      signals: l1.signals,
      scope: 'pattern',
      state: 'confirmed',
    });
    expect(((await get('/lessons')).json() as { lessons: unknown[] }).lessons).toHaveLength(268);

    // A person's edit waits, unserved, until approved; the earlier version still reads.
    const edit = { ...r01, rule: `${r01.rule as string} Count every attempt.` };
    const saved = await signedPost(
      m.app,
      'curated',
      { kind: 'rule', key: 'R01', body: edit, reason: 'a clearer limit' },
      'curator',
    );
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ version: 2, current: 1, written: true });
    expect((await get('/rules/R01')).json()).toMatchObject({ version: 1, body: r01 });
    expect((await get('/rules/R01?version=2')).json()).toMatchObject({ current: 1, body: edit });

    const approve = (version: number) =>
      signedPost(
        m.app,
        'curated/approve',
        { reason: 'reviewed', versions: [{ kind: 'rule', key: 'R01', version }] },
        'curator',
      );
    expect((await approve(2)).json()).toMatchObject({ approved: 1, written: true });
    expect((await get('/rules/R01')).json()).toMatchObject({ version: 2, body: edit });
    expect((await get('/rules/R01?version=1')).json()).toMatchObject({ current: 2, body: r01 });

    const before = await m.count(`"ChangeLog"`);
    expect((await approve(1)).json()).toMatchObject({ error: 'backward' });
    expect((await approve(9)).json()).toMatchObject({ error: 'no_version' });
    expect((await approve(2)).statusCode).toBe(200);
    expect(await m.count(`"ChangeLog"`)).toBe(before);

    expect((await get('/rules/R99')).statusCode).toBe(404);
    expect((await get('/rules/R01?version=0')).statusCode).toBe(400);
    const tenantWithNoBank = await signedPost(
      m.app,
      'curated',
      {
        kind: 'lesson',
        key: 'L-new',
        lesson: { text: 'Wait.', area: 'pacing', scope: 'tenant', confidence: 'low' },
        reason: 'a test',
      },
      'curator',
    );
    expect(tenantWithNoBank.statusCode).toBe(400);
  });
});

describe('a seed file whose hash differs', () => {
  it('refuses the whole seed, and nothing is written', async () => {
    const m = await memoryService();
    const dir = mkdtempSync(join(tmpdir(), 'memory-seed-'));
    try {
      cpSync(SEEDS, dir, { recursive: true });
      const file = join(dir, 'lessons.json');
      writeFileSync(file, readFileSync(file, 'utf8').replace('"medium"', '"high"'));
      await expect(seed({ dir, url: m.url, ...curator })).rejects.toThrow(SeedRefused);
      await expect(seed({ dir, url: m.url, ...curator })).rejects.toThrow(/lessons\.json/);
      expect(await m.count(`"ChangeLog"`)).toBe(0);
      expect(await m.count(`"CatalogVersion"`)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await m.app.close();
      await m.db.close();
    }
  });
});
