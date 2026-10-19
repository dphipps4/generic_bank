// The banks as the outside world, for browser tests: each bank runs in-process on real ports with
// its own in-process Postgres, and the tests reach it only over HTTP, through a real browser. The
// test harness may start a bank; nothing in apps/ or packages/ may import one.
import type { AddressInfo } from 'node:net';
import { buildAdmin } from '../../apps/bank/src/admin.js';
import { connectInProcess, type Db, migrate } from '../../apps/bank/src/db.js';
import { hazards, type HazardName, signHazards } from '../../apps/bank/src/hazards.js';
import { seed } from '../../apps/bank/src/seed.js';
import { buildServer } from '../../apps/bank/src/server.js';
import { redesigned, TENANTS, type TenantId } from '../../apps/bank/src/tenants.js';

export const PASSWORDS = {
  service: 'service-password-for-tests',
  supervisor: 'supervisor-password-for-tests',
};
export const HMAC = 'h'.repeat(32);
/** The bank-admin token the harness's admin API answers to: plainly not a real one. */
export const ADMIN_TOKEN = 'k'.repeat(40);

export interface LiveBank {
  id: TenantId;
  db: Db;
  /** e.g. http://localhost:51234/corelink/ */
  url: string;
  origin: string;
  forced(names: HazardName[]): Record<string, string>;
  /** The bank's admin API, its ground truth for tests: a GET, answered as JSON. */
  admin<T>(path: string): Promise<T>;
  close(): Promise<void>;
}

export async function liveBank(
  id: TenantId,
  o: { now?: () => Date; profile?: 'none' | 'default'; redesign?: boolean } = {},
): Promise<LiveBank> {
  // BANK_REDESIGN=1, as main.ts applies it.
  const t = o.redesign ? redesigned(TENANTS[id]) : TENANTS[id];
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
    ports: { main: 0 },
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
  const origin = `http://localhost:${bank.ports.main}`;
  const admin = await buildAdmin(bank, ADMIN_TOKEN);
  return {
    id,
    db,
    url: `${origin}${t.basePath}`,
    origin,
    forced: (names) => ({ 'x-hazards': signHazards(names, HMAC) }),
    admin: async <T>(path: string) => {
      const r = await admin.inject({
        method: 'GET',
        url: path,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (r.statusCode !== 200) throw new Error(`bank admin ${path}: ${r.statusCode}`);
      return r.json() as T;
    },
    close: async () => {
      await admin.close();
      await main.close();
      await db.close();
    },
  };
}
