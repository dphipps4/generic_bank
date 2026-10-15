import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  recognize,
  type Signature,
  waitFullyRendered,
} from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank } from '../support/banks.js';

// A few of Generic Bank's screens, recognized from what a real browser draws.
const SIGS: Signature[] = [
  {
    id: 'login.signin',
    requires: ['Operator ID', 'Password'],
    controls: [{ role: 'password' }],
    forbids: ['Welcome back'],
  },
  {
    id: 'login.code_choice',
    requires: ['Where should we send your code?'],
    controls: [{ role: 'radio' }],
  },
  { id: 'error.unavailable', requires: ['Service Unavailable'] },
  { id: 'error.fatal', requires: ['An unexpected error has occurred'] },
];

let browser: Browser;
let bank: LiveBank;
beforeAll(async () => {
  bank = await liveBank('generic');
  browser = await Browser.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

async function screenOf(path: string, headers?: Record<string, string>) {
  const p = await browser.newPage();
  if (headers) await p.call('Network.setExtraHTTPHeaders', { headers });
  await p.goto(`${bank.url}${path}`);
  const r = await waitFullyRendered(p, { limitMs: 15_000 });
  const rec = recognize(r.model, SIGS);
  await p.close();
  return { rec, rendered: r.rendered };
}

describe('recognizing Generic Bank’s screens', () => {
  it('knows the sign-in page', async () => {
    expect((await screenOf('signin')).rec.screen).toBe('login.signin');
  }, 30_000);

  it('knows the gateway’s 503 page as an error screen', async () => {
    const r = await screenOf('signin', bank.forced(['service-unavailable']));
    expect(r.rec.screen ?? r.rec.matched.join()).toBe('error.unavailable');
  }, 30_000);

  it('calls a page it has never seen unknown', async () => {
    const p = await browser.newPage();
    await p.goto(`data:text/html,<h1>Something new</h1><button>Go</button>`);
    const r = await waitFullyRendered(p, { limitMs: 8000 });
    expect(recognize(r.model, SIGS).screen).toBeNull();
    await p.close();
  }, 30_000);
});
