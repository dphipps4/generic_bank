// A screen named again keeps the never-words that tell it apart from the screens around it.
import { describe, expect, it } from 'vitest';
import { neverOf } from '../../apps/factory/src/scout.js';
import type { Row } from '../../packages/crawler/src/index.js';

const row = (page: string, shows: string[], never?: string[]): Row => ({
  page,
  shows,
  ...(never ? { never } : {}),
  do: {},
  frame: 'f1',
});

// A full sign-in, and a returning one that shows a subset of its words: only a never-word tells the
// returning one apart when a new browser meets the full sign-in.
const full = row('sign in', ['Branch Console: Staff', 'Sign On']);
const activity = row('activity', ['Activity for', 'Posted', 'Amount']);
const returning = row('welcome back', ['Branch', 'Sign On'], ['Branch Console: Staff']);
const onReturning = (w: string) => ['Branch', 'Sign On', 'Welcome back'].includes(w);

describe('never-words', () => {
  it('keeps those a screen named again already had', () => {
    // The activity's words come first: chosen afresh, three of them would crowd out the sign-in's.
    const never = neverOf(returning, [activity, full], onReturning);
    expect(never).toContain('Branch Console: Staff');
    expect(never).toHaveLength(3);
  });

  it('drops one the page now shows', () => {
    const shown = (w: string) => onReturning(w) || w === 'Branch Console: Staff';
    expect(neverOf(returning, [activity, full], shown)).not.toContain('Branch Console: Staff');
  });

  it("takes a new screen's from the other screens' words, three at most, none repeated", () => {
    expect(neverOf(undefined, [activity, activity, full], onReturning)).toEqual([
      'Activity for',
      'Posted',
      'Amount',
    ]);
  });
});
