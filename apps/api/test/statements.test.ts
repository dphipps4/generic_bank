import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryStore } from '@gb/evidence';
import { oauth } from '@gb/oauth';
import { createRun, settleRun, statementKey, statementRef } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { buildServer } from '../src/server.js';

// A statement a run kept, fetched by the reference in the run's result: the stored bytes exactly,
// to the client that started the run, and only with tasks:statements.
const SEAL = 'r'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let o: ReturnType<typeof oauth>;
const store = memoryStore();
const enqueued: string[] = [];
// Bytes no text decoding would keep intact.
const PDF = Buffer.from('%PDF-1.7\n\xff\x00\x80 statement\n%%EOF\n', 'latin1');

beforeAll(async () => {
  db = await controlDb();
  o = oauth(db, 'k'.repeat(40));
  app = await buildServer({
    oauth: o,
    sql: db,
    sealKey: SEAL,
    enqueue: async (id) => void enqueued.push(id),
    documents: store,
  });
});
afterAll(() => db.close());

async function client(scopes: string[]) {
  const c = await o.createClient({ name: 'agent', scopes, createdBy: 'a' });
  const token = (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
  return { clientId: c.clientId, token };
}

/** A settled run of this client's: May kept, January 2024 not available. */
async function keptRun(clientId: string, bank = 'generic') {
  const { runId } = await createRun(
    db,
    {
      task: 'download-statements',
      bank,
      clientId,
      inputs: { bank, memberId: '40017732', account: '7890', months: ['2026-05', '2024-01'] },
    },
    SEAL,
  );
  await store.put(statementKey(runId, '2026-05'), PDF, 'application/pdf');
  await settleRun(db, runId, {
    status: 'succeeded',
    data: {
      months: [
        { month: '2026-05', statement: statementRef(runId, '2026-05') },
        {
          month: '2024-01',
          statement: null,
          note: 'Only the last 12 months of statements are available online.',
        },
      ],
    },
  });
  return runId;
}

const fetchStatement = (token: string, ref: string) =>
  app.inject({
    method: 'GET',
    url: `/statements/${ref}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('Download Statements through the API', () => {
  it('is promoted for Generic Bank: a request is accepted and handed to the Runner', async () => {
    const a = await client(['tasks:read', 'tasks:statements']);
    const r = await app.inject({
      method: 'POST',
      url: '/tasks/download-statements',
      headers: { authorization: `Bearer ${a.token}` },
      payload: { bank: 'generic', memberId: '40017732', account: '7890', months: ['2026-05'] },
    });
    expect([r.statusCode, r.json().task, r.json().status]).toEqual([
      202,
      'download-statements',
      'running',
    ]);
    expect(enqueued).toContain(r.json().runId);
  });

  it('needs tasks:statements to start', async () => {
    const balance = await client(['tasks:read', 'tasks:balance']);
    const r = await app.inject({
      method: 'POST',
      url: '/tasks/download-statements',
      headers: { authorization: `Bearer ${balance.token}` },
      payload: { bank: 'generic', memberId: '40017732', account: '7890', months: ['2026-05'] },
    });
    expect([r.statusCode, r.json().code]).toEqual([403, 'insufficient_scope']);
  });
});

describe('a statement, by its reference', () => {
  it('is the stored PDF, byte for byte, for the client that started the run', async () => {
    const a = await client(['tasks:read', 'tasks:statements']);
    const runId = await keptRun(a.clientId);
    const result = await app.inject({
      method: 'GET',
      url: `/tasks/${runId}`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    const ref = result.json().data.months[0].statement;
    expect(ref).toMatch(/^st_[0-9a-f]{16}_2026-05$/);
    const r = await fetchStatement(a.token, ref);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.rawPayload.equals(PDF)).toBe(true);
  });

  it('is refused to a client without tasks:statements, even for its own run', async () => {
    const reader = await client(['tasks:read']);
    const ref = statementRef(await keptRun(reader.clientId), '2026-05');
    const r = await fetchStatement(reader.token, ref);
    expect([r.statusCode, r.json().code]).toEqual([403, 'insufficient_scope']);
    expect(r.headers['www-authenticate']).toContain('scope="tasks:statements"');
    expect(r.body).not.toContain('PDF');
  });

  it('is refused to a client limited to other banks', async () => {
    const other = await client(['tasks:read', 'tasks:statements', 'bank:example']);
    const ref = statementRef(await keptRun(other.clientId, 'generic'), '2026-05');
    expect((await fetchStatement(other.token, ref)).statusCode).toBe(403);
  });

  it('does not exist for another client, for a month the run did not keep, or for a malformed reference', async () => {
    const a = await client(['tasks:read', 'tasks:statements']);
    const b = await client(['tasks:read', 'tasks:statements']);
    const runId = await keptRun(a.clientId);
    const missing = async (token: string, ref: string) => {
      const r = await fetchStatement(token, ref);
      expect([r.statusCode, r.json().code]).toEqual([404, 'no_such_statement']);
    };
    await missing(b.token, statementRef(runId, '2026-05'));
    await missing(a.token, statementRef(runId, '2024-01'));
    await missing(a.token, statementRef(runId, '2026-04'));
    await missing(a.token, 'st_nonsense');
    await missing(a.token, '..%2F..%2Fruns');
  });
});
