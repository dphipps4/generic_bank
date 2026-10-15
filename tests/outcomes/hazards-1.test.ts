import { describe, expect, it } from 'vitest';
import { brief, outcomeBank, run, TABLE } from './support.js';

// The outcome table, part 1 of 3: each hazard forced alone gives its one result.
const env = outcomeBank();

describe('every hazard, forced alone, gives its one result (1 of 3)', () => {
  for (const [hazard, want] of TABLE.slice(0, 6)) {
    it(`${hazard} → ${want.status}${want.code ? `: ${want.code}` : ''}`, async () => {
      expect(brief(await run(env, 'Everyday Checking', [hazard]))).toEqual(want);
    }, 240_000);
  }
});
