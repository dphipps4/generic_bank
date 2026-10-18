// Search and the knowledge pack (plan §8, §A.6): hybrid search fused by reciprocal rank,
// the episodes a run reads, the pack in tiers within its budget, and the question behind
// `memory_query`. Everything is written through the door, except the states only the rules write.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogRoutes, curated } from '../src/curated.js';
import { episodes } from '../src/episodes.js';
import { knowledgeRoutes, QUERY_FACTS, QUERY_ITEMS, TIERS } from '../src/knowledge.js';
import { openMemory, type Role } from '../src/memory.js';
import { fuse } from '../src/search.js';
import { buildServer } from '../src/server.js';
import { memoryDb, signedPost, testDoor, testEmbed, TOKENS } from './db.js';

let db: Awaited<ReturnType<typeof memoryDb>>;
let app: ReturnType<typeof buildServer>;

const post = async (write: string, body: unknown, role: Role = 'factory') => {
  const r = await signedPost(app, write, body, role);
  expect(r.statusCode, JSON.stringify(r.json())).toBeLessThan(300);
  return r.json() as Record<string, unknown>;
};
const get = (url: string) =>
  app.inject({ url, headers: { authorization: `Bearer ${TOKENS.runner}` } });

type Item = { id: string; state: string; label?: string; text: string; kind?: string };
type Pack = {
  budget: number;
  size: number;
  tiers: Record<string, (Item & Record<string, unknown>)[]>;
  omitted: Record<string, number>;
};
const pack = async (query: string) => {
  const r = await get(`/knowledge/pack?${query}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Pack;
};

const HASH = 'ab'.repeat(32);
const run = (id: string, bank: string, vendor: string, extra: Record<string, unknown> = {}) =>
  post('episodes/runs', {
    id,
    kind: 'factory',
    bank,
    vendor,
    outcome: 'succeeded',
    startedAt: '2026-03-04T05:06:07.000Z',
    ...extra,
  });
const attempt = (runId: string, n: number, at: string, failure?: string) =>
  post('episodes/attempts', {
    runId,
    n,
    outcome: failure ? 'failed' : 'succeeded',
    failure,
    frames: [`${runId}/00${n}`],
    at,
  });
const propose = async (runId: string, text: string, scope: string, seen = true) =>
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
const curate = (key: string, lesson: Record<string, unknown>) =>
  post(
    'curated',
    {
      kind: 'lesson',
      key,
      lesson: { area: 'statements', confidence: 'medium', scope: 'pattern', ...lesson },
      reason: 'a test',
    },
    'curator',
  );

/** A state only the rules write: a new version of the lesson, made current. */
async function setState(id: string, state: string, reason: string, retiredAtBanks: string[] = []) {
  await db.query(
    `INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scenario, scope, bank, vendor, state,
       "retiredAtBanks", confidence, seen, evidence, reason, role, embedding)
     SELECT "lessonId", version + 1, text, why, signals, area, scenario, scope, bank, vendor, $2::"LessonState",
       $4, confidence, seen, evidence, $3, 'system', embedding
     FROM "LessonVersion" v JOIN "Lesson" l ON l.id = v."lessonId" AND l.current = v.version WHERE l.id = $1`,
    [id, state, reason, retiredAtBanks],
  );
  await db.query(`UPDATE "Lesson" SET current = current + 1 WHERE id = $1`, [id]);
}

const STATEMENTS = 'Wait for the statements list to finish loading before counting its rows.';
const PATTERNS = Array.from(
  { length: 12 },
  (_, i) => `Pattern ${i + 1} of the starting set: read the screen model before each step.`,
);
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await memoryDb();
  const memory = openMemory(db);
  const writes = { ...episodes(memory, testEmbed), ...curated(memory, testEmbed) };
  app = buildServer({ db, memory, door: testDoor(), writes });
  catalogRoutes(app, db);
  knowledgeRoutes(app, db, testEmbed);

  // Bank 1 (generic) runs a promoted CoreLink driver; a driver at another bank was demoted; a bank
  // of another vendor has its own.
  await run('gen-p', 'generic', 'corelink', { driver: 'corelink-generic', mark: 'promoted' });
  await run('old-p', 'retired-bank', 'corelink', { driver: 'corelink-old', mark: 'promoted' });
  await run('old-d', 'retired-bank', 'corelink', {
    driver: 'corelink-old',
    mark: 'demoted',
    startedAt: '2026-04-01T00:00:00.000Z',
  });
  await run('far-p', 'elsewhere', 'other', { driver: 'other-elsewhere', mark: 'promoted' });
  for (const id of ['gen-1', 'gen-2']) await run(id, 'generic', 'corelink', { kind: 'task' });
  // Bank 2 (example): two factory runs.
  await run('ex-1', 'example', 'corelink');
  await run('ex-2', 'example', 'corelink');
  await attempt('gen-1', 1, '2026-03-04T06:00:00.000Z', 'code_never_arrived');
  await attempt('gen-2', 1, '2026-03-05T06:00:00.000Z', 'code_never_arrived');
  await attempt('ex-1', 1, '2026-03-06T06:00:00.000Z', 'statements_list_empty');
  await attempt('ex-1', 2, '2026-03-06T06:05:00.000Z');
  await attempt('ex-2', 1, '2026-03-07T06:00:00.000Z', 'code_never_arrived');
  await post('hypotheses', { runId: 'ex-1', text: 'Hypothetically the tab strip reloads twice.' });

  // The curated set: thirteen patterns approved, one waiting; a vendor and a tenant lesson.
  const keys = ['P-statements', ...PATTERNS.map((_, i) => `P-${i + 1}`)];
  await curate('P-statements', { text: STATEMENTS, why: 'A count taken early is short.' });
  for (const [i, text] of PATTERNS.entries()) await curate(`P-${i + 1}`, { text });
  await curate('V-1', {
    text: 'CoreLink opens statements in a new window.',
    scope: 'vendor',
    vendor: 'corelink',
  });
  await curate('T-1', {
    text: 'This bank shows a branch notice above its menu.',
    scope: 'tenant',
    bank: 'example',
  });
  await post(
    'curated/approve',
    {
      reason: 'a test',
      versions: [...keys, 'V-1', 'T-1'].map((key) => ({ kind: 'lesson', key, version: 1 })),
    },
    'curator',
  );
  await curate('P-pending', { text: 'Pending advice that no person has approved yet.' });

  // What runs proposed: a pattern (never served unconfirmed), lessons of this bank and the vendor,
  // and a lesson of bank 1 alone.
  ids.pattern = await propose(
    'ex-1',
    'Unconfirmed patterns stay unserved until confirmed.',
    'pattern',
  );
  ids.seen = await propose('ex-1', 'The member search pages its results ten at a time.', 'tenant');
  ids.guess = await propose(
    'gen-1',
    'Statements older than a year sit behind an archive tab.',
    'vendor',
    false,
  );
  ids.other = await propose('gen-1', 'Generic shows a marquee of notices on every page.', 'tenant');
  ids.disputed = await propose('ex-2', 'The statements list sorts newest first.', 'tenant');
  await setState(ids.disputed, 'disputed', 'run ex-2 saw it sort oldest first');
  ids.retiredHere = await propose(
    'gen-2',
    'Every CoreLink bank asks for the code by text.',
    'vendor',
  );
  await setState(ids.retiredHere, 'proposed', 'wrong at example', ['example']);

  await post(
    'curated',
    {
      kind: 'scenario',
      key: 'SC-900',
      body: {
        id: 'SC-900',
        title: 'A statements list still loading',
        recognize: 'The statements list shows fewer rows than the account has, and a spinner.',
      },
      reason: 'a test',
    },
    'curator',
  );
  await post(
    'curated/approve',
    { reason: 'a test', versions: [{ kind: 'scenario', key: 'SC-900', version: 1 }] },
    'curator',
  );
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const lessonsOf = (p: Pack) => TIERS.slice(0, 5).flatMap((t) => p.tiers[t]!);

describe('hybrid search', () => {
  it('fuses ranked lists by reciprocal rank', () => {
    // b is second and first; a is first only; c is second only.
    expect(fuse(['a', 'b'], ['b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(fuse(['x'], [])).toEqual(['x']);
  });
});

describe('the knowledge pack for bank 2', () => {
  it('comes in tier order, labels every unconfirmed lesson, and fits its budget', async () => {
    const p = await pack('bank=example&vendor=corelink');
    expect(Object.keys(p.tiers)).toEqual([...TIERS]);
    const keys = (t: string) => p.tiers[t]!.map((l) => l.id).sort();

    expect(keys('patterns')).toEqual(
      ['P-statements', ...PATTERNS.map((_, i) => `P-${i + 1}`)].sort(),
    );
    expect(keys('vendor')).toEqual(['V-1']);
    expect(keys('tenant')).toEqual(['T-1']);
    expect(keys('proposed')).toEqual([ids.guess, ids.seen].sort());
    expect(keys('disputed')).toEqual([ids.disputed]);

    // What is confirmed is known and carries no label; everything else says what it is.
    for (const l of lessonsOf(p))
      if (l.state === 'confirmed') expect(l.label).toBeUndefined();
      else expect(l.label, l.text).toBeDefined();
    const label = (id: string) => lessonsOf(p).find((l) => l.id === id)!.label;
    expect(label(ids.seen!)).toBe('verify before relying');
    expect(label(ids.guess!)).toBe('a guess: verify before relying');
    expect(label(ids.disputed!)).toBe('disputed: run ex-2 saw it sort oldest first');
    // A seeded (curated) lesson rests on no frame, and still is no guess.
    expect(p.tiers.patterns!.find((l) => l.id === 'P-1')).toMatchObject({
      seen: false,
      state: 'confirmed',
    });

    // Never a hypothesis, an unconfirmed or unapproved pattern, another bank's lesson, or one
    // retired here.
    const body = JSON.stringify(p);
    for (const never of [
      'Hypothetically',
      'Pending advice',
      'Unconfirmed patterns',
      'marquee',
      'by text',
    ])
      expect(body).not.toContain(never);

    // The bank's latest attempts, the vendor's recurring failures, and the two nearest drivers.
    expect(p.tiers.recent!.map((a) => [a.run, a.n])).toEqual([
      ['ex-2', 1],
      ['ex-1', 2],
      ['ex-1', 1],
    ]);
    expect(p.tiers.recurring).toEqual([
      expect.objectContaining({
        failure: 'code_never_arrived',
        runs: 3,
        banks: ['example', 'generic'],
      }),
    ]);
    expect(p.tiers.drivers!.map((d) => d.driver)).toEqual(['corelink-generic', 'other-elsewhere']);

    const size = Object.values(p.tiers)
      .flat()
      .reduce((n, item) => n + JSON.stringify(item).length, 0);
    expect(p.size).toBe(size);
    expect(p.size).toBeLessThanOrEqual(p.budget);
    expect(p.omitted).toEqual({});
  });

  it('within a small budget, keeps the episodes and drivers, and counts the lessons left out', async () => {
    const full = await pack('bank=example&vendor=corelink');
    const p = await pack('bank=example&vendor=corelink&budget=2500');
    expect(p.size).toBeLessThanOrEqual(2500);
    expect(p.tiers.drivers).toHaveLength(2);
    expect(p.tiers.recent).toHaveLength(3);
    expect(p.omitted.patterns).toBeGreaterThan(0);
    for (const t of TIERS.slice(0, 5)) {
      const kept = p.tiers[t]!.map((l) => l.id);
      // In the full pack's rank order, with every lesson either kept or counted.
      expect(full.tiers[t]!.map((l) => l.id).filter((id) => kept.includes(id))).toEqual(kept);
      expect(kept.length + (p.omitted[t] ?? 0)).toBe(full.tiers[t]!.length);
    }
  });

  it('puts the lessons most like what the run is for first', async () => {
    const p = await pack(
      `bank=example&vendor=corelink&q=${encodeURIComponent('statements list loading rows')}`,
    );
    expect(p.tiers.patterns![0]).toMatchObject({
      id: 'P-statements',
      why: 'A count taken early is short.',
    });
  });

  it('serves bank 1 its own lessons, and not bank 2’s', async () => {
    const p = await pack('bank=generic&vendor=corelink');
    expect(p.tiers.tenant).toEqual([]);
    expect(p.tiers.proposed!.map((l) => l.id).sort()).toEqual(
      [ids.guess, ids.other, ids.retiredHere].sort(),
    );
    expect(p.tiers.drivers![0]).toMatchObject({ driver: 'corelink-generic', bank: 'generic' });
  });

  it('needs a token and a bank', async () => {
    expect((await app.inject({ url: '/knowledge/pack?bank=example' })).statusCode).toBe(401);
    expect((await get('/knowledge/pack?vendor=corelink')).statusCode).toBe(400);
  });
});

describe('memory_query', () => {
  beforeAll(async () => {
    const fact = (
      bank: string,
      predicate: string,
      object: string,
      expiredAt: string | null = null,
    ) =>
      db.query(
        `INSERT INTO "Fact" (bank, predicate, object, "runId", "validAt", "expiredAt")
         VALUES ($1, $2, $3, 'ex-1', '2026-03-06T00:00:00Z', $4)`,
        [bank, predicate, object, expiredAt],
      );
    await fact('example', 'has_screen', 'statements.list');
    await fact('example', 'has_screen', 'statements.detail');
    await fact('example', 'statements_open_in', 'a new window');
    await fact('example', 'statements_paged_by', 'ten rows');
    // No longer believed, and another bank's.
    await fact('example', 'has_screen', 'statements.archive', '2026-03-07T00:00:00Z');
    await fact('generic', 'has_screen', 'statements.list');
  });

  it('answers with at most eight items and three served facts of the bank', async () => {
    const r = await get(
      `/knowledge/query?bank=example&vendor=corelink&q=${encodeURIComponent('statements list still loading')}`,
    );
    expect(r.statusCode).toBe(200);
    const { items, facts } = r.json() as { items: Item[]; facts: { object: string }[] };
    expect(items).toHaveLength(QUERY_ITEMS);
    expect(
      items
        .map((i) => i.id)
        .slice(0, 2)
        .sort(),
    ).toEqual(['P-statements', 'SC-900']);
    expect(items.find((i) => i.id === 'SC-900')).toMatchObject({ kind: 'scenario' });
    for (const i of items.filter((x) => x.kind === 'lesson'))
      expect(i.state === 'confirmed' || !!i.label).toBe(true);
    const body = JSON.stringify(items);
    for (const never of ['Hypothetically', 'Pending advice', 'Unconfirmed patterns', 'marquee'])
      expect(body).not.toContain(never);

    expect(facts).toHaveLength(QUERY_FACTS);
    expect(facts.map((f) => f.object)).not.toContain('statements.archive');
  });
});

describe('episodes', () => {
  it('finds the failures most like a question, across the vendor or at one bank', async () => {
    const q = encodeURIComponent('the staff code did not arrive');
    const r = (await get(`/episodes/search?q=${q}&vendor=corelink`)).json() as {
      failures: { failure: string; runs: number }[];
    };
    expect(r.failures[0]).toMatchObject({ failure: 'code_never_arrived', runs: 3 });
    const one = (await get(`/episodes/search?q=${q}&bank=example`)).json() as typeof r;
    expect(one.failures[0]).toMatchObject({ failure: 'code_never_arrived', runs: 1 });
    expect(one.failures.map((f) => f.failure).sort()).toEqual([
      'code_never_arrived',
      'statements_list_empty',
    ]);
  });

  it('reads a bank’s latest attempts and a vendor’s recurring failures', async () => {
    const recent = (await get('/episodes/recent?bank=example&limit=2')).json() as {
      attempts: unknown[];
    };
    expect(recent.attempts).toEqual([
      expect.objectContaining({ run: 'ex-2', n: 1, failure: 'code_never_arrived' }),
      expect.objectContaining({ run: 'ex-1', n: 2, outcome: 'succeeded' }),
    ]);
    expect((await get('/episodes/recurring?vendor=other')).json()).toEqual({ failures: [] });
    expect((await get('/episodes/recurring')).statusCode).toBe(400);
  });
});
