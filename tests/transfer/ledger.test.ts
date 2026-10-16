import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';
import { freezePages } from '../../apps/console/src/pages/freezes.js';
import { oauth } from '../../packages/oauth/src/index.js';
import { type Ending, inputsOf } from '../../packages/runs/src/index.js';
import type { Browser } from '../../packages/screen/src/index.js';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { type Harness, KEY, transferHarness } from '../runs/transfer-harness.js';

// What a person approved is what moves, once (plan, §F.1, §F.2, §D.8). A review page that shows
// another amount by the time of the click is refused, and a transfer asked for again, under the
// same key or a new one, is the run already open. The bank's ledger counts what moved. A person acts
// only through the Console's API.

let h: Harness;
let api: Awaited<ReturnType<typeof buildServer>>;
let token: string;
const runs: Promise<Ending>[] = [];
const freezes = Fastify();

beforeAll(async () => {
  h = await transferHarness();
  const o = oauth(h.db, 'o'.repeat(40));
  // The API hands each run to the Runner, as the workflow does.
  api = await buildServer({
    oauth: o,
    sql: h.db,
    sealKey: KEY,
    enqueue: async (runId) => void runs.push(h.execute(runId)),
  });
  const c = await o.createClient({
    name: 'agent',
    scopes: ['tasks:read', 'tasks:transfer'],
    createdBy: 'a',
  });
  token = (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
  freezePages(freezes, {
    sql: h.db,
    whoIs: () => ({ email: 'ada@generic-bank.local', role: 'admin' }),
  });
  await freezes.ready();
}, 120_000);
afterAll(async () => {
  await freezes.close();
  await api?.close();
  await h?.close();
});

/** Rewrites text on the page a browser holds, in every frame, as a page's own script could. */
async function rewrite(b: Browser, from: string, to: string): Promise<number> {
  const { targetInfos } = await b.cdp.call<{ targetInfos: { targetId: string; type: string }[] }>(
    'Target.getTargets',
  );
  let n = 0;
  for (const t of targetInfos.filter((t) => t.type === 'page')) {
    const { sessionId } = await b.cdp.call<{ sessionId: string }>('Target.attachToTarget', {
      targetId: t.targetId,
      flatten: true,
    });
    const r = await b.cdp.call<{ result: { value: number } }>(
      'Runtime.evaluate',
      {
        expression: `(function walk(w) {
          let n = 0;
          const it = w.document.createTreeWalker(w.document.documentElement, NodeFilter.SHOW_TEXT);
          for (let t = it.nextNode(); t; t = it.nextNode())
            if (t.nodeValue.includes(${JSON.stringify(from)})) {
              t.nodeValue = t.nodeValue.replace(${JSON.stringify(from)}, ${JSON.stringify(to)});
              n++;
            }
          for (let i = 0; i < w.frames.length; i++) n += walk(w.frames[i]);
          return n;
        })(window)`,
        returnByValue: true,
      },
      { sessionId },
    );
    n += r.result.value;
  }
  return n;
}

describe('what moves is what a person approved, once', () => {
  it('the amount changed on screen before the click: refused, and nothing posted', async () => {
    const { runId, memoToken } = await h.start({ amountCents: 6_600 });
    const before = h.browsers.length;
    const done = h.execute(runId);
    const task = await h.approval(runId);
    // The person approves $66.00; by the time of the click, the held review page says $660.00.
    expect(await rewrite(h.browsers[before]!, '$66.00', '$660.00')).toBe(1);
    expect(await h.act(task, 'approve')).toBe(200);
    expect(await done).toMatchObject({ status: 'escalated', code: 'guard_tripped' });
    expect(await h.postings(memoToken)).toBe(0);
    const journal = await h.journalOf(runId);
    expect(journal).toContainEqual(
      expect.objectContaining({ result: 'refused: the screen shows a different amount' }),
    );
    expect(journal.map((l) => l.action)).not.toContain('pressed');

    // The guard froze the bank; a person reads the trail and clears it.
    const freeze = await h.db.query<{ id: string }>(
      'SELECT id FROM "Freeze" WHERE "runId" = $1 AND "clearedAt" IS NULL',
      [runId],
    );
    expect(freeze.rows).toHaveLength(1);
    const cleared = await freezes.inject({
      method: 'POST',
      url: `/freezes/${freeze.rows[0]!.id}/clear`,
      payload: { reason: 'the page changed the amount; nothing was pressed' },
    });
    expect(cleared.json()).toEqual({ ok: true });
  }, 300_000);

  it('the same transfer twice while one is open, and the same key again: one run, one posting', async () => {
    const body = {
      bank: 'generic',
      memberId: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 4_400,
      idempotencyKey: randomBytes(8).toString('hex'),
    };
    const post = (payload: typeof body) =>
      api.inject({
        method: 'POST',
        url: '/tasks/transfer',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    const first = await post(body);
    expect(first.statusCode).toBe(202);
    const runId = first.json().runId as string;
    const task = await h.approval(runId);
    // The token the bank's history is searched for; the inputs are erased once the run ends.
    const { memoToken } = await inputsOf<{ memoToken: string }>(h.db, runId, KEY);

    // While it waits for a person: the same key is the same run; a new key is refused, naming it.
    const again = await post(body);
    expect([again.statusCode, again.json().runId]).toEqual([202, runId]);
    const other = await post({ ...body, idempotencyKey: `${body.idempotencyKey}-again` });
    expect([other.statusCode, other.json().code, other.json().runId]).toEqual([
      409,
      'duplicate_transfer',
      runId,
    ]);
    expect(runs).toHaveLength(1);

    expect(await h.act(task, 'approve')).toBe(200);
    expect(await runs[0]).toMatchObject({ status: 'succeeded' });
    // Asked again once it is done, the key answers with the same run, and nothing starts.
    const after = await post(body);
    expect([after.statusCode, after.json().runId]).toEqual([200, runId]);
    expect(runs).toHaveLength(1);
    expect(await h.postings(memoToken)).toBe(1);
  }, 300_000);
});
