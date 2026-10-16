// The memory suite: the knowledge pack (plan §K.4, §K.8). What a factory run starts from, in tiers:
// confirmed patterns, then the vendor's, then the bank's; then unconfirmed lessons, each labeled;
// then disputed ones with their reason; facts, episodes and the nearest drivers; all within a size
// budget, and never a hypothesis or an unconfirmed pattern. And `memory_query`: at most eight items
// and three facts. All through the Memory service's API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryService } from '../support/memory.js';
import { as, type Caller, HASH, propose, run } from './api.js';

let memory: Awaited<ReturnType<typeof memoryService>>;
let runner: Caller;
let factory: Caller;
let curator: Caller;

type Item = { id: string; text: string; state: string; scope: string; label?: string };
type Pack = {
  budget: number;
  size: number;
  tiers: Record<string, Item[]>;
  omitted: Record<string, number>;
};

/** A lesson a person writes and approves: served at once, as confirmed. */
async function curated(key: string, lesson: Record<string, unknown>) {
  const w = await curator.post<{ version: number }>('curated', {
    kind: 'lesson',
    key,
    reason: 'a person wrote it',
    lesson: { area: 'navigation', confidence: 'high', ...lesson },
  });
  expect(w.status).toBe(201);
  await curator.post('curated/approve', {
    reason: 'approved',
    versions: [{ kind: 'lesson', key, version: w.body.version }],
  });
}

beforeAll(async () => {
  memory = await memoryService();
  [runner, factory, curator] = (['runner', 'factory', 'curator'] as const).map((r) =>
    as(memory.url, r),
  );
  await curated('pat-1', {
    text: 'Wait for the page to settle before reading it.',
    scope: 'pattern',
  });
  await curated('ven-1', {
    text: 'The vendor’s console opens members with an Open link.',
    scope: 'vendor',
    vendor: 'corelink',
  });
  await curated('ten-1', {
    text: 'Example keeps its tab strip on a second origin.',
    scope: 'tenant',
    bank: 'example',
  });
  await curated('other-1', {
    text: 'Sample asks to acknowledge terms.',
    scope: 'tenant',
    bank: 'sample',
  });
  await run(factory, 'pack-b', 'example', { kind: 'factory', outcome: 'recommended' });
  await propose(factory, 'pack-b', 'Example sends the code without being asked.');
  await propose(factory, 'pack-b', 'Example may log out idle operators sooner.', { seen: false });
  const disputed = await propose(factory, 'pack-b', 'Example lists shares by age.');
  await propose(factory, 'pack-b', 'Every bank shows a notice after sign-in.', {
    scope: 'pattern',
  });
  await factory.post('hypotheses', {
    runId: 'pack-b',
    text: 'Example probably reloads its tabs twice.',
  });
  await run(runner, 'pack-c', 'example', { outcome: 'failed' });
  await factory.post('facts/invalidate', {
    lessonId: disputed,
    runId: 'pack-c',
    reason: 'they were listed by number',
    frames: ['f2'],
    evidenceHash: HASH,
  });
});
afterAll(async () => {
  await memory.close();
});

const pack = async (q = '') =>
  (await factory.get<Pack>(`/knowledge/pack?bank=example&vendor=corelink${q}`)).body;
const texts = (items: Item[]) => items.map((i) => i.text);

describe('the knowledge pack', () => {
  it('comes in tier order, labels everything unconfirmed, and never holds a hypothesis or an unconfirmed pattern', async () => {
    const p = await pack();
    expect(Object.keys(p.tiers)).toEqual([
      'patterns',
      'vendor',
      'tenant',
      'proposed',
      'disputed',
      'facts',
      'recent',
      'recurring',
      'drivers',
    ]);
    expect(texts(p.tiers.patterns!)).toEqual(['Wait for the page to settle before reading it.']);
    expect(texts(p.tiers.vendor!)).toEqual([
      'The vendor’s console opens members with an Open link.',
    ]);
    expect(texts(p.tiers.tenant!)).toEqual(['Example keeps its tab strip on a second origin.']);
    expect(p.tiers.proposed!.map((i) => [i.text, i.label])).toEqual(
      expect.arrayContaining([
        ['Example sends the code without being asked.', 'verify before relying'],
        ['Example may log out idle operators sooner.', 'a guess: verify before relying'],
      ]),
    );
    expect(p.tiers.proposed).toHaveLength(2);
    expect(p.tiers.disputed!.map((i) => i.label)).toEqual(['disputed: they were listed by number']);
    const all = JSON.stringify(p);
    expect(all).not.toContain('reloads its tabs');
    expect(all).not.toContain('notice after sign-in');
    expect(all).not.toContain('acknowledge terms');
    expect(p.size).toBeLessThanOrEqual(p.budget);
  });

  it('keeps to its budget, filling in rank order and counting what did not fit', async () => {
    const p = await pack('&budget=1000');
    expect(p.size).toBeLessThanOrEqual(1000);
    const omitted = Object.values(p.omitted).reduce((a, b) => a + b, 0);
    expect(omitted).toBeGreaterThan(0);
  });
});

describe('memory_query', () => {
  it('answers with at most eight items and three facts, never a hypothesis', async () => {
    const r = await factory.get<{ items: { kind: string; text?: string }[]; facts: unknown[] }>(
      `/knowledge/query?bank=example&vendor=corelink&q=${encodeURIComponent('code sign-in tabs reloads')}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(8);
    expect(r.body.facts.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(r.body)).not.toContain('reloads its tabs');
  });
});
