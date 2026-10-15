import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauth } from '@gb/oauth';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { apiClientActions, onceStore, scopesFrom } from '../src/api-clients.js';
import { resources, stripSecrets } from '../src/resources.js';

let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(() => db.close());

const admin = { email: 'admin@generic-bank.local' };
const KEY = 'k'.repeat(40);
const recordOf = (id: string, params: Record<string, unknown>) => ({
  id: () => id,
  params,
  toJSON: () => ({ id, params, errors: {} }),
});
const fakeResource = { findOne: async (id: string) => recordOf(id, { id }) };
const h = {
  recordActionUrl: ({ recordId, actionName }: { recordId: string; actionName: string }) =>
    `/admin/resources/ApiClient/records/${recordId}/${actionName}`,
};

describe('API clients in the Console', () => {
  it('creates a client, returns the record AdminJS expects, and lands on the client’s own page', async () => {
    const actions = apiClientActions(oauth(db, KEY), onceStore());
    const r = (await actions.new.handler(
      {
        method: 'post',
        payload: {
          name: 'Member assistant',
          'scopes.0': 'tasks:read',
          'scopes.1': 'tasks:balance',
        },
      },
      null,
      { currentAdmin: admin, resource: fakeResource, h },
    )) as { redirectUrl: string; record: { id: string } };
    expect(r.record.id).toBeTruthy();
    expect(r.redirectUrl).toBe(`/admin/resources/ApiClient/records/${r.record.id}/show`);
  });

  it('shows the secret and code on that page once, then never again', async () => {
    const once = onceStore();
    const actions = apiClientActions(oauth(db, KEY), once);
    const r = (await actions.new.handler(
      { method: 'post', payload: { name: 'Once', 'scopes.0': 'tasks:read' } },
      null,
      { currentAdmin: admin, resource: fakeResource, h },
    )) as {
      record: { id: string };
    };
    const first = await actions.show.after({
      record: { id: r.record.id, params: { name: 'Once' } },
    });
    expect(first.record!.params!.clientSecretOnce).toMatch(/^gbcs_/);
    expect(first.record!.params!.codeOnce).toMatch(/^gbcode_/);
    const again = await actions.show.after({
      record: { id: r.record.id, params: { name: 'Once' } },
    });
    expect(again.record!.params!.clientSecretOnce).toBeUndefined();
    const stored = JSON.stringify((await db.query('SELECT * FROM "ApiClient"')).rows);
    expect(stored).not.toContain(String(first.record!.params!.clientSecretOnce));
    expect(stored).toContain('admin@generic-bank.local');
  });

  it('forgets an unopened secret after five minutes', () => {
    let t = 0;
    const once = onceStore(() => t);
    once.put('r1', { codeOnce: 'x' });
    t += 5 * 60_000 + 1;
    expect(once.take('r1')).toBeNull();
  });

  it('refuses a client without a name or with an unknown scope', async () => {
    const actions = apiClientActions(oauth(db, KEY), onceStore());
    const r = (await actions.new.handler(
      { method: 'post', payload: { name: 'x', 'scopes.0': 'root' } },
      null,
      { currentAdmin: admin },
    )) as { notice: { type: string; message: string } };
    expect(r.notice.type).toBe('error');
    expect(r.notice.message).toContain('not a scope: root');
  });

  it('revokes a client, and its tokens stop working', async () => {
    const o = oauth(db, KEY);
    const c = await o.createClient({ name: 'to revoke', scopes: ['tasks:read'], createdBy: 'a' });
    const tokens = await o.exchangeCode(c.clientId, c.clientSecret, c.code);
    await apiClientActions(o, onceStore()).revoke.handler({ method: 'post' }, null, {
      currentAdmin: admin,
      record: recordOf(c.id, { clientId: c.clientId }),
    });
    expect(await o.authenticate(tokens.access_token)).toBeNull();
  });

  it('puts a new starting code on the client’s page, once', async () => {
    const o = oauth(db, KEY);
    const c = await o.createClient({
      name: 'needs a code',
      scopes: ['tasks:read'],
      createdBy: 'a',
    });
    const once = onceStore();
    const actions = apiClientActions(o, once);
    await actions.newCode.handler({ method: 'post' }, null, {
      currentAdmin: admin,
      record: recordOf(c.id, { clientId: c.clientId }),
      h,
    });
    const shown = await actions.show.after({ record: { id: c.id, params: {} } });
    expect(
      (await o.exchangeCode(c.clientId, c.clientSecret, String(shown.record!.params!.codeOnce)))
        .token_type,
    ).toBe('Bearer');
  });

  it('strips hashes before the once-only fields are added, on the client page', async () => {
    const once = onceStore();
    once.put('r9', { codeOnce: 'gbcode_x' });
    const res = resources({} as never, apiClientActions(oauth(db, KEY), once)).find(
      (r) =>
        (r.options as { navigation: { name: string } }).navigation.name === 'API' &&
        'show' in r.options.actions,
    );
    const hooks = (
      res!.options.actions as { show: { after: ((r: unknown) => Promise<unknown> | unknown)[] } }
    ).show.after;
    let out: unknown = { record: { id: 'r9', params: { secretHash: 'h', name: 'n' } } };
    for (const hook of hooks) out = await hook(out);
    expect((out as { record: { params: object } }).record.params).toEqual({
      name: 'n',
      codeOnce: 'gbcode_x',
    });
  });

  it('reads scopes from the flattened form, and never sends a hash to the browser', () => {
    expect(
      scopesFrom({
        name: 'n',
        'scopes.0': 'tasks:read',
        'scopes.1': ' ',
        'scopes.2': 'bank:generic',
      }),
    ).toEqual(['tasks:read', 'bank:generic']);
    const out = stripSecrets({
      records: [{ params: { name: 'n', secretHash: 'h', tokenHash: 't', codeHash: 'c' } }],
    });
    expect(out.records[0]!.params).toEqual({ name: 'n' });
  });
});
