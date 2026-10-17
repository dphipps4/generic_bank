// A control the driver could not find is said with the profile entry that names it, so a repair
// knows which claim to change.
import { describe, expect, it } from 'vitest';
import { TargetError } from '../../../packages/screen/src/index.js';
import { named } from '../src/hazard-check.js';

const profile = {
  words: { memberSearch: 'number or last name:', search: 'Inquire' },
  screens: { 'console.home': 'Sample Savings Bank' },
} as never;

describe('a control the driver could not find', () => {
  it('names the profile entry behind it', async () => {
    const run = named(profile, async () => {
      throw new TargetError('none', 'button "number or last name"');
    });
    await expect(run).rejects.toThrow(
      `no button "number or last name" on this screen (the profile's words.memberSearch)`,
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
