// A control the driver could not find is said with the profile entry that names it, so a repair
// knows which claim to change.
import { describe, expect, it } from 'vitest';
import { TargetError } from '../../../packages/screen/src/index.js';
import { named } from '../src/hazard-check.js';

const profile = {
  words: { memberNumber: 'Member number:', search: 'Find' },
  screens: { 'console.home': 'Example Credit Union' },
} as never;

describe('a control the driver could not find', () => {
  it('names the profile entry behind it', async () => {
    const run = named(profile, async () => {
      throw new TargetError('none', 'button "Member number"');
    });
    await expect(run).rejects.toThrow(
      `no button "Member number" on this screen (the profile's words.memberNumber)`,
    );
  });

  it('is left as it was when no entry names it, and other errors pass through', async () => {
    await expect(
      named(profile, async () => {
        throw new TargetError('none', 'button "Approve"');
      }),
    ).rejects.toThrow(/^no button "Approve" on this screen$/);
    await expect(
      named(profile, async () => {
        throw new Error('the browser is gone');
      }),
    ).rejects.toThrow('the browser is gone');
  });
});
