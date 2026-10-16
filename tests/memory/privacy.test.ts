// The memory suite: the privacy screen (plan §K.5), on every write. No password, code, cookie or
// token, no account-like number, no screenshot or page data, nothing about a person, and no advice
// to do a forbidden action: each is 422, names its rule and never the value, and nothing is
// written. All through the Memory service's API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryService } from '../support/memory.js';
import { as, changes, HASH, run } from './api.js';

let memory: Awaited<ReturnType<typeof memoryService>>;
const factory = () => as(memory.url, 'factory');
beforeAll(async () => {
  memory = await memoryService();
  await run(as(memory.url, 'runner'), 'privacy-1', 'generic');
});
afterAll(async () => {
  await memory.close();
});

const proposal = (text: string) => ({
  runId: 'privacy-1',
  text,
  area: 'sign-in',
  scope: 'tenant',
  confidence: 'low',
  seen: false,
  frames: ['f1'],
  evidenceHash: HASH,
});

describe('the privacy screen', () => {
  it.each([
    ['a password', 'The password is Hunter2!x for the staff account.', 'password'],
    ['a code', 'Type the code 482913 on the next page.', 'code'],
    ['a token', 'Send bearer abcdefgh12345678 with each request.', 'token'],
    ['a cookie', 'Keep cookie: session=0123456789abcdef0123 between runs.', 'cookie'],
    ['an account-like number', 'Choose account 1234 5678 9012 first.', 'account number'],
    ['a screenshot', 'See data:image/png;base64,iVBORw0KGgoAAAANS for the page.', 'screenshot'],
    ['page data', 'The page is <form action="/x"> with one field.', 'page data'],
    ['a person', 'Write to ops@example.com when it stalls.', 'person'],
    [
      'advice to do a forbidden action',
      'If the code does not arrive, request another code.',
      'forbidden action',
    ],
  ])('refuses %s in a lesson, and writes nothing', async (_what, text, reason) => {
    const before = await changes(factory());
    const r = await factory().post('lessons/proposals', proposal(text));
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: 'privacy_screen', reason, path: 'text' });
    expect(JSON.stringify(r.body)).not.toContain(text);
    expect(await changes(factory())).toBe(before);
  });

  it('refuses a value under a key that names a secret, whatever the value', async () => {
    const r = await factory().post('hypotheses', { runId: 'privacy-1', text: 'ok', password: 'x' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ reason: 'password', path: 'password' });
  });

  it('screens every write, a run’s episode too', async () => {
    const r = await run(as(memory.url, 'runner'), 'privacy-2', 'generic', {
      outcome: 'failed: account 9876 5432 1098',
    });
    expect(r.status).toBe(422);
  });

  it('lets through advice not to do a forbidden action, with its ids and hashes', async () => {
    const r = await factory().post(
      'lessons/proposals',
      proposal(
        'Never request a second code. A failure after the password is submitted is terminal.',
      ),
    );
    expect(r.status).toBe(201);
  });
});
