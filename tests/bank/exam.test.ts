// Bank 2 is the exam: nothing the factory's agents read, and nothing in the factory's code, holds a
// phrase that only bank 2 shows. Its words are read from its configuration here only to forbid them.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANTS, type Tenant } from '../../apps/bank/src/tenants.js';

const ROOT = join(import.meta.dirname, '../..');

/** Every word a bank's configuration puts on its pages. */
const wordsOf = (t: Tenant) => [
  t.brand,
  t.branch,
  ...Object.values(t.labels),
  ...(t.imageText?.labels ?? []),
  ...(t.imageText?.buttons ?? []),
  ...Object.values(t.redesign),
];

/** Words any English sentence might use, which no reader would take for a hint. */
const COMMON = new Set([
  'find',
  'next',
  'confirm',
  'transfers',
  'transactions',
  'statements',
  'activity',
  'amount',
]);

/** Bank 2's own phrases: none bank 1 shares, and none that is plain English on its own. */
const ONLY_BANK_2 = [
  ...new Set(
    wordsOf(TENANTS.example)
      .filter((w) => !wordsOf(TENANTS.generic).some((g) => g.toLowerCase() === w.toLowerCase()))
      .filter((w) => w.includes(' ') || !COMMON.has(w.toLowerCase())),
  ),
];

/** What the factory's agents read or are built from: its code, and memory's base lessons. */
const texts = () => {
  const dir = join(ROOT, 'apps/factory/src');
  return [
    ...readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ file: `apps/factory/src/${f}`, text: readFileSync(join(dir, f), 'utf8') })),
    {
      file: 'apps/memory/prisma/migrations/0005_base_lessons/migration.sql',
      text: readFileSync(
        join(ROOT, 'apps/memory/prisma/migrations/0005_base_lessons/migration.sql'),
        'utf8',
      ),
    },
  ];
};

describe('bank 2, the exam', () => {
  it('has phrases of its own to forbid', () => {
    expect(ONLY_BANK_2).toEqual(
      expect.arrayContaining([
        'Example Credit Union',
        'Find Member',
        'Passcode',
        'Look Up a Member',
      ]),
    );
  });

  it("is never named in the factory's code, its agents' instructions or the base lessons", () => {
    const found = texts().flatMap(({ file, text }) =>
      ONLY_BANK_2.filter((w) =>
        new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
      ).map((w) => `${file}: "${w}"`),
    );
    expect(found).toEqual([]);
  });
});
