// Search and the knowledge pack (plan §8, §A.6): hybrid search fused by reciprocal rank, the
// pack in tiers within its budget, and the question behind `memory_query`. Everything is written
// through the door, except the states no write makes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asVector } from '../src/embed.js';
import { episodes } from '../src/episodes.js';
import { knowledgeRoutes, QUERY_ITEMS, TIERS } from '../src/knowledge.js';
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
const run = (id: string, bank: string, vendor: string) =>
  post('episodes/runs', {
    id,
    kind: 'factory',
    bank,
    vendor,
    outcome: 'succeeded',
    startedAt: '2026-03-04T05:06:07.000Z',
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

/** A state no write makes: a confirmed lesson, put in the tables directly. */
async function confirmed(
  id: string,
  l: { text: string; scope?: string; bank?: string; vendor?: string; why?: string },
) {
  await db.query(`INSERT INTO "Lesson" (id, current) VALUES ($1, 1)`, [id]);
  await db.query(
    `INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scope, bank, vendor, state,
       "retiredAtBanks", confidence, seen, evidence, reason, role, embedding)
     VALUES ($1, 1, $2, $3, '{}', 'statements', $4::"Scope", $5, $6, 'confirmed', '{}', 'medium', false, '[]',
       'a test', 'curator', $7::vector)`,
    [
      id,
      l.text,
      l.why ?? null,
      l.scope ?? 'pattern',
      l.bank ?? null,
      l.vendor ?? null,
      asVector(await testEmbed(l.text)),
    ],
  );
}

/** A state only the rules write: a new version of the lesson, made current. */
async function setState(id: string, state: string, reason: string, retiredAtBanks: string[] = []) {
  await db.query(
    `INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scenario, scope, bank, vendor, state,
       "retiredAtBanks", confidence, seen, evidence, reason, role, embedding)
     SELECT "lessonId", version + 1, text, why, signals, area, scenario, scope, bank, vendor, $2::"LessonState",
       $4, confidence, seen, evidence, $3, 'curator', embedding
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
  app = buildServer({ db, memory, door: testDoor(), writes: episodes(memory, testEmbed) });
  knowledgeRoutes(app, db, testEmbed);

  // Bank 1 (generic) and bank 2 (example), both CoreLink.
  for (const id of ['gen-1', 'gen-2']) await run(id, 'generic', 'corelink');
  for (const id of ['ex-1', 'ex-2']) await run(id, 'example', 'corelink');

  // Thirteen confirmed patterns, and a confirmed vendor and tenant lesson.
  await confirmed('P-statements', { text: STATEMENTS, why: 'A count taken early is short.' });
  for (const [i, text] of PATTERNS.entries()) await confirmed(`P-${i + 1}`, { text });
  await confirmed('V-1', {
    text: 'CoreLink opens statements in a new window.',
    scope: 'vendor',
    vendor: 'corelink',
  });
  await confirmed('T-1', {
    text: 'This bank shows a branch notice above its menu.',
    scope: 'tenant',
    bank: 'example',
  });

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
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const lessonsOf = (p: Pack) => TIERS.flatMap((t) => p.tiers[t]!);

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
    // Never an unconfirmed pattern, another bank's lesson, or one retired here.
    const body = JSON.stringify(p);
    for (const never of ['Unconfirmed patterns', 'marquee', 'by text'])
      expect(body).not.toContain(never);

    const size = Object.values(p.tiers)
      .flat()
      .reduce((n, item) => n + JSON.stringify(item).length, 0);
    expect(p.size).toBe(size);
    expect(p.size).toBeLessThanOrEqual(p.budget);
    expect(p.omitted).toEqual({});
  });

  it('within a small budget, counts the lessons left out', async () => {
    const full = await pack('bank=example&vendor=corelink');
    const p = await pack('bank=example&vendor=corelink&budget=2500');
    expect(p.size).toBeLessThanOrEqual(2500);
    expect(p.omitted.patterns).toBeGreaterThan(0);
    for (const t of TIERS) {
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
  });

  it('needs a token and a bank', async () => {
    expect((await app.inject({ url: '/knowledge/pack?bank=example' })).statusCode).toBe(401);
    expect((await get('/knowledge/pack?vendor=corelink')).statusCode).toBe(400);
  });
});

describe('memory_query', () => {
  it('answers with at most eight served lessons, the most like the question first', async () => {
    const r = await get(
      `/knowledge/query?bank=example&vendor=corelink&q=${encodeURIComponent('statements list still loading')}`,
    );
    expect(r.statusCode).toBe(200);
    const { items } = r.json() as { items: Item[] };
    expect(items).toHaveLength(QUERY_ITEMS);
    expect(items[0]).toMatchObject({ id: 'P-statements', kind: 'lesson' });
    for (const i of items) expect(i.state === 'confirmed' || !!i.label).toBe(true);
    const body = JSON.stringify(items);
    for (const never of ['Unconfirmed patterns', 'marquee']) expect(body).not.toContain(never);
  });
});
