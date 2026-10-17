// Bank 1's table against its evidence, with no browser: every row knows its own frame as its page
// and no other, and every answer and every trouble is in the frame it cites.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Frame, knows } from '@gb/runtime';
import { describe, expect, it } from 'vitest';
import { decide } from '../../guardrails/src/index.js';
import { bank1, cents, leaf, readOf } from '../src/index.js';

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

  // Masked frames: the member's number and every value read as stars, which a read still fits.
  const lines = (ref: string) =>
    frame(ref)
      .tree.split('\n')
      .map(leaf)
      .filter((l): l is string => !!l)
      .join('\n');
  it('reads each balance tile on happy/11', () => {
    const tiles = [...lines('happy/11').matchAll(readOf(bank1.reads.balance))].map(
      (m) => m.groups!.name,
    );
    expect(tiles).toEqual(['Everyday Checking', 'Rainy Day Savings', 'Money Market']);
  });
  it('reads the review on transfer/17 and the confirmation on transfer/18', () => {
    expect(readOf(bank1.reads.review).exec(lines('transfer/17'))?.groups).toMatchObject({
      from: 'Everyday Checking, Account ending in ****',
      memo: 'GBX TEST lunch',
    });
    expect(readOf(bank1.reads.confirmation).exec(lines('transfer/18'))?.groups?.confirmation).toBe(
      'GB-*****-G',
    );
  });
  it("finds where the member's name shows, on happy/10 and happy/11", () => {
    const [results, summary] = bank1.reads.name;
    expect(readOf(results!, '********').exec(lines('happy/10'))?.groups?.name).toBe('********');
    expect(readOf(summary!, '********').exec(lines('happy/11'))?.groups?.name).toBe('********');
  });

  it('has a row for every end, and nothing to do on an end for its goal', () => {
    for (const [goal, page] of Object.entries(bank1.ends)) {
      const row = bank1.rows.find((r) => r.page === page);
      expect(row, page).toBeDefined();
      expect(row!.do[goal as 'balance'] ?? []).toEqual([]);
    }
  });
});

describe("bank 1's table, against the allowlists", () => {
  const JOB = { balance: 'check-balance', transfer: 'transfer', history: 'transfer' } as const;
  for (const row of bank1.rows)
    for (const [goal, steps] of Object.entries(row.do))
      for (const st of steps ?? [])
        for (const job of goal === 'any' ? Object.values(JOB) : [JOB[goal as keyof typeof JOB]]) {
          const [verb, control] =
            'type' in st
              ? (['type', st.type] as const)
              : 'choose' in st
                ? (['choose', st.choose] as const)
                : (['press', st.press] as const);
          it(`${job} may ${verb} "${control}" on the ${row.page} page`, () => {
            const secret = 'type' in st && ['$operator', '$password'].includes(st.value);
            const v = decide(job, row.screen ?? row.page, verb, control, {
              names: bank1.names ?? {},
              ...(secret ? { secret } : { typed: 'x' }),
            });
            expect(v).toEqual({ allowed: true });
          });
        }
  it('lets Submit through only with a grant', () => {
    const review = bank1.rows.find((r) => r.page === bank1.ends.transfer)!;
    expect(decide('transfer', review.screen!, 'press', bank1.submit.press)).toMatchObject({
      allowed: false,
      layer: 'approval grant',
    });
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
