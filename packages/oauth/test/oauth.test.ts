import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_MS,
  allows,
  CODE_TTL_MS,
  oauth,
  OAuthError,
  REFRESH_TTL_MS,
} from '../src/index.js';
import { controlDb } from './control.js';

const KEY = 'k'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let clock = new Date('2026-06-15T15:00:00Z');
const later = (ms: number) => (clock = new Date(clock.getTime() + ms));
const o = () => oauth(db, KEY, () => clock);

beforeAll(async () => {
  db = await controlDb();
});
afterAll(() => db.close());

const fails = async (p: Promise<unknown>, error: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(OAuthError);
  expect((e as OAuthError).error).toBe(error);
};

describe('clients', () => {
  it('get a secret and a one-time code, of which only hashes are stored', async () => {
    const c = await o().createClient({
      name: 'Member assistant',
      scopes: ['tasks:read', 'tasks:balance'],
      createdBy: 'admin@test',
    });
    expect(c.clientId).toMatch(/^gbc_/);
    expect(c.clientSecret).toMatch(/^gbcs_/);
    expect(c.code).toMatch(/^gbcode_/);
    const dump =
      JSON.stringify((await db.query('SELECT * FROM "ApiClient"')).rows) +
      JSON.stringify((await db.query('SELECT * FROM "ApiCode"')).rows);
    expect(dump).not.toContain(c.clientSecret);
    expect(dump).not.toContain(c.code);
  });

  it('refuse an unknown scope', async () => {
    await fails(
      o().createClient({ name: 'x', scopes: ['tasks:everything'], createdBy: 'a' }),
      'invalid_scope',
    );
    await fails(o().createClient({ name: 'x', scopes: [], createdBy: 'a' }), 'invalid_scope');
  });
});

describe('tokens', () => {
  it('a code becomes an access token for 15 minutes and a refresh token for 30 days, once', async () => {
    const c = await o().createClient({ name: 'a', scopes: ['tasks:read'], createdBy: 'a' });
    const t = await o().exchangeCode(c.clientId, c.clientSecret, c.code);
    expect(t).toMatchObject({
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_MS / 1000,
      scope: 'tasks:read',
    });
    expect(await o().authenticate(t.access_token)).toMatchObject({
      clientId: c.clientId,
      scopes: ['tasks:read'],
    });
    await fails(o().exchangeCode(c.clientId, c.clientSecret, c.code), 'invalid_grant');
    later(ACCESS_TTL_MS + 1);
    expect(await o().authenticate(t.access_token)).toBeNull();
  });

  it('refuse a wrong secret as invalid_client, and an expired code as invalid_grant', async () => {
    const c = await o().createClient({ name: 'b', scopes: ['tasks:read'], createdBy: 'a' });
    await fails(o().exchangeCode(c.clientId, 'gbcs_wrong', c.code), 'invalid_client');
    await fails(o().exchangeCode('gbc_nobody', c.clientSecret, c.code), 'invalid_client');
    later(CODE_TTL_MS + 1);
    await fails(o().exchangeCode(c.clientId, c.clientSecret, c.code), 'invalid_grant');
  });

  it('rotate on refresh; a spent refresh token revokes the whole family', async () => {
    const c = await o().createClient({ name: 'c', scopes: ['tasks:read'], createdBy: 'a' });
    const first = await o().exchangeCode(c.clientId, c.clientSecret, c.code);
    const second = await o().refresh(c.clientId, c.clientSecret, first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await o().authenticate(second.access_token)).not.toBeNull();
    await fails(o().refresh(c.clientId, c.clientSecret, first.refresh_token), 'invalid_grant');
    expect(await o().authenticate(second.access_token)).toBeNull();
    await fails(o().refresh(c.clientId, c.clientSecret, second.refresh_token), 'invalid_grant');
    const audit = await db.query<{ reason: string }>(
      `SELECT reason FROM "AuditEntry" WHERE action = 'family.revoked'`,
    );
    expect(audit.rows.map((r) => r.reason)).toContain(
      'a spent refresh token was presented again: possible theft',
    );
  });

  it('expire refresh tokens after 30 days', async () => {
    const c = await o().createClient({ name: 'd', scopes: ['tasks:read'], createdBy: 'a' });
    const t = await o().exchangeCode(c.clientId, c.clientSecret, c.code);
    later(REFRESH_TTL_MS + 1);
    await fails(o().refresh(c.clientId, c.clientSecret, t.refresh_token), 'invalid_grant');
  });

  it('stop working when revoked by the client, or when an admin revokes the client', async () => {
    const c = await o().createClient({ name: 'e', scopes: ['tasks:read'], createdBy: 'a' });
    const t = await o().exchangeCode(c.clientId, c.clientSecret, c.code);
    await o().revoke(c.clientId, c.clientSecret, t.refresh_token);
    expect(await o().authenticate(t.access_token)).toBeNull();
    const code = await o().newCode(c.clientId, 'admin');
    const u = await o().exchangeCode(c.clientId, c.clientSecret, code);
    await o().revokeClient(c.clientId, 'admin');
    expect(await o().authenticate(u.access_token)).toBeNull();
    await fails(o().refresh(c.clientId, c.clientSecret, u.refresh_token), 'invalid_client');
  });

  it('are written to the audit trail', async () => {
    const actions = (
      await db.query<{ action: string }>('SELECT DISTINCT action FROM "AuditEntry"')
    ).rows
      .map((r) => r.action)
      .sort();
    expect(actions).toEqual([
      'client.created',
      'client.revoked',
      'code.issued',
      'family.revoked',
      'token.issued',
      'token.refreshed',
    ]);
  });
});

describe('scopes', () => {
  it('allow a task only with its scope, and only on the banks a bank: scope names', () => {
    const anyBank = { clientId: 'x', familyId: 'f', scopes: ['tasks:read', 'tasks:balance'] };
    expect(allows(anyBank, 'tasks:balance', 'generic')).toBe(true);
    expect(allows(anyBank, 'tasks:transfer', 'generic')).toBe(false);
    const oneBank = { ...anyBank, scopes: [...anyBank.scopes, 'bank:example'] };
    expect(allows(oneBank, 'tasks:balance', 'example')).toBe(true);
    expect(allows(oneBank, 'tasks:balance', 'generic')).toBe(false);
  });
});
