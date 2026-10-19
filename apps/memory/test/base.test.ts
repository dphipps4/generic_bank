// The base lessons: written by a migration, so an empty memory holds them from its first start,
// each agent is served its own, a run can dispute one but never retire it, and a person can.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedMissing } from '../src/embed.js';
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
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

type Item = { id: string; base?: boolean; state: string; label?: string };
type Pack = { tiers: Record<string, Item[]> };

const post = async (write: string, body: unknown, role: Role = 'factory') => {
  const r = await signedPost(app, write, body, role);
  expect(r.statusCode, JSON.stringify(r.json())).toBeLessThan(300);
  return r.json() as Record<string, unknown>;
};
const pack = async (query: string) => {
  const r = await app.inject({
    url: `/knowledge/pack?${query}`,
    headers: { authorization: `Bearer ${TOKENS.factory}` },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Pack;
};
const baseIds = (p: Pack) =>
  Object.values(p.tiers)
    .flat()
    .filter((l) => l.base)
    .map((l) => l.id)
    .sort();
const run = (id: string, bank: string) =>
  post('episodes/runs', {
    id,
    kind: 'factory',
    bank,
    vendor: 'corelink',
    outcome: 'succeeded',
    startedAt: new Date().toISOString(),
  });

const SCOUT = [
  'base-scout-confirm',
  'base-scout-goal-start',
  'base-scout-ids',
  'base-scout-picture',
  'base-scout-plan',
  'base-scout-start-page',
];
const SUPERVISOR = [
  'base-supervisor-accept',
  'base-supervisor-cheapest-check',
  'base-supervisor-goal-start',
  'base-supervisor-picture-first',
  'base-supervisor-same-box',
];
const BOTH = ['base-lessons-behavior', 'base-lessons-start-page'];

describe('the base lessons, from an empty start', () => {
  it('are all thirteen there, with no run, for any bank', async () => {
    for (const bank of ['example', 'generic', 'a-bank-never-seen'])
      expect(baseIds(await pack(`bank=${bank}`))).toEqual(
        [...SCOUT, ...SUPERVISOR, ...BOTH].sort(),
      );
  });

  it("serve each agent its own, and the ones for both, never the other's", async () => {
    expect(baseIds(await pack('bank=example&for=scout'))).toEqual([...SCOUT, ...BOTH].sort());
    expect(baseIds(await pack('bank=example&for=supervisor'))).toEqual(
      [...SUPERVISOR, ...BOTH].sort(),
    );
  });

  it('come first, as confirmed patterns that say they are base, within any budget', async () => {
    const p = await pack('bank=example&for=scout&budget=1000');
    expect(p.tiers.patterns!.slice(0, 8).every((l) => l.base)).toBe(true);
    for (const l of p.tiers.patterns!.filter((x) => x.base)) {
      expect(l.state).toBe('confirmed');
      expect(l.label).toMatch(/^a base lesson/);
    }
  });

  it('are embedded at start, so search finds them by meaning', async () => {
    expect(await embedMissing(db, testEmbed)).toBeGreaterThanOrEqual(13);
    expect(await embedMissing(db, testEmbed)).toBe(0);
  });
});

describe('a base lesson, against the rules', () => {
  it('is disputed by runs at two banks, and still served, saying so', async () => {
    await run('r1', 'example');
    await run('r2', 'generic');
    for (const runId of ['r1', 'r2'])
      expect(
        await post('facts/invalidate', {
          lessonId: 'base-scout-plan',
          runId,
          reason: 'a plan cost more than it saved',
          frames: [`${runId}/001`],
          evidenceHash: 'ab'.repeat(32),
        }),
      ).toMatchObject({ written: true, rule: 'dispute a base lesson', state: 'disputed' });
    const served = (await pack('bank=example&for=scout')).tiers;
    const plan = Object.values(served)
      .flat()
      .find((l) => l.id === 'base-scout-plan');
    expect(plan).toMatchObject({ state: 'disputed', base: true });
    expect(plan!.label).toMatch(/a base lesson, still served$/);
  });

  it('is retired by a person', async () => {
    await post(
      'lessons/retire',
      { lessonId: 'base-lessons-behavior', reason: 'no longer how we work' },
      'curator',
    );
    expect(baseIds(await pack('bank=example'))).not.toContain('base-lessons-behavior');
  });
});

describe("a run's lesson", () => {
  it('is served only to the agent that wrote it', async () => {
    await run('r3', 'example');
    const written = await post('lessons/proposals', {
      runId: 'r3',
      audience: 'scout',
      text: 'A search lists its matches in the same panel, and the matching row opens the record.',
      area: 'navigation',
      scope: 'tenant',
      confidence: 'medium',
      seen: true,
      frames: ['r3/004'],
      evidenceHash: 'cd'.repeat(32),
    });
    const ids = (p: Pack) =>
      Object.values(p.tiers)
        .flat()
        .map((l) => l.id);
    expect(ids(await pack('bank=example&for=scout'))).toContain(written.lesson);
    expect(ids(await pack('bank=example&for=supervisor'))).not.toContain(written.lesson);
  });
});
