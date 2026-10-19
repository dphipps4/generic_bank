// The masking rule on its own, no browser: a name is hidden where it stands as a word, a secret
// wherever it shows, and numbers and money as before.
import { describe, expect, it } from 'vitest';
import { HIDDEN, maskText, spans } from '../src/rule.js';

const hidden = (s: string) => HIDDEN.repeat(s.length);

describe('a known name is hidden as a word, never inside another word', () => {
  const known = ['John Doe', 'John', 'Doe'];

  it('leaves the words that only contain it readable', () => {
    const text = "check-balance does not press it; Doesn’t matter. DOES it? Doesn't. Undoes. Doer.";
    expect(maskText(text, known)).toBe(text);
    expect(spans(text, known)).toEqual([]);
  });

  it('hides the name itself, in any case and beside any punctuation', () => {
    expect(maskText('Doe', known)).toBe(hidden('Doe'));
    expect(maskText('DOE', known)).toBe(hidden('DOE'));
    expect(maskText('doe', known)).toBe(hidden('doe'));
    expect(maskText('Doe, John', known)).toBe(`${hidden('Doe')}, ${hidden('John')}`);
    expect(maskText('John Doe', known)).toBe(`${hidden('John')} ${hidden('Doe')}`);
    expect(maskText('Hello, JOHN DOE.', known)).toBe(`Hello, ${hidden('JOHN')} ${hidden('DOE')}.`);
    expect(maskText('(Doe)', known)).toBe(`(${hidden('Doe')})`);
    expect(maskText('Doe’s account', known)).toBe(`${hidden('Doe')}’s account`);
    expect(maskText('Mr. Doe-Smith', known)).toBe(`Mr. ${hidden('Doe')}-Smith`);
  });

  it('hides it beside a digit: only a letter makes another word', () => {
    expect(maskText('Doe2024', known)).toBe(`${hidden('Doe')}2024`);
    expect(maskText('7Doe', known)).toBe(`7${hidden('Doe')}`);
  });

  it('hides both readable and hidden words in one line, one for one', () => {
    const text = 'Doe does not know Doe.';
    const out = maskText(text, known);
    expect(out).toBe(`${hidden('Doe')} does not know ${hidden('Doe')}.`);
    expect(out.length).toBe(text.length);
    expect(spans(text, known)).toEqual([
      [0, 3],
      [18, 21],
    ]);
  });

  it('holds for a name with accented letters', () => {
    expect(maskText('José paid; Josénia did not', ['José'])).toBe(
      `${hidden('José')} paid; Josénia did not`,
    );
  });
});

describe('a secret the run knows is hidden wherever it shows', () => {
  it('hides a password inside other text', () => {
    const pw = 'service-password-for-tests';
    expect(maskText(`xx${pw}yy`, [pw])).toBe(`xx${hidden(pw)}yy`);
    expect(maskText(`login?pw=S3cret!x&u=1`, ['S3cret!'])).toBe(
      `login?pw=${hidden('S3cret!')}x&u=1`,
    );
  });

  it('hides a code inside other text', () => {
    expect(maskText('your code is 482913.', ['482913'])).toBe(`your code is ${hidden('482913')}.`);
    expect(maskText('ref A482913B', ['482913'])).toBe(`ref A${hidden('482913')}B`);
  });

  it('hides a value with a digit in it inside a word', () => {
    expect(maskText('opsvc7operator', ['svc7'])).toBe(`op${hidden('svc7')}operator`);
  });
});

describe('numbers and money, as before', () => {
  it('keeps the last four of a long number and hides money whole', () => {
    expect(maskText('Account 12345678', [])).toBe(`Account ${HIDDEN.repeat(4)}5678`);
    expect(maskText('Balance $1,000.00', [])).toBe(`Balance ${hidden('$1,000.00')}`);
    expect(maskText('Balance 1,000.00', [])).toBe(`Balance ${hidden('1,000.00')}`);
    expect(maskText('ending 5678 in 2024', [])).toBe('ending 5678 in 2024');
    expect(maskText('****5678', [])).toBe('****5678');
  });

  it('never hides a known value shorter than two characters', () => {
    expect(maskText('a Doe b', ['a', 'b'])).toBe('a Doe b');
  });
});
