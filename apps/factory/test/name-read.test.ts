// A name read is the name alone, anchored by the tool on the member's number however the Scout
// pointed at that number: by its last four, or as {member} written by hand.
import { describe, expect, it } from 'vitest';
import { pointed } from '../src/scout.js';

// A results row as lines: a header, then the member's number (the masking rule keeps its last four),
// then their name. Made-up values.
const real = ['Number', 'Name', 'Status', '51239876', 'A. Sample', 'Open'];
const shown = ['Number', 'Name', 'Status', '████9876', 'A. Sample', 'Open'];
const task = { member: '51239876' };

describe('a name read', () => {
  it('is anchored on the member number, whatever else the Scout pointed at', () => {
    const anchored = '$member\n{name}';
    expect(pointed('name', [{ placeholder: 'name', is: 'A. Sample' }], real, shown, task)).toBe(
      anchored,
    );
    expect(
      pointed(
        'name',
        [
          { placeholder: 'member', is: '9876' },
          { placeholder: 'name', after: '9876' },
        ],
        real,
        shown,
        task,
      ),
    ).toBe(anchored);
  });

  it('needs the name itself pointed at', () => {
    expect(() =>
      pointed('name', [{ placeholder: 'member', is: '9876' }], real, shown, task),
    ).toThrow(/point at the name/);
  });
});
