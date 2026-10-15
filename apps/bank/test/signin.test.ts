import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATORS } from '../src/seed.js';
import { lastCode, PASSWORDS, phoneOf, signIn, type TestBank, testBank } from './harness.js';

let b: TestBank;
beforeAll(async () => {
  b = await testBank();
});
afterAll(() => b.close());

describe('the way in', () => {
  it('starts with a blank Loading shell that moves on to the sign-in page by script', async () => {
    const r = await b.client().get('/corelink/');
    expect(r.body).toMatch(/Loading/);
    expect(r.body).toContain('location.replace("/corelink/signin")');
    expect((await b.client().get('/')).location).toBe('/corelink/');
  });

  it('serves a sign-in form that arrives disabled, has no ids, and names nothing by meaning', async () => {
    const r = await b.client().get('signin');
    expect(r.body).toMatch(/Operator ID/);
    expect(r.body).toMatch(/DISABLED/i);
    expect(r.body).toMatch(/elements\[i\]\.disabled = false/);
    expect(r.body).not.toMatch(/\sid=/i);
    expect(r.body).not.toMatch(/name="(operator|password)"/i);
    expect(r.body).toMatch(/Best viewed in Internet Explorer/);
  });

  it('gives each browser its own field names', async () => {
    const names = async () =>
      [...(await b.client().get('signin')).body.matchAll(/NAME="(f[0-9a-f]{8})"/gi)].map(
        (m) => m[1],
      );
    expect(await names()).not.toEqual(await names());
  });

  it('keeps the form’s field names when the browser asks for something outside the bank’s pages', async () => {
    // A browser asks for /favicon.ico on every site, without the form cookie, which reaches only
    // the bank's own pages. Answering it with a fresh form cookie would orphan the form on screen.
    const fresh = b.client();
    await fresh.get('/favicon.ico');
    expect(fresh.cookies.has('CLFORM')).toBe(false);
    const c = b.client();
    await c.get('signin');
    const before = c.cookies.get('CLFORM');
    await c.get('/favicon.ico');
    expect(c.cookies.get('CLFORM')).toBe(before);
  });

  it('refuses a wrong password, and a locked operator, in the bank’s words', async () => {
    const c = b.client();
    await c.get('signin');
    expect(
      (await c.post('signin', { operator: OPERATORS.service.id, password: 'wrong' })).body,
    ).toContain('The Operator ID and password do not match.');
    expect(
      (await c.post('signin', { operator: OPERATORS.locked.id, password: PASSWORDS.service })).body,
    ).toContain('This operator is locked. Contact your administrator.');
  });
});

describe('the code step', () => {
  it('asks where to send the code, masked, and refuses a wrong or used code', async () => {
    const c = b.client();
    await c.get('signin');
    expect(
      (await c.post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service }))
        .location,
    ).toBe('/corelink/code');
    const chooser = await c.get('code');
    expect(chooser.body).toContain('Where should we send your code?');
    expect(chooser.body).toContain('(***) ***-0412');
    expect((await c.post('code', { channel: 'text' })).location).toBe('/corelink/code/enter');
    expect((await c.get('code/enter')).body).toContain('Enter the 6-digit code we sent.');
    const code = await lastCode(b.db, await phoneOf(b.db, OPERATORS.service.id));
    expect(
      (await c.post('code/enter', { code: code === '000000' ? '111111' : '000000' })).body,
    ).toContain('That code is not correct.');
    const ok = await c.post('code/enter', { code });
    expect(ok.location).toMatch(/^\/corelink\/auth\/callback\?code=/);
  });

  it('says the code has expired after five minutes', async () => {
    const c = b.client();
    await c.get('signin');
    await c.post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service });
    await c.post('code', { channel: 'email' });
    b.clock.advance(5 * 60_000 + 1);
    const code = (
      await b.db.query<{ code: string }>('SELECT code FROM one_time_codes ORDER BY id DESC LIMIT 1')
    ).rows[0]!.code;
    expect((await c.post('code/enter', { code })).body).toContain('That code has expired.');
  });

  it('cannot be reached without a password first', async () => {
    expect((await b.client().get('code')).location).toBe('/corelink/signin');
    expect((await b.client().get('code/enter')).location).toBe('/corelink/signin');
  });
});

describe('the hand-off', () => {
  it('holds on a blank page, then signs in; the console is next', async () => {
    const c = b.client();
    await c.get('signin');
    await c.post('signin', { operator: OPERATORS.service.id, password: PASSWORDS.service });
    await c.post('code', { channel: 'text' });
    const r = await c.post('code/enter', {
      code: await lastCode(b.db, await phoneOf(b.db, OPERATORS.service.id)),
    });
    const page = await c.get(r.location);
    expect(page.body).toContain('auth/complete?code=');
    const handoff = new URL(r.location, 'http://x').searchParams.get('code')!;
    expect((await c.get(`auth/complete?code=wrong`)).location).toBe('/corelink/signin');
    expect((await c.get(`auth/complete?code=${encodeURIComponent(handoff)}`)).location).toBe(
      '/corelink/console',
    );
  });

  it('holds five to eight seconds when the slow hand-off hazard fires', async () => {
    const c = b.client();
    c.hazards = ['slow-handoff'];
    const delay = Number(/\}, (\d+)\);/.exec((await c.get('auth/callback?code=x')).body)![1]);
    expect(delay).toBeGreaterThanOrEqual(5000);
    expect(delay).toBeLessThanOrEqual(8000);
  });
});

describe('a trusted workstation', () => {
  it('gets a "Welcome back" layout, skips the code, and can still sign in as someone else', async () => {
    const c = await signIn(b, b.client(), { trust: true });
    expect(c.cookies.has('CLWS')).toBe(true);
    const page = await c.get('signin');
    expect(page.body).toContain('Welcome back, Operator 0412');
    expect(page.body).toContain('Sign in as someone else');
    const r = await c.post('signin', { password: PASSWORDS.service });
    expect(r.location).toMatch(/auth\/callback\?code=/);
    expect((await c.get('signin?other=1')).body).not.toContain('Welcome back');
  });
});

describe('signing out and expiry', () => {
  it('signs out, and keepalive then answers 401', async () => {
    const c = await signIn(b);
    expect((await c.get('signout')).body).toContain('You have signed out.');
    expect((await c.post('keepalive', {})).status).toBe(401);
  });

  it('keeps a session alive for ten idle minutes and no longer', async () => {
    const c = await signIn(b);
    b.clock.advance(9 * 60_000);
    expect((await c.post('keepalive', {})).status).toBe(204);
    b.clock.advance(11 * 60_000);
    expect((await c.post('keepalive', {})).status).toBe(401);
  });
});

describe('hazards at the door', () => {
  it('answers 503 from the gateway when forced, and 400 for an unsigned hazard header', async () => {
    const c = b.client();
    c.hazards = ['service-unavailable'];
    const r = await c.get('signin');
    expect(r.status).toBe(503);
    expect(r.body).toContain('Service Unavailable');
    const res = await b.app.inject({
      method: 'GET',
      url: '/corelink/signin',
      headers: { 'x-hazards': 'promo;00' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('serves its health, script and images without hazards', async () => {
    const c = b.client();
    c.hazards = ['service-unavailable'];
    expect((await c.get('/healthz')).status).toBe(200);
    expect((await c.get('js/corelink.js')).body).toContain('CL.idle');
    expect((await c.get('img/btn.svg?l=Sign%20In')).body).toContain('Sign In');
  });
});
