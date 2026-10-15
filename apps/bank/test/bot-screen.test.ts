import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAdmin } from '../src/admin.js';
import { botReason } from '../src/botscreen.js';
import type { Bank } from '../src/context.js';
import { connectInProcess, migrate } from '../src/db.js';
import { hazards } from '../src/hazards.js';
import { buildServer } from '../src/server.js';
import { TENANTS, type TenantId } from '../src/tenants.js';
import { MAC_CHROME, MAC_CHROME_UA } from './browser.js';
import { PORTS } from './harness.js';

// Banks 2, 3 and 4 turn away anything not shaped like a browser, as a real bank's bot manager
// does; bank 1, the 2003 site, checks nothing (plan, §5.1 and Appendix C.4).

const IDS: TenantId[] = ['generic', 'example', 'sample', 'placeholder'];
const SCREENED: TenantId[] = ['example', 'sample', 'placeholder'];
/** curl's whole request, as Appendix W.5 captures it; inject adds the Host. */
const CURL = { 'user-agent': 'curl/8.7.1', accept: '*/*' };
const TOKEN = 'a'.repeat(40);

/** A bank with nobody in it: the screen needs no members, so nothing is seeded or hashed. */
async function emptyBank(
  id: TenantId,
): Promise<{ bank: Bank; app: FastifyInstance; base: string }> {
  const db = await connectInProcess();
  await migrate(db);
  const bank: Bank = {
    t: TENANTS[id],
    db,
    now: () => new Date('2026-06-15T15:00:00Z'),
    uiVersion: 1,
    ports: PORTS[id],
    hazards: hazards({
      profile: 'none',
      seed: 1,
      forceable: false,
      hmacKey: '',
      log: () => undefined,
    }),
  };
  return { bank, app: await buildServer(bank), base: TENANTS[id].basePath };
}

const banks = {} as Record<TenantId, Awaited<ReturnType<typeof emptyBank>>>;
beforeAll(async () => {
  for (const id of IDS) banks[id] = await emptyBank(id);
});
afterAll(async () => {
  for (const id of IDS) await banks[id]?.app.close();
  for (const id of IDS) await banks[id]?.bank.db.close();
});

const get = (id: TenantId, headers: Record<string, string>, path = 'signin') =>
  banks[id].app.inject({
    method: 'GET',
    url: path.startsWith('/') ? path : `${banks[id].base}${path}`,
    headers,
  });

const refusals = async (id: TenantId) =>
  (
    await banks[id].bank.db.query<{ path: string; detail: string }>(
      `SELECT path, detail FROM hazard_events WHERE hazard = 'bot-screen' ORDER BY id`,
    )
  ).rows;

describe('curl', () => {
  it.each(SCREENED)('is refused by %s with a plain "403 Access denied" page', async (id) => {
    const r = await get(id, CURL);
    expect(r.statusCode).toBe(403);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.body).toContain('Access denied');
    expect(r.body).toMatch(/Reference #[0-9A-F]{8}/);
    expect(r.body).not.toMatch(/curl|user agent|header/i);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('is refused on the second origin too', async () => {
    for (const id of ['example', 'placeholder'] as const) {
      const r = await get(id, { ...CURL, host: `localhost:${PORTS[id].second}` });
      expect(r.statusCode).toBe(403);
    }
  });

  it('is served by Generic Bank, the 2003 site', async () => {
    expect((await get('generic', CURL)).statusCode).toBe(200);
    expect((await get('generic', CURL, '')).statusCode).toBe(200);
  });

  it('is known by its whole request even under a browser’s user agent', () => {
    expect(botReason({ host: 'localhost', 'user-agent': MAC_CHROME_UA, accept: '*/*' })).toBe(
      'curl request',
    );
    expect(
      botReason({ host: 'localhost', connection: 'close', 'user-agent': 'x', accept: '*/*' }),
    ).toBe('curl request');
    expect(botReason({ host: 'localhost', 'user-agent': 'CURL/7.88.1' })).toBe('curl user agent');
  });
});

describe('a browser', () => {
  it.each(IDS)('shaped like Chrome on a Mac is served by %s', async (id) => {
    const r = await get(id, MAC_CHROME);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Access denied');
  });

  it('that says it is headless is refused', async () => {
    const ua = MAC_CHROME_UA.replace('Chrome/', 'HeadlessChrome/');
    for (const id of SCREENED)
      expect((await get(id, { ...MAC_CHROME, 'user-agent': ua })).statusCode).toBe(403);
    expect((await get('generic', { ...MAC_CHROME, 'user-agent': ua })).statusCode).toBe(200);
  });

  it('whose client hints contradict its user agent is refused', async () => {
    const linux = { ...MAC_CHROME, 'sec-ch-ua-platform': '"Linux"' };
    const mobile = { ...MAC_CHROME, 'sec-ch-ua-mobile': '?1' };
    for (const id of SCREENED) {
      expect((await get(id, linux)).statusCode).toBe(403);
      expect((await get(id, mobile)).statusCode).toBe(403);
    }
  });

  it('missing what every browser sends is refused', async () => {
    for (const name of ['accept-language', 'sec-fetch-mode', 'sec-fetch-dest']) {
      const h = { ...MAC_CHROME };
      delete h[name];
      expect((await get('sample', h)).statusCode).toBe(403);
      expect(botReason(h)).toBe(`no ${name}`);
    }
  });
});

describe('what is not screened', () => {
  it('the health check', async () => {
    for (const id of IDS) expect((await get(id, CURL, '/healthz')).statusCode).toBe(200);
  });

  it('the bank-admin API, which reads the refusals back with their reasons', async () => {
    const admin = await buildAdmin(banks.placeholder.bank, TOKEN);
    expect((await admin.inject({ url: '/healthz', headers: CURL })).statusCode).toBe(200);
    await get('placeholder', CURL);
    const rows = (
      await admin.inject({
        url: '/hazards',
        headers: { ...CURL, authorization: `Bearer ${TOKEN}` },
      })
    ).json() as { hazard: string; detail: string }[];
    expect(rows[0]).toMatchObject({ hazard: 'bot-screen' });
    expect(rows[0]!.detail).toMatch(/^curl user agent, reference [0-9A-F]{8}$/);
  });
});

describe('the hazard log', () => {
  it('holds every refusal with its reason, and nothing for a browser or for bank 1', async () => {
    const before = (await refusals('example')).length;
    await get('example', CURL);
    await get('example', { ...MAC_CHROME, 'user-agent': 'HeadlessChrome/141' });
    await get('example', { ...MAC_CHROME, 'sec-ch-ua-platform': '"Linux"' });
    await get('example', MAC_CHROME);
    const rows = (await refusals('example')).slice(before);
    expect(rows.map((r) => r.detail.replace(/, reference .*/, ''))).toEqual([
      'curl user agent',
      'headless user agent',
      'platform hint "Linux" on a Mac user agent',
    ]);
    expect(rows.every((r) => r.path === '/signin')).toBe(true);
    await get('generic', CURL);
    expect(await refusals('generic')).toEqual([]);
  });
});
