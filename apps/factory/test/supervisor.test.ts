// The Supervisor with a fake model behind the real gateway, no browser: every judgment carries the
// page's picture, an unreadable answer is a wait and three in a row a stop, and any frame of this
// run or an earlier one opens, picture and all.
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '../../../packages/evidence/src/index.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import type { Frame } from '../../../packages/runtime/src/index.js';
import type { Agent } from '../src/agent.js';
import { gateway } from '../src/gateway.js';
import { sqlLedger } from '../src/ledger.js';
import { PRICES } from '../src/models.js';
import { buildServer } from '../src/server.js';
import { openFrameTool, supervisor } from '../src/supervisor.js';
import { openTrail, type Trail } from '../src/trail.js';
import { live } from '../src/upstream.js';
import { DEFAULT_ROLES, fakeModels, type Reply } from './fakes.js';

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';
let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof buildServer>;
let replies: Reply[];
let sent: Record<string, unknown>[];
const store = memoryStore();

/** A small picture, one color, so a request can be searched for it. */
const picture = (shade: number) => {
  const p = new PNG({ width: 4, height: 4 });
  p.data.fill(shade);
  return PNG.sync.write(p);
};
const frame = (shade: number, words: string): Frame => ({
  at: new Date().toISOString(),
  address: 'http://bank.test/console',
  picture: picture(shade),
  tree: `- paragraph: ${words}`,
  controls: [{ role: 'button', name: 'Search', box: { x: 1, y: 1, w: 2, h: 2 } }],
  dialogs: [],
  animated: [],
});

beforeEach(async () => {
  db = await controlDb();
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ('run1', 'generic', 'check-balance', 'build', 'SCOUT', 'running')`,
  );
  replies = [];
  sent = [];
  app = buildServer({
    gateway: gateway({
      ledger: sqlLedger(db),
      upstream: live(fakeModels(() => replies.shift() ?? { text: '{}' }, sent)),
      prices: PRICES,
    }),
    token: TOKEN,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const agent = (): Agent => ({
  model: DEFAULT_ROLES.supervisor,
  url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/gateway/run1/supervisor`,
  token: TOKEN,
});
const trailOf = (runId = 'run1'): Promise<Trail> =>
  openTrail({ sql: db, store, runId, task: 'factory', bank: 'generic', known: [] });

describe('the Supervisor', () => {
  it('judges each action from its picture, and a verdict the Scout reads', async () => {
    const trail = await trailOf();
    const f = frame(200, 'Member number:');
    const { ref } = (await trail.step({ name: 'balance', action: 'pressed' }, f))!;
    const sup = supervisor({ agent: agent(), trail, goal: 'Reach the balances.' });
    replies.push({
      text: JSON.stringify({ verdict: 'continue', says: `${ref} shows the search form.` }),
    });
    const j = await sup.judge({
      action: 'pressed "Member Search"',
      why: 'to find the member',
      frame: f,
      ref,
    });
    expect(j).toEqual({ verdict: 'continue', says: 'f1 shows the search form.' });
    // The picture went to the model with the turn.
    const base64 = f.picture.toString('base64');
    expect(JSON.stringify(sent.at(-1))).toContain(base64);
  });

  it('reads an unreadable answer as wait, and three in a row as stop', async () => {
    const trail = await trailOf();
    const f = frame(120, 'Loading');
    const sup = supervisor({ agent: agent(), trail, goal: 'Reach the balances.' });
    const j = () => sup.judge({ action: 'looked', why: 'x', frame: f, ref: null });
    replies.push({ text: 'not json' }, { text: '{"verdict":"maybe"}' }, { text: '' });
    expect((await j()).verdict).toBe('wait');
    expect((await j()).verdict).toBe('wait');
    expect((await j()).verdict).toBe('stop');
  });

  it('opens a frame of this run, or of an earlier one, picture and all', async () => {
    const earlier = await trailOf('earlier-run');
    await earlier.step({ name: 'balance', action: 'pressed' }, frame(40, 'Member Summary'));
    const trail = await trailOf();
    await trail.step({ name: 'balance', action: 'pressed' }, frame(90, 'Member number:'));
    const open = openFrameTool({ sql: db, store, trail });
    const now = await open.run({ frame: 'f1' });
    expect(now.text).toContain('Member number:');
    expect(now.image?.equals(picture(90))).toBe(true);
    const then = await open.run({ frame: 'f1', run: 'earlier-run' });
    expect(then.text).toContain('Member Summary');
    await expect(open.run({ frame: 'f9' })).rejects.toThrow(/no frame f9/);
  });
});
