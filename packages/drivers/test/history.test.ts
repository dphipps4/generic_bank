import { describe, expect, it } from 'vitest';
import { readAgain } from '../src/index.js';

// After a transfer's submit, the history is read to find it. A read the bank got in the way of is
// read again; an answer (none found, one, two) stands and goes no further.
describe('the history check after a submit', () => {
  const reads = (...answers: number[]) => {
    let calls = 0;
    return { read: async () => answers[calls++]!, calls: () => calls };
  };

  it('reads again when the page could not be read, and stops at the first answer', async () => {
    const r = reads(-1, -1, 1);
    expect(await readAgain(r.read)).toBe(1);
    expect(r.calls()).toBe(3);
  });

  it('gives up after three reads that could not be read', async () => {
    const r = reads(-1, -1, -1, 1);
    expect(await readAgain(r.read)).toBe(-1);
    expect(r.calls()).toBe(3);
  });

  it('takes none found or two found as an answer, for a person, without reading again', async () => {
    for (const answer of [0, 2]) {
      const r = reads(answer, 1);
      expect(await readAgain(r.read)).toBe(answer);
      expect(r.calls()).toBe(1);
    }
  });
});
