import { describe, expect, it } from 'vitest';
import { distance, MAX_DISTANCE } from '@gb/screen';
import { lastFour } from '../src/corelink/check-balance.js';
import { GENERIC_BANK, PROFILES } from '../src/corelink/profiles.js';
import { isAccount } from '../src/corelink/transfer.js';

// The hand-written profiles, and the pure parts of the driver they feed: the factory starts its
// repairs from these, so each must be whole, and must say what its bank draws.

describe('the CoreLink profiles', () => {
  it('cover both banks, each in the same shape as Generic Bank’s', () => {
    expect(Object.keys(PROFILES).sort()).toEqual(['example', 'generic']);
    for (const [bank, p] of Object.entries(PROFILES)) {
      expect(p.bank).toBe(bank);
      expect(Object.keys(p).sort()).toEqual(Object.keys(GENERIC_BANK).sort());
      expect(Object.keys(p.words).sort()).toEqual(Object.keys(GENERIC_BANK.words).sort());
      // A menu and a notice to dismiss belong to a redesign: a bank without one has neither.
      for (const [name, words] of Object.entries(p.words))
        if (name !== 'menu' && name !== 'dismiss') expect(words.length).toBeGreaterThan(0);
    }
  });

  it('read the last four digits from each bank’s account wording', () => {
    const drawn: Record<string, string> = {
      generic: 'Account ending in 1195',
      example: 'Share ****1195-S01',
    };
    for (const [bank, wording] of Object.entries(drawn)) {
      expect(lastFour(PROFILES[bank]!.accountWording, wording), bank).toBe('1195');
      expect(
        isAccount(`Everyday Checking, ${wording}`, '1195', PROFILES[bank]!.accountWording),
      ).toBe(true);
      expect(
        isAccount(`Everyday Checking, ${wording}`, '2611', PROFILES[bank]!.accountWording),
      ).toBe(false);
    }
  });

  it('name each picture once: no two of a bank’s pictures of one shape can be taken for each other', () => {
    for (const p of Object.values(PROFILES)) {
      expect(new Set(p.pictures.map((x) => x.name)).size).toBe(p.pictures.length);
      for (const a of p.pictures)
        for (const b of p.pictures)
          if (a !== b && Math.abs(Math.log(a.aspect / b.aspect)) < 0.25)
            expect(distance(a.hash, b.hash), `${a.name} and ${b.name}`).toBeGreaterThan(
              MAX_DISTANCE,
            );
      // Labels and headings are words, never a member's values: safe to show in evidence.
      expect(p.safePictures.every((n) => p.pictures.some((x) => x.name === n))).toBe(true);
    }
  });
});
