// The memory suite: the seed (plan §K.10). The starting knowledge enters through memory's own door,
// as the curator, with one approval for the whole set: on a fresh database memory then serves the
// manifest's counts and the chain verifies; a second run writes nothing; a file whose hash differs
// from the manifest's is refused whole. All through the Memory service's API.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed, SeedRefused } from '../../apps/memory/src/seed.js';
import { memoryService, SEEDS, SIGNING_KEY, TOKENS } from '../support/memory.js';
import { as, changes } from './api.js';

let memory: Awaited<ReturnType<typeof memoryService>>;
const curator = () => ({ url: memory.url, token: TOKENS.curator, signingKey: SIGNING_KEY });
beforeAll(async () => {
  memory = await memoryService();
});
afterAll(async () => {
  await memory.close();
});

const COUNTS = { rules: 19, checks: 7, lessons: 268, scenarios: 49, approaches: 46 };

describe('the seed', () => {
  it('refuses a file whose hash differs from the manifest’s, whole, before writing anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-seed-'));
    try {
      cpSync(SEEDS, dir, { recursive: true });
      const file = join(dir, 'rules.json');
      writeFileSync(file, readFileSync(file, 'utf8').replace('"', '" '));
      await expect(seed({ dir, ...curator() })).rejects.toThrow(SeedRefused);
      expect(await changes(as(memory.url, 'curator'))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves on a fresh database every entry the manifest counts, and the chain verifies', async () => {
    const out = await seed({ dir: SEEDS, ...curator() });
    expect(out).toEqual({ served: COUNTS, written: 389, approved: 389 });
    const c = as(memory.url, 'runner');
    for (const [path, n] of Object.entries(COUNTS)) {
      const r = await c.get<{ entries?: unknown[]; lessons?: unknown[] }>(`/${path}`);
      expect((r.body.entries ?? r.body.lessons)!.length, path).toBe(n);
    }
    // Seeded lessons are curated patterns, confirmed by the person who approved the set.
    const lessons = (
      await c.get<{ lessons: { scope: string; state: string; role: string }[] }>('/lessons')
    ).body.lessons;
    expect(new Set(lessons.map((l) => `${l.scope} ${l.state} ${l.role}`))).toEqual(
      new Set(['pattern confirmed curator']),
    );
    expect((await c.get('/history/verify')).body).toMatchObject({ ok: true });
  });

  it('writes nothing the second time', async () => {
    const before = await changes(as(memory.url, 'curator'));
    expect(await seed({ dir: SEEDS, ...curator() })).toEqual({
      served: COUNTS,
      written: 0,
      approved: 0,
    });
    expect(await changes(as(memory.url, 'curator'))).toBe(before);
  });
});
