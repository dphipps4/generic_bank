import type { FastifyInstance } from 'fastify';
import { connectInProcess, type Db, migrate } from '../src/db.js';
import { totp } from '../src/auth.js';
import { type HazardName, hazards, signHazards } from '../src/hazards.js';
import { fieldName } from '../src/markup/dialect.js';
import { OPERATORS, seed } from '../src/seed.js';
import { buildServer } from '../src/server.js';
import { TENANTS, type TenantId } from '../src/tenants.js';
import { MAC_CHROME } from './browser.js';

// A bank on an in-process Postgres, a movable clock, and a client that keeps cookies the way a
// browser does, sends Chrome-on-a-Mac's headers so banks 2 to 4 let it in, and fills forms by
// field meaning, the way only the server can.

export const PASSWORDS = {
  service: 'service-password-for-tests',
  supervisor: 'supervisor-password-for-tests',
};
export const HMAC = 'h'.repeat(32);
/** The ports each bank runs on in compose; a second port is a second origin. */
export const PORTS: Record<TenantId, { main: number; second?: number }> = {
  generic: { main: 8081 },
  example: { main: 8082, second: 8092 },
  sample: { main: 8083 },
  placeholder: { main: 8084, second: 8094 },
};

export interface TestBank {
  tenant: TenantId;
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
    ports: PORTS[id],
    hazards: hazards({
      profile: 'none',
      seed: 1,
      forceable: true,
      hmacKey: HMAC,
      log: () => undefined,
    }),
  });
  return {
    tenant: id,
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
  /** The Host header to send, which decides the origin; defaults to the bank's main port. */
  host = '';
  constructor(
    private app: FastifyInstance,
    private base: string,
  ) {}

  private headers() {
    const h: Record<string, string> = {
      ...MAC_CHROME,
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    };
    if (this.hazards) h['x-hazards'] = signHazards(this.hazards, HMAC);
    if (this.host) h.host = this.host;
    return h;
  }

  private keep(r: { cookies: { name: string; value: string; maxAge?: number; expires?: Date }[] }) {
    for (const c of r.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() <= Date.now()))
        this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }

  url = (path: string) => {
    const u = path.replace(/^https?:\/\/[^/]+/, '');
    return u.startsWith('/') ? u : `${this.base}${u}`;
  };

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

  /** The raw response, bytes and all, for images and PDFs. */
  async raw(path: string) {
    const r = await this.app.inject({
      method: 'GET',
      url: this.url(path),
      headers: this.headers(),
    });
    return {
      status: r.statusCode,
      type: String(r.headers['content-type'] ?? ''),
      bytes: r.rawPayload,
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
  for (let attempt = 0; attempt < 2; attempt++) {
    await c.get('signin');
    await c.post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service });
    await c.get('code'); // a bank with one channel sends the code from here
    await c.post('code', { channel: 'text' });
    const r = await c.post('code/enter', {
      code: await codeFor(b, OPERATORS.service.id),
      ...(o.trust ? { trust: '1' } : {}),
    });
    const handoff = new URL(r.location, 'http://x').searchParams.get('code') ?? '';
    const done = await c.get(`auth/complete?code=${encodeURIComponent(handoff)}`);
    // Bank 4 bounces the first hand-off of the day back to sign-in; a person just signs in again.
    if (done.location) return c;
  }
  throw new Error('sign-in did not complete');
}

/** The code an operator would read: from their phone or email, or their authenticator app. */
export async function codeFor(b: TestBank, operatorId: string): Promise<string> {
  const r = await b.db.query<{ totp_secret: string | null }>(
    'SELECT totp_secret FROM operators WHERE operator_id = $1',
    [operatorId],
  );
  const t = TENANTS[b.tenant];
  if (t.codeStyle === 'authenticator') return totp(r.rows[0]!.totp_secret!, b.clock.now);
  return lastCodeFor(b.db, operatorId);
}
