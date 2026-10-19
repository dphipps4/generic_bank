// One door (plan §A.6): a token per role, only the writes that role is given, a signature
// on every write, and the privacy screen. A refused write leaves nothing behind.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sign, SIGNATURE, WRITES, type Write } from '../src/door.js';
import { ROLES, type Role } from '../src/memory.js';
import { knowledgeRoutes } from '../src/knowledge.js';
import { screen } from '../src/screen.js';
import { buildServer, type WriteHandler } from '../src/server.js';
import { memoryDb, SIGNING_KEY, testDoor, testEmbed, TOKENS } from './db.js';

// The writes each role is given, as §A.6 states them.
const GIVEN: Record<Role, Write[]> = {
  runner: ['episodes/runs', 'lessons/proposals', 'lessons/relied-on'],
  factory: ['episodes/runs', 'lessons/proposals', 'lessons/relied-on', 'facts/invalidate'],
  curator: ['facts/invalidate', 'lessons/retire'],
  system: ['facts/invalidate', 'lessons/retire'],
};

let db: Awaited<ReturnType<typeof memoryDb>>;
let app: ReturnType<typeof buildServer>;

/** How many writes the door let through to their handlers. */
let ran = 0;

beforeAll(async () => {
  db = await memoryDb();
  // Each write, for now, only counts that it ran.
  const writes = Object.fromEntries(
    (Object.keys(WRITES) as Write[]).map((w) => [
      w,
      (async (body, role) => (ran++, { role, write: w, body })) satisfies WriteHandler,
    ]),
  );
  app = buildServer({ db, door: testDoor(), writes });
  knowledgeRoutes(app, db, testEmbed);
});
afterAll(async () => {
  await app.close();
  await db.close();
});

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
  const before = ran;
  const r = await res;
  expect(r.statusCode).toBe(status);
  expect(ran).toBe(before);
  return r.json() as Record<string, unknown>;
}

describe('the door', () => {
  it('gives each role only the writes §A.6 gives it', async () => {
    for (const role of ROLES) {
      for (const write of Object.keys(WRITES) as Write[]) {
        const body = { note: `${role} ${write}` };
        if (GIVEN[role].includes(write)) {
          const before = ran;
          const r = await post(write, body, { role });
          expect(r.statusCode, `${role} ${write}`).toBe(201);
          expect(r.json()).toEqual({ role, write, body });
          expect(ran).toBe(before + 1);
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
    expect((await app.inject({ url: '/knowledge/pack?bank=example' })).statusCode).toBe(401);
    const read = await app.inject({
      url: '/knowledge/pack?bank=example',
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
});
