// Masking, before anything is kept, by one rule that every view follows: the picture, the page
// text, field and list values, the address, and anything else that shows a page's words.
//
//   1. A number of five or more digits (digits joined by spaces, dashes or dots in groups of three or
//      more count as one) is an identifier: every digit but its last four is hidden. "40017732" is
//      "████7732".
//   2. Money is hidden whole: "$1,000.00" is "█████████", and so is a plain "1,000.00".
//   3. A name or a secret the run knows (the member's name, a staff name, the sign-in, a code) is
//      hidden whole, in any case.
//   4. What a bank already hides stays as the bank drew it: its "****" is never hidden again, and a
//      number of four digits or fewer (a last four, a year) is never hidden.
//   5. Each hidden character becomes "█", one for one, so the text keeps the page's shape.
//
// This file is the rule alone, with no browser in it, so that everything that shows a value (the
// runtime, the run's inputs, the Console) follows the same rule.

/** The character a hidden one becomes: ours alone, so nobody mistakes it for the bank's own mask. */
export const HIDDEN = '█';
/** Characters a bank uses to hide: never hidden again. */
const ALREADY = /[*•●█]/;
const NUMBER = /\d{3,}(?:[ .-]\d{3,})*|\d+/g;
const MONEY = /\$\s?\d[\d,]*(?:\.\d\d)?|(?<![\d.,$])\d{1,3}(?:,\d{3})*\.\d\d(?![\d])/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Which characters of `text` the rule hides, as ranges: every view hides exactly these. */
export function spans(text: string, known: string[] = []): [number, number][] {
  const hide = new Set<number>();
  const all = (a: number, b: number) => {
    for (let i = a; i < b; i++) if (!ALREADY.test(text[i]!) && !/\s/.test(text[i]!)) hide.add(i);
  };
  // Identifiers: every digit but the last four.
  for (const m of text.matchAll(NUMBER)) {
    const at = [...m[0]].flatMap((c, i) => (/\d/.test(c) ? [m.index + i] : []));
    if (at.length >= 5) for (const i of at.slice(0, -4)) hide.add(i);
  }
  for (const m of text.matchAll(MONEY)) all(m.index, m.index + m[0].length);
  for (const k of known.filter((v) => v.trim().length >= 2))
    for (const m of text.matchAll(new RegExp(escape(k), 'gi'))) all(m.index, m.index + m[0].length);
  // As ranges, in order.
  const out: [number, number][] = [];
  for (const i of [...hide].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** Text with every hidden character as "█", one for one: the same length, so the same shape. */
export function maskText(text: string, known: string[] = []): string {
  const chars = text.split('');
  for (const [a, b] of spans(text, known)) for (let i = a; i < b; i++) chars[i] = HIDDEN;
  return chars.join('');
}
