import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, type TestBank, testBank } from './harness.js';

let example: TestBank;
let placeholder: TestBank;
let generic: TestBank;
beforeAll(async () => {
  [example, placeholder, generic] = await Promise.all([
    testBank('example'),
    testBank('placeholder'),
    testBank('generic'),
  ]);
});
afterAll(async () => {
  await Promise.all([example.close(), placeholder.close(), generic.close()]);
});

describe('Example Credit Union’s tab strip', () => {
  it('comes from its second origin, and its tabs navigate the main origin', async () => {
    const c = await signIn(example);
    c.host = 'localhost:8082';
    expect((await c.get('console')).body).toContain(
      '<FRAME SRC="http://localhost:8092/frame/tabs" NAME="tabs"',
    );
    c.host = 'localhost:8092';
    const tabs = await c.get('frame/tabs');
    expect(tabs.body).toContain('HREF="http://localhost:8082/members/search"');
  });

  it('is named by the host the request came to, so it also works inside the compose network', async () => {
    const c = await signIn(example);
    c.host = 'bank-example:8082';
    expect((await c.get('console')).body).toContain('SRC="http://bank-example:8092/frame/tabs"');
  });
});

describe('Placeholder FCU’s sign-in form', () => {
  it('is an inline frame from the second origin; the form itself is served there', async () => {
    const c = placeholder.client();
    c.host = 'localhost:8084';
    const shell = await c.get('signin');
    expect(shell.body).toMatch(
      /<iframe SRC="http:\/\/localhost:8094\/cu\/ib\/signin\?embedded=1"/i,
    );
    expect(shell.body).not.toMatch(/TYPE="password"/i);
    c.host = 'localhost:8094';
    expect((await c.get('signin?embedded=1')).body).toMatch(/TYPE="password"/i);
  });

  it('signs in on the second origin and ends on the main origin’s console', async () => {
    const c = placeholder.client();
    c.host = 'localhost:8094';
    await c.get('signin?embedded=1');
    await signIn(placeholder, c);
    const last = await c.get('console');
    expect(last.status).toBe(200);
    const s = await placeholder.db.query<{ state: string }>(
      `SELECT state FROM sessions WHERE token = $1`,
      [c.cookies.get('CLSESS')],
    );
    expect(s.rows[0]!.state).toBe('active');
  });

  it('sends the completed hand-off to the main origin', async () => {
    const c = placeholder.client();
    c.host = 'localhost:8094';
    await c.get('signin');
    const s = await placeholder.db.query<{ token: string }>(
      `INSERT INTO sessions (token, operator_pk, state, handoff, last_seen) VALUES ('t1', 1, 'handoff', 'h1', now()) RETURNING token`,
    );
    c.cookies.set('CLSESS', s.rows[0]!.token);
    expect((await c.get('auth/complete?code=h1')).location).toBe(
      'http://localhost:8084/cu/ib/console',
    );
  });
});

describe('a bank with one origin', () => {
  it('keeps every frame on it', async () => {
    const c = await signIn(generic);
    expect((await c.get('console')).body).not.toMatch(/SRC="http/);
  });
});
