// A factory run's intake: with no knowledge pack from memory there is no run, and no browser page
// is opened.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryStore } from '../../../packages/runs/src/index.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { memoryClient } from '../src/memory.js';
import { baseText, factoryRun, runBudget, withoutGoal } from '../src/run.js';
import { DEFAULT_ROLES } from './fakes.js';

let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(async () => {
  await db?.close();
});

describe('intake', () => {
  it('starts no run without its knowledge pack', async () => {
    const runs = () => db.query(`SELECT id FROM "FactoryRun" WHERE tenant = 'generic'`);
    const before = (await runs()).rows;
    await expect(
      factoryRun(
        {
          sql: db,
          store: memoryStore(),
          browser: {
            newContext: () => {
              throw new Error('no page is opened');
            },
          } as never,
          factoryUrl: 'http://127.0.0.1:9',
          gatewayToken: 't'.repeat(40),
          roles: DEFAULT_ROLES,
          credentials: { operatorId: 'teller0412', password: 'p'.repeat(20) },
          code: async () => '000000',
          memory: memoryClient({ url: 'http://127.0.0.1:9', token: 't', signingKey: 'k' }),
        },
        { bank: 'generic', member: '40017732', from: 'Everyday Checking', to: 'Rainy Day Savings' },
      ),
    ).rejects.toThrow(/^no knowledge pack, no run: /);
    expect((await runs()).rows).toEqual(before);
  });
});

describe("a run's budget", () => {
  it("moves the run's end out by a person's time, and only by that", async () => {
    const start = Date.now();
    const b = runBudget(start, 60_000);
    expect(b.end()).toBe(start + 60_000);
    await b.person(() => new Promise((r) => setTimeout(r, 80)));
    expect(b.end() - (start + 60_000)).toBeGreaterThanOrEqual(75);
    // A wait that fails still counts as a person's.
    const before = b.end();
    await b
      .person(() => new Promise((_, no) => setTimeout(() => no(new Error('expired')), 40)))
      .catch(() => undefined);
    expect(b.end() - before).toBeGreaterThanOrEqual(35);
  });
});

describe('the base lessons each goal starts with', () => {
  it('are the base lessons of the pack, one per line, and nothing else', () => {
    const pack = {
      bank: 'example',
      vendor: null,
      budget: 12_000,
      size: 0,
      omitted: {},
      tiers: {
        patterns: [
          { id: 'base-a', base: true, text: 'The picture is the page.' },
          { id: 'p-1', text: 'A confirmed pattern a run proved.' },
        ],
        proposed: [{ id: 'r-1', text: 'A lesson a run proposed.' }],
      },
    };
    expect(baseText(pack)).toBe('- The picture is the page.');
  });
});

describe('a goal that was not reached', () => {
  it('leaves its screens and their never-words in the route, but none of its steps', () => {
    const route = {
      bank: 'b',
      home: '',
      rows: [
        { page: 'Sign in', shows: ['Log In'], do: { any: [{ press: 'Log In' }] }, frame: 'f1' },
        {
          page: 'Short sign in',
          shows: ['Welcome back,'],
          never: ['Code:'],
          do: { any: [{ press: 'Log In' }] },
          frame: 'f9',
        },
        {
          page: 'Summary',
          shows: ['Member Summary'],
          do: { transfer: [{ press: 'Move Money' }] },
          frame: 'f5',
        },
      ],
      ends: { balance: 'Summary', transfer: 'Review' },
      answers: [],
      trouble: [],
      submit: { press: '', frame: '' },
      reads: { balance: '', review: '', name: [] },
    } as unknown as Parameters<typeof withoutGoal>[0];
    const kept = withoutGoal(route, 'transfer');
    expect(kept.rows.map((r) => r.page)).toEqual(['Sign in', 'Short sign in', 'Summary']);
    expect(kept.rows[1]).toMatchObject({ never: ['Code:'], do: { any: [{ press: 'Log In' }] } });
    expect(kept.rows[2]!.do).toEqual({});
    expect(kept.ends).toEqual({ balance: 'Summary' });
  });
});
