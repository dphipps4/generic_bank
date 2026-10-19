// What the agents read is what a person sees: a closed list shows only its chosen option. Proven on
// bank 1's recorded walk, the same kind of list run 28 misread on another bank.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chosenIn, leaf, seen } from '../src/crawl.js';

const EVIDENCE = join(import.meta.dirname, '../../../docs/evidence/bank-1');
type Frame = { frame: number | string; tree?: string };
const walk = (name: string): Frame[] =>
  JSON.parse(readFileSync(join(EVIDENCE, `${name}.json`), 'utf8')).frames;
const frame = (name: string, n: string) => walk(name).find((f) => String(f.frame) === n)!.tree!;

describe('the words a person sees', () => {
  it('show a list with nothing chosen as its placeholder', () => {
    const tree = frame('transfer', '12');
    expect(chosenIn(tree)).toEqual(['Choose an account', 'Choose an account']);
    expect(seen(tree).filter((w) => w === 'Choose an account')).toHaveLength(2);
  });

  it('show a chosen list as its choice, and none of its other options', () => {
    const tree = frame('transfer', '14');
    expect(chosenIn(tree)).toEqual([
      expect.stringMatching(/^Everyday Checking, Account ending in 9706/),
      expect.stringMatching(/^Rainy Day Savings, Account ending in 4309/),
    ]);
    expect(seen(tree)).not.toContain('Choose an account');
    expect(seen(tree).filter((w) => w.startsWith('Money Market, Account ending'))).toEqual([]);
  });

  it('show each list as it stands: one chosen, one not', () => {
    expect(chosenIn(frame('transfer', '13'))).toEqual([
      expect.stringMatching(/^Everyday Checking/),
      'Choose an account',
    ]);
  });

  it('leave out nothing but unchosen options, on every frame bank 1 was walked through', () => {
    for (const file of readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')))
      for (const f of walk(file.replace(/\.json$/, ''))) {
        if (!f.tree) continue;
        const every = f.tree.split('\n').filter((l) => leaf(l));
        const kept = new Set(seen(f.tree));
        for (const line of every)
          if (!kept.has(leaf(line)!))
            expect(line, `${file} ${f.frame}`).toMatch(/^\s*- option (?!.*\[selected\])/);
      }
  });
});
