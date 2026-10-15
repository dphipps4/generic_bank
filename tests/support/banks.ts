// The banks as the outside world, for browser tests: each bank runs in-process on real ports with
// its own in-process Postgres, and the tests reach it only over HTTP, through a real browser. The
// test harness may start a bank; nothing in apps/ or packages/ may import one.
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connectInProcess, type Db, migrate } from '../../apps/bank/src/db.js';
import { hazards, type HazardName, signHazards } from '../../apps/bank/src/hazards.js';
import { OPERATORS, seed } from '../../apps/bank/src/seed.js';
import { buildServer } from '../../apps/bank/src/server.js';
import { TENANTS, type TenantId } from '../../apps/bank/src/tenants.js';
import { totp } from '../../apps/bank/src/auth.js';
import { MAC_CHROME } from '../../apps/bank/test/browser.js';

export const PASSWORDS = {
  service: 'service-password-for-tests',
  supervisor: 'supervisor-password-for-tests',
};
export const HMAC = 'h'.repeat(32);

export interface LiveBank {
  id: TenantId;
  db: Db;
  /** e.g. http://localhost:51234/corelink/ */
  url: string;
  origin: string;
  secondOrigin?: string;
  forced(names: HazardName[]): Record<string, string>;
  close(): Promise<void>;
}

export async function liveBank(
  id: TenantId,
  o: { now?: () => Date; profile?: 'none' | 'default' } = {},
): Promise<LiveBank> {
  const t = TENANTS[id];
  const db = await connectInProcess();
  await migrate(db);
  const now = o.now ?? (() => new Date());
  await seed(
    db,
    t,
    { servicePassword: PASSWORDS.service, supervisorPassword: PASSWORDS.supervisor },
    now(),
  );
  const bank = {
    t,
    db,
    now,
    uiVersion: 1,
    ports: { main: 0, second: undefined as number | undefined },
    hazards: hazards({
      profile: o.profile ?? 'none',
      seed: 1,
      forceable: true,
      hmacKey: HMAC,
      log: () => undefined,
    }),
  };
  const main = await buildServer(bank);
  await main.listen({ host: '127.0.0.1', port: 0 });
  bank.ports.main = (main.server.address() as AddressInfo).port;
  let second: Awaited<ReturnType<typeof buildServer>> | undefined;
  if (t.secondOrigin) {
    second = await buildServer(bank);
    await second.listen({ host: '127.0.0.1', port: 0 });
    bank.ports.second = (second.server.address() as AddressInfo).port;
  }
  const origin = `http://localhost:${bank.ports.main}`;
  return {
    id,
    db,
    url: `${origin}${t.basePath}`,
    origin,
    secondOrigin: bank.ports.second ? `http://localhost:${bank.ports.second}` : undefined,
    forced: (names) => ({ 'x-hazards': signHazards(names, HMAC) }),
    close: async () => {
      await main.close();
      await second?.close();
      await db.close();
    },
  };
}

/**
 * Signs the service account in over plain HTTP, the way a person's browser would and with its
 * headers, so banks 2 to 4 let it in, and returns the cookies. For tests that need a signed-in
 * console before the crawler can type for itself.
 */
export async function signedInCookies(b: LiveBank): Promise<{ name: string; value: string }[]> {
  const t = TENANTS[b.id];
  const jar = new Map<string, string>();
  const at = (path: string) =>
    t.secondOrigin === 'signin' && /signin|code|auth\//.test(path)
      ? `${b.secondOrigin}${t.basePath}${path}`
      : `${b.url}${path}`;
  const keep = (r: Response) => {
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      jar.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
  };
  const headers = () => ({
    ...MAC_CHROME,
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  });
  const name = (logical: string) =>
    `f${createHmac('sha256', jar.get('CLFORM') ?? '')
      .update(logical)
      .digest('hex')
      .slice(0, 8)}`;
  const post = async (path: string, fields: Record<string, string>) => {
    const r = await fetch(at(path), {
      method: 'POST',
      redirect: 'manual',
      headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.entries(fields).map(([k, v]) => [name(k), v])),
    });
    keep(r);
    return r;
  };
  const code = async () => {
    if (t.codeStyle === 'authenticator') {
      const r = await b.db.query<{ s: string }>(
        'SELECT totp_secret AS s FROM operators WHERE operator_id = $1',
        [OPERATORS.service.id],
      );
      return totp(r.rows[0]!.s, new Date());
    }
    const r = await b.db.query<{ body: string }>(
      `SELECT m.body FROM messages m JOIN operators o ON m.address IN (o.phone, o.email) WHERE o.operator_id = $1 ORDER BY m.id DESC LIMIT 1`,
      [OPERATORS.service.id],
    );
    return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    keep(await fetch(at('signin'), { headers: headers() }));
    await post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service });
    keep(await fetch(at('code'), { headers: headers(), redirect: 'manual' }));
    await post('code', { channel: 'text' });
    const r = await post('code/enter', { code: await code() });
    const handoff = new URL(r.headers.get('location') ?? '', b.url).searchParams.get('code') ?? '';
    const done = await fetch(at(`auth/complete?code=${encodeURIComponent(handoff)}`), {
      headers: headers(),
      redirect: 'manual',
    });
    keep(done);
    if (done.status === 302) break; // bank 4 bounces the first hand-off of the day
  }
  if (t.termsAfterSignIn) await post('terms', {});
  return [...jar].map(([n, value]) => ({ name: n, value }));
}
