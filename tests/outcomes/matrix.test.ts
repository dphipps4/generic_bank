import { describe, expect, it } from 'vitest';
import { brief, CASES, outcomeBank, run } from './support.js';

// The hazard matrix: hazards forced alone on the healthy member, through bank 1's crawler, against
// the result the hazard lab promises beside each. MATRIX=1 runs a random fifth of them, MATRIX=all
// every one (about three minutes); the suite proves one row of each kind on every change.
const env = outcomeBank();
const all = process.env.MATRIX === 'all';
const picked = all
  ? CASES.hazards
  : [...CASES.hazards]
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.ceil(CASES.hazards.length / 5));

describe.runIf(process.env.MATRIX === '1' || all)('hazards on the crawler', () => {
  for (const h of picked)
    it(`${h.hazard}: ${h.expected.code ?? h.expected.status}`, async () => {
      expect(brief(await run(env, 'Everyday Checking', [h.hazard]))).toEqual(brief(h.expected));
    }, 120_000);
});
