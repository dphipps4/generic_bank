// Bank 1's table against its evidence, with no browser: every row knows its own frame as its page
// and no other, and every answer and every trouble is in the frame it cites.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Frame, knows } from '@gb/runtime';
import { describe, expect, it } from 'vitest';
import { bank1, cents, leaf } from '../src/index.js';

const EVIDENCE = join(import.meta.dirname, '../../../docs/evidence/bank-1');
type Kept = { frame: string; tree?: string; same?: string };
const walks = new Map<string, Kept[]>();
function frame(ref: string): Frame {
  const [walk, n] = ref.split('/') as [string, string];
  if (!walks.has(walk))
    walks.set(walk, JSON.parse(readFileSync(join(EVIDENCE, `${walk}.json`), 'utf8')).frames);
  const f = walks.get(walk)!.find((k) => k.frame === n);
  if (!f) throw new Error(`no frame ${ref}`);
  return f.same ? frame(f.same) : ({ tree: f.tree } as Frame);
}
const pages = bank1.rows.map((r) => ({ name: r.page, shows: r.shows, never: r.never ?? [] }));

describe("bank 1's table, against its evidence", () => {
  for (const row of bank1.rows)
    it(`knows ${row.frame} as the ${row.page} page`, () => {
      expect(knows(frame(row.frame), pages)).toBe(row.page);
    });

  for (const a of [...bank1.answers, ...bank1.trouble])
    it(`finds "${a.says}" in ${a.frame}`, () => {
      expect(frame(a.frame).tree.toLowerCase()).toContain(a.says.toLowerCase());
    });

  it('has a row for every end, and nothing to do on an end for its goal', () => {
    for (const [goal, page] of Object.entries(bank1.ends)) {
      const row = bank1.rows.find((r) => r.page === page);
      expect(row, page).toBeDefined();
      expect(row!.do[goal as 'balance'] ?? []).toEqual([]);
    }
  });
});

describe('reading a page', () => {
  it('takes the words of leaf lines only', () => {
    expect(leaf('- text: "Everyday Checking Account ending in 1234"')).toBe(
      'Everyday Checking Account ending in 1234',
    );
    expect(leaf(`- 'cell "Activity: Everyday Checking"'`)).toBe('Activity: Everyday Checking');
    expect(leaf('- cell "TRANSFER OUT GBX 7K2Q rent"')).toBe('TRANSFER OUT GBX 7K2Q rent');
    expect(leaf('- row "From: one To: two":')).toBeNull();
    expect(leaf(`- 'row "From: one To: two"':`)).toBeNull();
  });

  it('reads money as cents', () => {
    expect(cents('$1,234.56')).toBe(123_456);
    expect(cents('-$5.00')).toBe(-500);
    expect(cents('($5.00)')).toBe(-500);
    expect(cents('25.00')).toBe(2_500);
  });
});
