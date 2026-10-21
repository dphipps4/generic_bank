// A note of a bank's own words keeps only what stays the same: a word holding a changing value (a
// reference number, a masked name) becomes {value}, the crawler matches it whatever the value is
// next time, and the note has the same id in every run.
import { describe, expect, it } from 'vitest';
import { noteId, saysIn, steadyWords } from '../src/table.js';

const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a note of the bank’s own words', () => {
  it('keeps a changing value as {value}, masked or not', () => {
    expect(steadyWords('An unexpected error has occurred. Reference ERR-512230')).toBe(
      'An unexpected error has occurred. Reference {value}',
    );
    expect(steadyWords('An unexpected error has occurred. Reference ERR-██3988')).toBe(
      'An unexpected error has occurred. Reference {value}',
    );
    expect(steadyWords('This record is in use by another operator.')).toBe(
      'This record is in use by another operator.',
    );
  });

  it('is found on a page whatever its changing value is there', () => {
    const kept = steadyWords('An unexpected error has occurred. Reference ERR-██3988');
    expect(saysIn('- text: An unexpected error has occurred. Reference ERR-104577', kept)).toBe(
      true,
    );
    expect(saysIn('- text: an unexpected error has occurred. reference err-1', kept)).toBe(true);
    expect(saysIn('- text: An unexpected error has occurred.', kept)).toBe(false);
    // Words with nothing changing match as they are, whatever their case.
    expect(saysIn('NO MEMBER FOUND WITH THAT NUMBER.', 'No member found with that number.')).toBe(
      true,
    );
  });

  it('has the same id in every run, a UUID of its steady words', () => {
    const a = noteId('An unexpected error has occurred. Reference ERR-512230');
    expect(a).toMatch(UUID5);
    expect(noteId('An unexpected error has occurred. Reference ERR-██3988')).toBe(a);
    expect(noteId('an unexpected error has occurred. reference ERR-7')).toBe(a);
    expect(noteId('This record is in use by another operator.')).not.toBe(a);
  });
});
