import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauth } from '@gb/oauth';
import { forcedHazardsOf } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { labRoutes } from '../src/lab.js';
import { buildServer } from '../src/server.js';

// The hazard lab's door: the task's own checks, then a run with its hazards forced and readable.
const SEAL = 'r'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let o: ReturnType<typeof oauth>;
const enqueued: string[] = [];

beforeAll(async () => {
  db = await controlDb();
  o = oauth(db, 'k'.repeat(40));
  const enqueue = async (id: string) => void enqueued.push(id);
  app = await buildServer({ oauth: o, sql: db, sealKey: SEAL, enqueue });
  labRoutes(app, { sql: db, sealKey: SEAL, enqueue });
});
afterAll(() => db.close());

async function client(scopes = ['tasks:read', 'tasks:balance']) {
  const c = await o.createClient({ name: 'lab', scopes, createdBy: 'a' });
  return (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
}
const input = { bank: 'generic', memberId: '40017732', account: 'Everyday Checking' };
const lab = (token: string | null, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/lab/runs',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as object,
  });

describe('the hazard lab’s door', () => {
  it('starts a run with its hazards forced, readable beside the masked inputs', async () => {
    const r = await lab(await client(), {
      task: 'check-balance',
      input,
      hazards: ['late-rows', 'promo', 'late-rows'],
    });
    expect(r.statusCode).toBe(202);
    const { runId } = r.json();
    expect(r.headers.location).toBe(`/tasks/${runId}`);
    expect(enqueued).toContain(runId);
    expect(await forcedHazardsOf(db, runId)).toEqual(['late-rows', 'promo']);
    const masked = (
      await db.query<{ inputsMasked: Record<string, unknown> }>(
        'SELECT "inputsMasked" FROM "TaskRun" WHERE id = $1',
        [runId],
      )
    ).rows[0]!.inputsMasked;
    expect(masked).toEqual({
      bank: 'generic',
      memberId: '████7732',
      account: 'Everyday Checking',
      forcedHazards: ['late-rows', 'promo'],
    });
  });

  it('records a run with nothing forced as a lab run all the same', async () => {
    const r = await lab(await client(), { task: 'check-balance', input, hazards: [] });
    expect(await forcedHazardsOf(db, r.json().runId)).toEqual([]);
    const tagged = await db.query(
      `SELECT 1 FROM "TaskRun" WHERE id = $1 AND "inputsMasked" ? 'forcedHazards'`,
      [r.json().runId],
    );
    expect(tagged.rows).toHaveLength(1);
  });

  it('refuses a hazard the bank does not know, a bad input, a missing scope and no token', async () => {
    const t = await client();
    const bad = await lab(t, { task: 'check-balance', input, hazards: ['meteor'] });
    expect([bad.statusCode, bad.json().code]).toEqual([400, 'invalid_input']);
    const badInput = await lab(t, {
      task: 'check-balance',
      input: { ...input, memberId: 'x' },
      hazards: [],
    });
    expect([badInput.statusCode, badInput.json().fields[0].path]).toEqual([400, 'memberId']);
    const scoped = await lab(await client(['tasks:read']), {
      task: 'check-balance',
      input,
      hazards: [],
    });
    expect([scoped.statusCode, scoped.json().code]).toEqual([403, 'insufficient_scope']);
    expect((await lab(null, { task: 'check-balance', input, hazards: [] })).statusCode).toBe(401);
  });

  it('refuses a bank with no crawler for the task', async () => {
    const r = await lab(await client(['tasks:read', 'tasks:transfer']), {
      task: 'transfer',
      input: {
        bank: 'example',
        memberId: input.memberId,
        from: '7890',
        to: '7255',
        amountCents: 100,
        idempotencyKey: 'lab-no-crawler',
      },
      hazards: [],
    });
    expect([r.statusCode, r.json().code]).toEqual([404, 'task_not_available']);
  });

  it('is the only way to force a hazard: the task endpoint drops one', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/tasks/check-balance',
      headers: { authorization: `Bearer ${await client()}` },
      payload: { ...input, forcedHazards: ['unknown-screen'] },
    });
    expect(r.statusCode).toBe(202);
    expect(await forcedHazardsOf(db, r.json().runId)).toEqual([]);
  });
});
