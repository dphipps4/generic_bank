// The Scout's tools against bank 1, with no model: a script stands where the model would, so this
// proves the mechanics only. Every action is judged before the next, a target the runtime finds
// elsewhere is refused, and the table the Scout writes as it goes runs under the same loop as bank
// 1's own, with the balance the ledger holds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTrail } from '../../apps/factory/src/trail.js';
import { scout, type Judging } from '../../apps/factory/src/scout.js';
import { BANK1 } from '../support/bank1-crawler.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { type Browser, launch, newPage } from '../../packages/runtime/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

let bank: LiveBank;
let browser: Browser;
let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  [bank, browser, db] = await Promise.all([liveBank('generic'), launch(), controlDb()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
  await db?.close();
});

const credentials = { operatorId: OPERATORS.service.id, password: PASSWORDS.service };
const code = async () =>
  (await bank.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`)).code;

async function aScout(judged: Judging[] = []) {
  const page = await newPage(browser);
  const trail = await openTrail({
    sql: db,
    store: memoryStore(),
    runId: `fr_${Math.random().toString(16).slice(2, 10)}`,
    task: 'check-balance',
    bank: 'generic',
    known: [],
  });
  const s = scout(
    {
      page,
      start: bank.url,
      trail,
      credentials,
      code,
      judge: async (j) => (judged.push(j), { verdict: 'continue', says: 'Fine.' }),
    },
    {
      member: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 100,
      memo: 'GBX TEST',
    },
  );
  /** The id of the latest page's control with this role and, if given, this name. */
  const id = (role: string, name?: string) => {
    const i = s
      .latest()!
      .controls.findIndex((c) => c.role === role && (name === undefined || c.name === name));
    if (i < 0) throw new Error(`no ${role} ${name ?? ''}`);
    return `c${i + 1}`;
  };
  const go = (tool: string, input: Record<string, unknown> = {}) => s.call('scout', tool, input);
  return { s, id, go, page };
}

describe('the Scout, scripted', () => {
  it('shows the Supervisor every call the Scout makes, exactly once, failures included', async () => {
    const judged: Judging[] = [];
    const { id, go } = await aScout(judged);
    const made: string[] = [];
    const call = async (tool: string, input: Record<string, unknown> = {}) => {
      made.push(tool);
      return go(tool, input).catch((e: Error) => e);
    };
    await call('browser_open');
    await call('browser_look');
    // Refused: no control at that point. The Supervisor judges it at once, error and all.
    const before = judged.length;
    const refused = await call('browser_press', { x: 1, y: 1, why: 'a test' });
    expect(judged.length).toBe(before + 1);
    expect(String(refused)).toMatch(/The Supervisor: Fine/);
    const last = judged.at(-1)!;
    expect(last.record.at(-1)).toMatchObject({
      tool: 'browser_press',
      error: expect.stringMatching(/lands on no/),
    });
    await call('browser_type', {
      id: id('textbox'),
      label: 'Operator ID',
      value: 'user_id',
      why: 'sign in',
    });
    // Every call, in order, in exactly one judgment's record.
    expect(judged.flatMap((j) => j.record.map((e) => e.tool))).toEqual(made);
  }, 120_000);

  it('writes a crawler, tries it with no model, and is ready only when every part passed', async () => {
    const judged: Judging[] = [];
    const { s, go } = await aScout(judged);
    await go('browser_open');
    // A crawler that reaches past site is refused before it is kept.
    await expect(
      go('write_crawler', { source: `${BANK1}\nprocess.exit();`, why: 'x x' }),
    ).rejects.toThrow(/can't run: it uses process/);
    await go('write_crawler', { source: BANK1, why: 'from the pages walked' });
    expect(judged.at(-1)!.crawler).toBe(BANK1);
    await expect(go('crawler_ready', { why: 'x x' })).rejects.toThrow(/not passed a try/);
    const tried = await go('try_crawler', { part: 'balance' });
    expect(tried.text).toMatch(/tried balance: passed, it read an amount of money/);
    expect(s.passed()).toEqual(['balance']);
    expect(s.crawler()).toBeNull();
  }, 240_000);

  it('refuses a position that lands on no control', async () => {
    const { go } = await aScout();
    await go('browser_open');
    await expect(go('browser_press', { x: 1, y: 1, why: 'x x' })).rejects.toThrow(/lands on no/);
  }, 120_000);
});
