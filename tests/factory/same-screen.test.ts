// A screen named by words that change (a greeting) can be named again by words that hold, and only
// when the page is that screen: the same fields and buttons, and the words on its own frame too.
import { describe, expect, it } from 'vitest';
import { neverRepairs, sameScreen } from '../../apps/factory/src/scout.js';
import { formOf } from '../../apps/factory/src/trail.js';
import type { Row } from '../../packages/crawler/src/index.js';

const returning = {
  texts: ['Branch Console', 'Welcome back, Pat', 'Passcode:', 'Sign On'],
  form: formOf([
    { role: 'button', name: 'Sign On' },
    { role: 'password', name: '' },
  ]),
};
const again = {
  form: formOf([
    { role: 'password', name: '' },
    { role: 'button', name: 'Sign On' },
  ]),
};
const full = {
  form: formOf([
    { role: 'textbox', name: '' },
    { role: 'password', name: '' },
    { role: 'button', name: 'Sign On' },
  ]),
};

describe('a screen named again', () => {
  it('is the same screen when its own frame shows the new words and the form is the same', () => {
    expect(sameScreen(returning, again, ['Passcode:', 'Sign On'])).toBe(true);
  });

  it('is another screen when the form differs: the full sign-in beside the returning one', () => {
    expect(sameScreen(returning, full, ['Passcode:', 'Sign On'])).toBe(false);
  });

  it('is not the same screen by words its own frame never showed, or by none', () => {
    expect(sameScreen(returning, again, ['Passcode:', 'User ID:'])).toBe(false);
    expect(sameScreen(returning, again, [])).toBe(false);
  });

  it('is told how, when a new name would take an earlier screen for it', () => {
    const earlier: Row = { page: 'returning sign on', shows: ['Sign On'], do: {}, frame: 'f2' };
    expect(() =>
      neverRepairs(
        [earlier],
        () => true,
        () => 'Passcode: Sign On',
        ['Passcode:', 'Sign On'],
      ),
    ).toThrow(/name it "returning sign on" again by words both its pages show/);
  });
});
