import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, type Page, waitFullyRendered } from '../../packages/screen/src/index.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, signedInCookies } from '../support/banks.js';

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

async function page(
  o: { signedIn?: boolean; headers?: Record<string, string> } = {},
): Promise<Page> {
  const p = await browser.newPage();
  if (o.signedIn)
    for (const c of await signedInCookies(bank))
      await p.call('Network.setCookie', { name: c.name, value: c.value, url: bank.url });
  if (o.headers) await p.call('Network.setExtraHTTPHeaders', { headers: o.headers });
  return p;
}

describe('fully rendered, on Generic Bank', () => {
  it('waits past the Loading shell and the form waiting for its script, despite the marquee', async () => {
    const p = await page();
    await p.goto(bank.url);
    const r = await waitFullyRendered(p, { limitMs: 20_000 });
    expect(r.rendered).toBe(true);
    expect(r.model.url).toMatch(/\/corelink\/signin$/);
    expect(r.model.controls.filter((c) => c.role === 'password' && c.enabled)).toHaveLength(1);
    expect(r.model.animated.length).toBeGreaterThan(0);
    await p.close();
  }, 30_000);

  it('does not read activity before its rows arrive, a second late', async () => {
    const a = (await accountsOf(bank.db, MEMBERS.demo))[0]!;
    const p = await page({ signedIn: true, headers: bank.forced(['late-rows']) });
    await p.goto(`${bank.url}members/${MEMBERS.demo}/activity?account=${a.id}`);
    // The page is perfectly still for a second before its rows arrive: only the screen's own
    // definition of complete (rows in the table) can tell, so the driver supplies it.
    const hasRows = (m: { texts: { text: string }[] }) =>
      m.texts.some((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.text));
    const r = await waitFullyRendered(p, { limitMs: 20_000, until: hasRows });
    expect(r.rendered).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(800);
    expect(r.model.texts.some((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.text))).toBe(true);
    await p.close();
  }, 30_000);

  it('reports a page that never finishes, with the reason, instead of passing it', async () => {
    const p = await page();
    await p.goto(`data:text/html,<p>Processing your request, please wait.</p>`);
    const r = await waitFullyRendered(p, { limitMs: 2500 });
    expect(r.rendered).toBe(false);
    expect(r.reason).toMatch(/Processing|nothing to act on/);
    await p.close();
  }, 30_000);
});
