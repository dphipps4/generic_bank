// One door (plan §K.5, §K.11): a token per role, only the writes that role is given, a signature
// on every write, and the privacy screen. A refused write leaves nothing behind.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sign, SIGNATURE, WRITES, type Write } from '../src/door.js';
import { openMemory, ROLES, type Role } from '../src/memory.js';
import { screen } from '../src/screen.js';
import { buildServer, type WriteHandler } from '../src/server.js';
import { memoryDb, SIGNING_KEY, testDoor, TOKENS } from './db.js';

// The writes each role is given, as §K.5 states them.
const GIVEN: Record<Role, Write[]> = {
  runner: ['episodes/runs', 'episodes/attempts', 'lessons/proposals', 'lessons/relied-on'],
  factory: [
    'episodes/runs',
    'episodes/attempts',
    'hypotheses',
    'lessons/proposals',
    'lessons/relied-on',
    'facts/invalidate',
  ],
  curator: ['facts/invalidate', 'lessons/retire', 'curated', 'curated/approve'],
  system: ['facts', 'facts/invalidate', 'lessons/confirm', 'lessons/retire'],
};

let db: Awaited<ReturnType<typeof memoryDb>>;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  db = await memoryDb();
  const memory = openMemory(db);
  // Each write, for now, only records that it ran: its change-log row.
  const writes = Object.fromEntries(
    (Object.keys(WRITES) as Write[]).map((w) => [
      w,
      ((body, role) =>
        memory.write(role, w, async () => ({
          entity: 'Probe',
          entityId: w,
          data: body,
        }))) satisfies WriteHandler,
    ]),
  );
  app = buildServer({ db, memory, door: testDoor(), writes });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const changes = async () =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ChangeLog"`)).rows[0]!.n;

function post(
  write: string,
  body: unknown,
  opts: { role?: Role | null; token?: string; key?: string | null; tamper?: boolean } = {},
) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token ?? (opts.role === null ? undefined : TOKENS[opts.role ?? 'factory']);
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.key !== null)
    headers[SIGNATURE] = sign(opts.key ?? SIGNING_KEY, 'POST', `/${write}`, payload);
  return app.inject({
    method: 'POST',
    url: `/${write}`,
    headers,
    payload: opts.tamper ? payload.replace('}', ',"extra":1}') : payload,
  });
}

/** The write is refused with `status` and nothing is written. */
async function refused(res: Promise<{ statusCode: number; json(): unknown }>, status: number) {
  const before = await changes();
  const r = await res;
  expect(r.statusCode).toBe(status);
  expect(await changes()).toBe(before);
  return r.json() as Record<string, unknown>;
}

describe('the door', () => {
  it('gives each role only the writes §K.5 gives it', async () => {
    for (const role of ROLES) {
      for (const write of Object.keys(WRITES) as Write[]) {
        const body = { note: `${role} ${write}` };
        if (GIVEN[role].includes(write)) {
          const before = await changes();
          const r = await post(write, body, { role });
          expect(r.statusCode, `${role} ${write}`).toBe(201);
          expect(r.json()).toMatchObject({ role, action: write, data: body });
          expect(await changes()).toBe(before + 1);
        } else {
          const e = await refused(post(write, body, { role }), 403);
          expect(e, `${role} ${write}`).toMatchObject({ error: 'role_forbidden' });
        }
      }
    }
  });

  it('is 401 without a token or with an unknown one, for reads and writes', async () => {
    await refused(post('episodes/runs', {}, { role: null }), 401);
    await refused(post('episodes/runs', {}, { token: 'not-a-token-of-any-role-0123456789' }), 401);
    expect((await app.inject({ url: '/history' })).statusCode).toBe(401);
    const read = await app.inject({
      url: '/history',
      headers: { authorization: `Bearer ${TOKENS.runner}` },
    });
    expect(read.statusCode).toBe(200);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('is 403 for a write that is unsigned, signed with another key, or changed after signing', async () => {
    for (const opts of [
      { key: null },
      { key: 'another-key-0123456789abcdef0123456789' },
      { tamper: true },
    ]) {
      const e = await refused(post('episodes/runs', { outcome: 'succeeded' }, opts), 403);
      expect(e).toMatchObject({ error: 'role_forbidden', message: 'the write is not signed' });
    }
  });

  it.each([
    ['a password', { password: 'Hunter2!' }, 'password'],
    ['a password in text', { text: 'The password is Hunter2!' }, 'password'],
    ['a code', { text: 'The staff code 482913 arrived by email.' }, 'code'],
    ['a token', { text: `Use ${'9f'.repeat(24)} as the key.` }, 'token'],
    ['a bearer token', { text: 'Send Bearer abc123.def456 upstream.' }, 'token'],
    ['a cookie', { text: 'Set-Cookie: session=abcdef0123456789abcdef' }, 'cookie'],
    ['an account-like number', { text: 'Choose account 1234 5678 9012.' }, 'account number'],
    ['a screenshot', { frame: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' }, 'screenshot'],
    ['page data', { text: '<form action="/signin"><input name="user">' }, 'page data'],
    ['a person', { text: 'The member jane.doe@example.com signed in.' }, 'person'],
    [
      'advice to request a second code',
      { lesson: 'If the code does not arrive, request a second code.' },
      'forbidden action',
    ],
    [
      'advice to evade a CAPTCHA',
      { lesson: 'Solve the CAPTCHA with an outside service.' },
      'forbidden action',
    ],
    [
      'advice to move money without a person',
      { lesson: 'Submit the transfer without waiting for approval.' },
      'forbidden action',
    ],
  ])('is 422 for %s', async (_name, body, reason) => {
    const e = await refused(post('lessons/proposals', { evidence: [], ...body }), 422);
    expect(e).toMatchObject({ error: 'privacy_screen', reason });
    expect(JSON.stringify(e)).not.toMatch(/Hunter2|482913|abcdef0123|1234 5678|jane/);
  });

  // Last: it breaks the shared change log.
  it('is 503 for every write once the change log fails verification', async () => {
    await db.query(`UPDATE "ChangeLog" SET role = 'system' WHERE seq = 1`);
    const verify = await app.inject({
      url: '/history/verify',
      headers: { authorization: `Bearer ${TOKENS.curator}` },
    });
    expect(verify.json()).toMatchObject({ ok: false, brokenAt: 1 });
    const e = await refused(post('episodes/runs', {}, { role: 'runner' }), 503);
    expect(e).toEqual({ error: 'read_only' });
  });
});

describe('the privacy screen', () => {
  it('lets through ids, hashes, times and advice not to do a forbidden action', () => {
    expect(
      screen({
        runId: '123e4567-e89b-12d3-a456-426614174000',
        driver: 'dv_0123456789abcdef',
        evidenceHash: '1234567890'.repeat(6) + 'abcd',
        evidence: [{ run: 'run-1', frame: 'frame-0012', hash: 'ab'.repeat(32) }],
        startedAt: '2026-01-02T03:04:05.678Z',
        lesson:
          'Never request a second code. A failure after the password is submitted is terminal; do not submit the password twice.',
      }),
    ).toEqual({ ok: true });
  });

  it('lets through every entry of the starting knowledge', () => {
    const dir = join(import.meta.dirname, '../../../seeds/memory');
    for (const kind of ['rules', 'checks', 'lessons', 'scenarios', 'approaches']) {
      const { entries } = JSON.parse(readFileSync(join(dir, `${kind}.json`), 'utf8')) as {
        entries: { id: string }[];
      };
      for (const e of entries) expect(screen(e), `${kind} ${e.id}`).toEqual({ ok: true });
    }
  });
});
