import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauth } from '@gb/oauth';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { buildServer } from '../src/server.js';

const KEY = 'k'.repeat(40);
const SEAL = 'r'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let o: ReturnType<typeof oauth>;

beforeAll(async () => {
  db = await controlDb();
  o = oauth(db, KEY);
  app = await buildServer({ oauth: o, sql: db, sealKey: SEAL, enqueue: async () => undefined });
});
afterAll(() => db.close());

const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(fields).toString(),
});
async function tokensFor(scopes: string[]) {
  const c = await o.createClient({ name: 'test agent', scopes, createdBy: 'admin@test' });
  const r = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    ...form({
      grant_type: 'authorization_code',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code: c.code,
    }),
  });
  expect(r.statusCode).toBe(200);
  return { ...c, ...r.json() };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('the Task API, with OAuth2', () => {
  it('answers health without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('refuses a call without a token, saying so in the WWW-Authenticate header', async () => {
    const r = await app.inject({ method: 'GET', url: '/tasks' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(r.headers['content-type']).toContain('application/problem+json');
  });

  it('exchanges a one-time code for tokens, and lists the catalog with them', async () => {
    const t = await tokensFor(['tasks:read']);
    expect(t.token_type).toBe('Bearer');
    const r = await app.inject({ method: 'GET', url: '/tasks', headers: bearer(t.access_token) });
    expect(r.json().tasks.map((x: { name: string }) => x.name)).toEqual([
      'check-balance',
      'transfer',
      'download-statements',
    ]);
  });

  it('takes client credentials by HTTP Basic too', async () => {
    const c = await o.createClient({ name: 'basic', scopes: ['tasks:read'], createdBy: 'a' });
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ grant_type: 'authorization_code', code: c.code }).toString(),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('speaks OAuth2 errors: invalid_client, invalid_grant, unsupported_grant_type', async () => {
    const c = await o.createClient({ name: 'errs', scopes: ['tasks:read'], createdBy: 'a' });
    const bad = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'authorization_code',
        client_id: c.clientId,
        client_secret: 'nope',
        code: c.code,
      }),
    });
    expect([bad.statusCode, bad.json().error]).toEqual([401, 'invalid_client']);
    const grant = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'authorization_code',
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code: 'gbcode_nope',
      }),
    });
    expect([grant.statusCode, grant.json().error]).toEqual([400, 'invalid_grant']);
    const kind = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({ grant_type: 'password', client_id: c.clientId, client_secret: c.clientSecret }),
    });
    expect(kind.json().error).toBe('unsupported_grant_type');
  });

  it('rotates refresh tokens over HTTP; reusing a spent one revokes the family', async () => {
    const t = await tokensFor(['tasks:read']);
    const refresh = (rt: string) =>
      app.inject({
        method: 'POST',
        url: '/oauth/token',
        ...form({
          grant_type: 'refresh_token',
          client_id: t.clientId,
          client_secret: t.clientSecret,
          refresh_token: rt,
        }),
      });
    const next = (await refresh(t.refresh_token)).json();
    expect(
      (await app.inject({ method: 'GET', url: '/tasks', headers: bearer(next.access_token) }))
        .statusCode,
    ).toBe(200);
    expect((await refresh(t.refresh_token)).json().error).toBe('invalid_grant');
    expect(
      (await app.inject({ method: 'GET', url: '/tasks', headers: bearer(next.access_token) }))
        .statusCode,
    ).toBe(401);
  });

  it('revokes on request, and the token stops working', async () => {
    const t = await tokensFor(['tasks:read']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/oauth/revoke',
          ...form({ client_id: t.clientId, client_secret: t.clientSecret, token: t.access_token }),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/tasks', headers: bearer(t.access_token) }))
        .statusCode,
    ).toBe(401);
  });

  it('answers 403 insufficient_scope for a task, or a bank, the client may not use', async () => {
    const t = await tokensFor(['tasks:read', 'tasks:balance', 'bank:sample']);
    const call = (bank: string, task = 'check-balance') =>
      app.inject({
        method: 'POST',
        url: `/tasks/${task}`,
        headers: bearer(t.access_token),
        payload: { bank, memberId: '40017732', account: '7890' },
      });
    const wrongBank = await call('generic');
    expect(wrongBank.statusCode).toBe(403);
    expect(wrongBank.json().code).toBe('insufficient_scope');
    expect(wrongBank.headers['www-authenticate']).toContain('insufficient_scope');
    expect((await call('sample', 'download-statements')).statusCode).toBe(400);
    // The scope allows it; the registry then says no crawler serves it there yet.
    expect((await call('sample')).json().code).toBe('task_not_available');
  });

  it('refuses invalid input with the field that failed', async () => {
    const t = await tokensFor(['tasks:read', 'tasks:balance']);
    const r = await app.inject({
      method: 'POST',
      url: '/tasks/check-balance',
      headers: bearer(t.access_token),
      payload: { bank: 'generic', memberId: 'abc', account: '7890' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().fields[0].path).toBe('memberId');
  });

  it('rate-limits token requests per client', async () => {
    let t = 0;
    const limited = await buildServer({
      oauth: o,
      sql: db,
      sealKey: SEAL,
      enqueue: async () => undefined,
      now: () => t,
    });
    const ask = () =>
      limited.inject({
        method: 'POST',
        url: '/oauth/token',
        ...form({
          grant_type: 'refresh_token',
          client_id: 'gbc_x',
          client_secret: 'y',
          refresh_token: 'z',
        }),
      });
    for (let i = 0; i < 20; i++) expect((await ask()).statusCode).toBe(401);
    const r = await ask();
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('60');
    t += 61_000;
    expect((await ask()).statusCode).toBe(401);
  });
});
