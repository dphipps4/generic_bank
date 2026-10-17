import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMO_MAX, TransferInput } from '@gb/contracts';
import { oauth } from '@gb/oauth';
import { inputsOf, openHumanTask, settleRun } from '@gb/runs';
import { memoFor } from '../../runner/src/transfer.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { openapi, tools } from '../src/catalog.js';
import { buildServer } from '../src/server.js';

// Transfers through the API (plan, §3, §6). The tests stop at the API and the runs
// table: a run is created, sealed and handed to the Runner once, and every answer has its status.
const SEAL = 'r'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let o: ReturnType<typeof oauth>;
const enqueued: string[] = [];

beforeAll(async () => {
  db = await controlDb();
  o = oauth(db, 'k'.repeat(40));
  app = await buildServer({
    oauth: o,
    sql: db,
    sealKey: SEAL,
    enqueue: async (id) => void enqueued.push(id),
  });
});
afterAll(() => db.close());

async function client(scopes = ['tasks:read', 'tasks:transfer']) {
  const c = await o.createClient({ name: 'agent', scopes, createdBy: 'a' });
  return (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
}

let n = 0;
/** A transfer nobody else in this file asks for: its own member and amount. */
const fresh = (over: Record<string, unknown> = {}) => ({
  bank: 'generic',
  memberId: String(40_017_700 + ++n),
  from: '7890',
  to: 'Savings',
  amountCents: 12_500 + n,
  memo: 'rent',
  idempotencyKey: `transfer-key-${n}`,
  ...over,
});
const post = (token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/tasks/transfer',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
const get = (token: string, runId: string) =>
  app.inject({
    method: 'GET',
    url: `/tasks/${runId}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('POST /tasks/transfer', () => {
  it('starts a run with 202, seals the inputs with a memo token, and hands it to the Runner once', async () => {
    const t = await client();
    const body = fresh();
    const r = await post(t, body);
    expect(r.statusCode).toBe(202);
    const runId = r.json().runId;
    expect(r.json()).toEqual({ runId, task: 'transfer', status: 'running' });
    expect(r.headers.location).toBe(`/tasks/${runId}`);
    expect(enqueued.filter((x) => x === runId)).toHaveLength(1);
    const sealed = await inputsOf<Record<string, unknown>>(db, runId, SEAL);
    expect(sealed).toMatchObject(body);
    expect(sealed.memoToken).toMatch(/^GBX [0-9A-Z]{4}$/);
    const row = JSON.stringify(
      (await db.query('SELECT * FROM "TaskRun" WHERE id = $1', [runId])).rows,
    );
    expect(row).not.toContain(body.memberId);
    expect(row).not.toContain(String(body.amountCents));
  });

  it('answers the same idempotency key with the same run, and never starts a second', async () => {
    const t = await client();
    const body = fresh();
    const first = await post(t, body);
    const again = await post(t, body);
    const runId = first.json().runId;
    expect([again.statusCode, again.json().runId]).toEqual([202, runId]);
    expect(enqueued.filter((x) => x === runId)).toHaveLength(1);
    const memo = (await inputsOf<{ memoToken: string }>(db, runId, SEAL)).memoToken;
    // A retry reuses the run, and so the memo token the bank's history is searched for.
    await post(t, body);
    expect((await inputsOf<{ memoToken: string }>(db, runId, SEAL)).memoToken).toBe(memo);
    const keyed = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "TaskRun" WHERE "idempotencyKey" = $1`,
      [body.idempotencyKey],
    );
    expect(keyed.rows[0]!.n).toBe(1);
  });

  it('names the pending kind in the 202 while the run waits for approval', async () => {
    const t = await client();
    const body = fresh();
    const runId = (await post(t, body)).json().runId;
    const deadline = new Date(Date.now() + 15 * 60_000);
    await openHumanTask(db, runId, 'approval', {}, deadline);
    for (const r of [await post(t, body), await get(t, runId)]) {
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({
        runId,
        status: 'needs_human',
        code: 'awaiting_approval',
        pending: { kind: 'approval', deadline: deadline.toISOString() },
      });
    }
    // Asking again with the key counts as the agent asking, as a GET does.
    const asks = await db.query<{ asks: number }>(
      'SELECT asks FROM "HumanTask" WHERE "runId" = $1',
      [runId],
    );
    expect(asks.rows[0]!.asks).toBe(2);
  });

  it('refuses the same transfer under a new key with 409 while the first is open, pointing to it', async () => {
    const t = await client();
    const body = fresh();
    const runId = (await post(t, body)).json().runId;
    const dup = () => post(t, { ...body, idempotencyKey: `${body.idempotencyKey}-again` });
    const expectRefused = async () => {
      const r = await dup();
      expect(r.statusCode).toBe(409);
      expect(r.headers['content-type']).toContain('application/problem+json');
      expect(r.headers.location).toBe(`/tasks/${runId}`);
      expect(r.json()).toMatchObject({ code: 'duplicate_transfer', runId, retryable: false });
    };
    await expectRefused(); // running
    await openHumanTask(db, runId, 'approval', {}, new Date(Date.now() + 60_000));
    await expectRefused(); // awaiting approval
    await settleRun(db, runId, { status: 'escalated', code: 'ambiguous_outcome' });
    await expectRefused(); // escalated
    // The first request, asked again, is its own run's answer: escalated is a 409 of its own.
    const own = await post(t, body);
    expect([own.statusCode, own.json().code, own.json().runId]).toEqual([
      409,
      'ambiguous_outcome',
      runId,
    ]);
    // An account named in another case is the same account.
    const cased = await post(t, {
      ...body,
      to: ' SAVINGS',
      idempotencyKey: `${body.idempotencyKey}-cased`,
    });
    expect([cased.statusCode, cased.json().runId]).toEqual([409, runId]);
    expect(enqueued.filter((x) => x === runId)).toHaveLength(1);
  });

  it('lets the same transfer start again once the first has ended, and a different one at any time', async () => {
    const t = await client();
    const body = fresh();
    const first = (await post(t, body)).json().runId;
    const other = await post(t, {
      ...body,
      amountCents: body.amountCents + 1,
      idempotencyKey: `${body.idempotencyKey}-other`,
    });
    expect(other.statusCode).toBe(202);
    await settleRun(db, first, {
      status: 'succeeded',
      data: { confirmation: 'T-1', seenInHistory: true },
    });
    const next = await post(t, { ...body, idempotencyKey: `${body.idempotencyKey}-next-month` });
    expect(next.statusCode).toBe(202);
    expect(next.json().runId).not.toBe(first);
    // The first key still answers with the first run, now settled.
    const old = await post(t, body);
    expect([old.statusCode, old.json().runId, old.json().data]).toEqual([
      200,
      first,
      { confirmation: 'T-1', seenInHistory: true },
    ]);
  });

  it('lets one of two simultaneous requests for the same transfer through; the other is a 409 naming it', async () => {
    const t = await client();
    const body = fresh();
    const [a, b] = await Promise.all([
      post(t, body),
      post(t, { ...body, idempotencyKey: `${body.idempotencyKey}-b` }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([202, 409]);
    const made = a.statusCode === 202 ? a : b;
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json().runId).toBe(made.json().runId);
    const runs = await db.query<{ id: string }>(
      `SELECT id FROM "TaskRun" WHERE "idempotencyKey" = ANY($1)`,
      [[body.idempotencyKey, `${body.idempotencyKey}-b`]],
    );
    expect(runs.rows).toEqual([{ id: made.json().runId }]);
  });

  it('gives another client’s key its own run, never the first client’s', async () => {
    const mine = await client();
    const theirs = await client();
    const body = fresh();
    const runId = (await post(mine, body)).json().runId;
    await settleRun(db, runId, {
      status: 'succeeded',
      data: { confirmation: 'T-2', seenInHistory: true },
    });
    const r = await post(theirs, body);
    expect(r.statusCode).toBe(202);
    expect(r.json().runId).not.toBe(runId);
    expect(r.json().data).toBeUndefined();
  });

  it('answers 403 insufficient_scope to a client without tasks:transfer, and starts nothing', async () => {
    const t = await client(['tasks:read', 'tasks:balance']);
    const body = fresh();
    const r = await post(t, body);
    expect([r.statusCode, r.json().code]).toEqual([403, 'insufficient_scope']);
    expect(r.headers['www-authenticate']).toBe(
      'Bearer error="insufficient_scope", scope="tasks:transfer"',
    );
    const keyed = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "TaskRun" WHERE "idempotencyKey" = $1`,
      [body.idempotencyKey],
    );
    expect(keyed.rows[0]!.n).toBe(0);
  });

  it('refuses a memo the bank would cut short or turn away, naming the field', async () => {
    const t = await client();
    for (const memo of ['x'.repeat(MEMO_MAX + 1), 'rent; drop']) {
      const r = await post(t, fresh({ memo }));
      expect([r.statusCode, r.json().fields[0].path]).toEqual([400, 'memo']);
    }
    expect((await post(t, fresh({ memo: 'x'.repeat(MEMO_MAX) }))).statusCode).toBe(202);
  });
});

describe('the memo the bank receives', () => {
  it('carries the whole of the longest memo the API accepts after the memo token', () => {
    const memo = 'Rent for October 2026 x'.slice(0, MEMO_MAX);
    expect(TransferInput.shape.memo.safeParse(memo).success).toBe(true);
    const sent = memoFor({ memo, memoToken: 'GBX 7Q4M' });
    expect(sent).toBe(`GBX 7Q4M ${memo}`);
    // The bank's own rule for its memo field.
    expect(sent).toMatch(/^[A-Za-z0-9 -]{0,32}$/);
  });
});

describe('the tool, the endpoint and the document agree on transfers', () => {
  it('names the transfer scope, the pending kind and the duplicate refusal', () => {
    const tool = tools().find((x) => x.name === 'transfer')!;
    expect(tool.endpoint).toEqual({ method: 'POST', path: '/tasks/transfer' });
    expect(tool.description).toMatch(/needs_human/);
    expect(tool.description).toMatch(/idempotencyKey/);
    const op = (
      openapi() as {
        paths: Record<string, { post: { responses: Record<string, { description: string }> } }>;
      }
    ).paths['/tasks/transfer']!.post;
    expect(op.responses['202']!.description).toMatch(/pending/);
    expect(op.responses['403']!.description).toContain('tasks:transfer');
    expect(op.responses['409']!.description).toContain('duplicate_transfer');
  });
});
