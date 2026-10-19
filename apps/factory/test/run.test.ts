// A factory run's intake: with no knowledge pack from memory there is no run, and no browser page
// is opened.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryStore } from '../../../packages/runs/src/index.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { memoryClient } from '../src/memory.js';
import { factoryRun, runBudget } from '../src/run.js';
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
