import type { FastifyInstance } from 'fastify';
import { connectInProcess, type Db, migrate } from '../src/db.js';
import { type HazardName, hazards, signHazards } from '../src/hazards.js';
import { fieldName } from '../src/markup/dialect.js';
import { OPERATORS, seed } from '../src/seed.js';
import { buildServer } from '../src/server.js';
import { TENANTS, type TenantId } from '../src/tenants.js';

// A bank on an in-process Postgres, a movable clock, and a client that keeps cookies the way a
// browser does and fills forms by field meaning, the way only the server can.

export const PASSWORDS = {
  service: 'service-password-for-tests',
  supervisor: 'supervisor-password-for-tests',
};
export const HMAC = 'h'.repeat(32);

export interface TestBank {
  app: FastifyInstance;
  db: Db;
  base: string;
  clock: { now: Date; advance(ms: number): void };
  client(): Client;
  close(): Promise<void>;
}

export async function testBank(
  id: TenantId = 'generic',
  start = new Date('2026-06-15T15:00:00Z'),
): Promise<TestBank> {
  const t = TENANTS[id];
  const db = await connectInProcess();
  await migrate(db);
  await seed(
    db,
    t,
    { servicePassword: PASSWORDS.service, supervisorPassword: PASSWORDS.supervisor },
    start,
  );
  const clock = {
    now: start,
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const app = await buildServer({
    t,
    db,
    now: () => clock.now,
    uiVersion: 1,
    hazards: hazards({
      profile: 'none',
      seed: 1,
      forceable: true,
      hmacKey: HMAC,
      log: () => undefined,
    }),
  });
  return {
    app,
    db,
    base: t.basePath,
    clock,
    client: () => new Client(app, t.basePath),
    close: async () => (await app.close(), db.close()),
  };
}

export interface Res {
  status: number;
  body: string;
  location: string;
  headers: Record<string, unknown>;
}

export class Client {
  cookies = new Map<string, string>();
  hazards: HazardName[] | null = null;
  constructor(
    private app: FastifyInstance,
    private base: string,
  ) {}

  private headers() {
    const h: Record<string, string> = {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    };
    if (this.hazards) h['x-hazards'] = signHazards(this.hazards, HMAC);
    return h;
  }

  private keep(r: { cookies: { name: string; value: string; maxAge?: number; expires?: Date }[] }) {
    for (const c of r.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() <= Date.now()))
        this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }

  url = (path: string) => (path.startsWith('/') ? path : `${this.base}${path}`);

  async get(path: string): Promise<Res> {
    const r = await this.app.inject({
      method: 'GET',
      url: this.url(path),
      headers: this.headers(),
    });
    this.keep(r);
    return {
      status: r.statusCode,
      body: r.body,
      location: String(r.headers.location ?? ''),
      headers: r.headers,
    };
  }

  /** Posts a form by field meaning: the client maps each meaning to this session's field name. */
  async post(path: string, fields: Record<string, string>): Promise<Res> {
    const nonce = this.cookies.get('CLFORM') ?? '';
    const payload = new URLSearchParams(
      Object.entries(fields).map(([k, v]) => [fieldName(nonce, k), v]),
    ).toString();
    const r = await this.app.inject({
      method: 'POST',
      url: this.url(path),
      headers: { ...this.headers(), 'content-type': 'application/x-www-form-urlencoded' },
      payload,
    });
    this.keep(r);
    return {
      status: r.statusCode,
      body: r.body,
      location: String(r.headers.location ?? ''),
      headers: r.headers,
    };
  }
}

export async function lastCode(db: Db, address: string): Promise<string> {
  const r = await db.query<{ body: string }>(
    'SELECT body FROM messages WHERE address = $1 ORDER BY id DESC LIMIT 1',
    [address],
  );
  return /(\d{6})/.exec(r.rows[0]?.body ?? '')?.[1] ?? '';
}

/** The newest code sent to an operator, by text or by email. */
export async function lastCodeFor(db: Db, operatorId: string): Promise<string> {
  const r = await db.query<{ body: string }>(
    `SELECT m.body FROM messages m JOIN operators o ON m.address IN (o.phone, o.email)
      WHERE o.operator_id = $1 ORDER BY m.id DESC LIMIT 1`,
    [operatorId],
  );
  return /(\d{6})/.exec(r.rows[0]?.body ?? '')?.[1] ?? '';
}

export async function phoneOf(db: Db, operatorId: string): Promise<string> {
  const r = await db.query<{ phone: string }>(
    'SELECT phone FROM operators WHERE operator_id = $1',
    [operatorId],
  );
  return r.rows[0]!.phone;
}

/** Signs the service account in through every page, as a person would. */
export async function signIn(
  b: TestBank,
  c = b.client(),
  o: { trust?: boolean } = {},
): Promise<Client> {
  await c.get('signin');
  await c.post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service });
  await c.get('code'); // a bank with one channel sends the code from here
  await c.post('code', { channel: 'text' });
  const code = await lastCodeFor(b.db, OPERATORS.service.id);
  const r = await c.post('code/enter', { code, ...(o.trust ? { trust: '1' } : {}) });
  const handoff = new URL(r.location, 'http://x').searchParams.get('code') ?? '';
  await c.get(`auth/complete?code=${encodeURIComponent(handoff)}`);
  return c;
}
