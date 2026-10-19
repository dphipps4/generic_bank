// The base lessons memory serves from the first start are also in the instructions of the agent
// each is for, word for word, so the two never drift apart.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LESSONS } from '../src/memory.js';
import { SCOUT } from '../src/run.js';
import { DIAGNOSE, MECHANICS, SYSTEM } from '../src/supervisor.js';

const SQL = readFileSync(
  join(import.meta.dirname, '../../memory/prisma/migrations/0005_base_lessons/migration.sql'),
  'utf8',
);
/** Each base lesson's id, text and audience, as the migration writes it. */
const BASE = [
  ...SQL.matchAll(/\('(base-[a-z-]+)', 1, '((?:[^']|'')*)'.*'curator', '(\w+)'\)/g),
].map(([, id, text, audience]) => ({ id: id!, text: text!.replace(/''/g, "'"), audience }));

describe("Part 7, in the agents' instructions", () => {
  it('has all thirteen base lessons to check', () => {
    expect(BASE).toHaveLength(13);
  });

  it("puts every base lesson in the instructions of the agent it's for", () => {
    const missing = BASE.flatMap(({ id, text, audience }) => {
      const where =
        audience === 'scout'
          ? [SCOUT]
          : audience === 'supervisor'
            ? [SYSTEM]
            : [LESSONS('scout'), LESSONS('supervisor')];
      return where.every((w) => w.includes(text)) ? [] : [id];
    });
    expect(missing).toEqual([]);
  });

  it("keeps each agent's lines out of the other's instructions", () => {
    for (const { id, text, audience } of BASE) {
      if (audience === 'scout') expect(SYSTEM, id).not.toContain(text);
      if (audience === 'supervisor') expect(SCOUT, id).not.toContain(text);
    }
  });
});

describe("the agents' instructions", () => {
  it('are whole: each ends on its own last sentence', () => {
    expect(SCOUT.endsWith('a lesson is advice to test in this run, not a fact.')).toBe(true);
    expect(SYSTEM.endsWith('a transfer ends at its review page.')).toBe(true);
    expect(MECHANICS.endsWith('the Scout keeps its own.')).toBe(true);
    expect(DIAGNOSE.endsWith('Mark anything you did not test as a guess.')).toBe(true);
    for (const who of ['scout', 'supervisor'] as const)
      expect(
        LESSONS(who).endsWith('each with why in one line and the frames of this run that show it.'),
      ).toBe(true);
  });

  it('never close their text early with a bare backtick: what follows would be a type, not words', () => {
    const dir = join(import.meta.dirname, '../src');
    const cut = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /` as `/.test(readFileSync(join(dir, f), 'utf8')));
    expect(cut).toEqual([]);
  });
});
