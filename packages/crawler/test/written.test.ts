// A written crawler is refused before it runs when it reaches past `site`, holds the task's own
// values, or lacks a part; one that passes loads into a context that holds only the language.
import { describe, expect, it } from 'vitest';
import { lint, load } from '../src/written.js';

const OK = `
async function signIn(site) {
  await site.open();
  await site.type({ field: 0 }, 'user_id');
  await site.type({ field: 1 }, 'password');
  await site.press('Sign In');
}
async function balance(site, task) {
  await signIn(site);
  const { lines } = await site.look();
  const line = lines.find((l) => l.includes(task.from)) ?? '';
  return { account: line, available: '$1.00', current: '$1.00' };
}
async function transfer(site, task) { await signIn(site); }
async function review(site) { return { from: 'a', to: 'b', amount: '$1.00', memo: 'm' }; }
async function history(site, task) { await signIn(site); }
function name(lines, member) { return null; }
const send = 'Submit transfer';
`;

describe('a written crawler', () => {
  it('passes the lint when it acts only through site and defines every part', () => {
    expect(lint(OK, { member: '40017732', from: '8176', to: '9433' })).toEqual([]);
    const m = load(OK);
    expect(typeof m.balance).toBe('function');
    expect(typeof m.name).toBe('function');
    expect(m.send).toBe('Submit transfer');
  });

  it('is refused when it reaches past site', () => {
    for (const bad of [
      'process.exit()',
      "require('fs')",
      'globalThis.x = 1',
      'this.constructor',
      "fetch('http://x')",
      "eval('1')",
    ])
      expect(lint(`${OK}\n${bad};`).join(' ')).toMatch(/acts only through site/);
  });

  it("is refused when it holds the task's own values, or a long number", () => {
    expect(lint(OK.replace('task.from', "'8176'"), { from: '8176' }).join(' ')).toMatch(
      /task's own value 8176/,
    );
    expect(lint(`${OK}\nconst n = 40017732;`).join(' ')).toMatch(/five or more digits/);
  });

  it('is refused when a part is missing or it does not parse', () => {
    expect(lint(OK.replace('const send', 'const sent')).join(' ')).toMatch(/does not define send/);
    expect(lint(`${OK}\nasync function (`).join(' ')).toMatch(/does not parse/);
  });

  it('is never loaded when the lint refuses it', () => {
    expect(() => load(`${OK}\nprocess.exit();`)).toThrow(/the crawler is refused/);
  });
});
