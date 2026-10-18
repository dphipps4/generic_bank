import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Listed, score, type Truth } from '../src/measure.js';

// The scoring that decides whether the models see well enough, on bank 2's real sign-in truth.
const truth = JSON.parse(
  readFileSync(new URL('../measure/bank-2/01-sign-in.json', import.meta.url), 'utf8'),
) as Truth;

describe('measuring sight', () => {
  it('gives a perfect list full marks, a wrong one none, and counts what is invented', () => {
    const fields = truth.controls.filter((c) => c.kind !== 'button');
    const perfect: Listed[] = truth.controls.map((c, i) => ({
      id: `i${i + 1}`,
      kind: c.kind,
      label: c.kind === 'button' ? c.name : (['USERNAME:', 'PASSCODE:'][fields.indexOf(c)] ?? ''),
      labelFrom: c.kind === 'button' ? 'text' : 'image',
      box: c.box,
    }));
    expect(score(truth, perfect)).toMatchObject({
      controls: 3,
      found: 3,
      pictureFields: 2,
      read: 2,
      invented: 0,
    });
    // Boxes 100 pixels off, and a button where there is none: nothing placed, one invented.
    const off = perfect.map((p) => ({ ...p, box: { ...p.box, y: p.box.y + 100 } }));
    expect(score(truth, off)).toMatchObject({ found: 0, read: 0, invented: 3 });
  });
});
