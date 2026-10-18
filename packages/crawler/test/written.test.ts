// A written crawler is refused before it runs when it reaches past `site`, holds the task's own
// values, or lacks a part; one that passes loads into a context that holds only the language.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint, load, nameBeside, partsOf, whereIn } from '../src/written.js';

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

describe("run 19's crawlers, as the factory's Scout wrote them on bank 1", () => {
  const version = (v: string) =>
    readFileSync(join(import.meta.dirname, `run19/crawler-${v}.js`), 'utf8');

  it('are refused for a site call with no await, by its line, and pass with it', () => {
    for (const v of ['01', '02', '03']) {
      const problems = lint(version(v));
      expect(problems.join(' ')).toMatch(/line \d+: site\.shows\(…\) is not awaited/);
      expect(lint(version(v).replace(/(?<!await )site\.shows\(/g, 'await site.shows('))).toEqual(
        [],
      );
    }
  });

  it('say which of their lines threw', async () => {
    const fixed = version('03').replace(/(?<!await )site\.shows\(/g, 'await site.shows(');
    const m = load(fixed);
    const err = await m
      .transfer(
        {
          open: async () => undefined,
          look: async () => ({ lines: [], controls: [] }),
          shows: async () => false,
          wait: async () => undefined,
          press: async (t: unknown) => {
            throw new Error(`press ${JSON.stringify(t)}: 0 visible`);
          },
          type: async () => undefined,
          choose: async () => undefined,
          stop: () => {
            throw new Error('stop');
          },
        } as never,
        { member: '' },
      )
      .catch((e: unknown) => e);
    const at = whereIn(fixed, err);
    expect(at?.code).toMatch(/site\.press\(/);
    expect(fixed.split('\n')[at!.line - 1]!.trim()).toBe(at!.code);
  });
});

describe('a crawler being written', () => {
  it('may lack parts, and is whole only with all of them', () => {
    const signInOnly = `async function signIn(site) { await site.open(); }\nfunction name(lines) { return null; }`;
    expect(lint(signInOnly, undefined, { partial: true })).toEqual([]);
    expect(lint(signInOnly).join(' ')).toMatch(/does not define balance/);
    expect(partsOf(signInOnly)).toEqual(['signIn', 'name']);
    expect(load(signInOnly, { partial: true }).balance).toBeUndefined();
  });
});

describe("the member's name a crawler reads", () => {
  // Bank 1's summary lines, as leaves reads them across its frames; the name is a test value.
  const lines = [
    'Generic Bank · Main Street Branch',
    'Branch notice: the vault closes at 4:30 · New member promotion runs through month end · Report suspicious calls to Security',
    'Member 40017732 · A. Sample',
    'Member Summary',
  ];
  it('is believed only beside the member number', () => {
    const v3 = readFileSync(join(import.meta.dirname, 'run19/crawler-03.js'), 'utf8').replace(
      /(?<!await )site\.shows\(/g,
      'await site.shows(',
    );
    // Run 19's own name picks the banner: not beside the number, so nothing is believed.
    expect(load(v3).name!(lines, '40017732')).toBe('Report suspicious calls to Security');
    expect(nameBeside(lines, '40017732', load(v3).name!(lines, '40017732'))).toBeNull();
    expect(nameBeside(lines, '40017732', 'A. Sample')).toBe('A. Sample');
  });
});
