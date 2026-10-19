// Everything the factory does around the agents is told to both: run 27 and 28's agents, never told
// that each goal starts at the start page, took it for an expired session and wrote that down.
import { describe, expect, it } from 'vitest';
import { SCOUT } from '../src/run.js';
import { MECHANICS, SYSTEM } from '../src/supervisor.js';

const SUPERVISOR = `${SYSTEM}\n${MECHANICS}`;

/** Each mechanic the factory applies, and words that tell it. */
const MECHANICS_TOLD: [string, RegExp][] = [
  ['each goal starts at the start page', /start page/i],
  [
    "a page showing the member's number needs the name read first",
    /name.{0,40}first|note_read name/i,
  ],
  ['the guard judges every step', /guard judges|judged by the guard/i],
  [
    'the route must pass the guard before a goal counts',
    /guard (checks every step|.*before a goal counts)/i,
  ],
  ['█ is our masking', /█/],
  ["a person's wait does not count against the clock", /clock pauses|does not count against/i],
  ['one call at a time', /one (thing|call) at a time/i],
  ['the tool adds never-words', /never-word|leave never out/i],
  ['each goal has its own clock', /clock/i],
  ["each agent's lessons are its own", /lessons are your own/i],
  ['a list shows its chosen option', /closed list/i],
];

describe('the mechanics, as each agent is told them', () => {
  for (const [what, words] of MECHANICS_TOLD)
    it(`tells the Scout and the Supervisor: ${what}`, () => {
      expect(SCOUT, 'the Scout').toMatch(words);
      expect(SUPERVISOR, 'the Supervisor').toMatch(words);
    });
});

describe('the route, as both agents read it', () => {
  it("shows each screen's kind and steps, the guard's names, and the reads kept", async () => {
    const { bank1 } = await import('@gb/crawler');
    const { routeText } = await import('../src/supervisor.js');
    const text = routeText(bank1);
    expect(text).toMatch(/"sign-in" \(a sign_in screen\), recognized by: Operator ID:; Password:/);
    expect(text).toMatch(/"Operator ID".*"\$operator"/);
    expect(text).toMatch(/The guard's "Matching member" is drawn here as: Open/);
    expect(text).toMatch(/Read kept, the balance: \{name\} Account ending in \{last4\}/);
    expect(text).toMatch(/Read kept, the review: /);
  });
});
