import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  type Page,
  readScreen,
  type ScreenModel,
} from '../../packages/screen/src/index.js';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, signedInCookies } from '../support/banks.js';

// The screen model against the real banks, through a real browser.

let browser: Browser;
const banks: Partial<Record<'generic' | 'example' | 'sample', LiveBank>> = {};
beforeAll(async () => {
  [banks.generic, banks.example, banks.sample] = await Promise.all([
    liveBank('generic'),
    liveBank('example'),
    liveBank('sample'),
  ]);
  browser = await Browser.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  for (const b of Object.values(banks)) await b?.close();
});

async function open(
  b: LiveBank,
  path: string,
  o: { signedIn?: boolean; settle?: number } = {},
): Promise<{ m: ScreenModel; page: Page }> {
  const page = await browser.newPage();
  if (o.signedIn) {
    for (const c of await signedInCookies(b))
      await page.call('Network.setCookie', { name: c.name, value: c.value, url: b.url });
  }
  await page.goto(`${b.url}${path}`);
  await new Promise((r) => setTimeout(r, o.settle ?? 1500));
  return { m: await readScreen(page), page };
}
const roles = (m: ScreenModel, role: string) => m.controls.filter((c) => c.role === role);

describe('the screen model, on the real banks', () => {
  it('Generic Bank’s sign-in: the labels as text, one ID box, one password box, one way to sign in', async () => {
    const { m, page } = await open(banks.generic!, 'signin');
    expect(m.texts.map((t) => t.text).join(' ')).toMatch(/Operator ID:|Operator/);
    expect(roles(m, 'textbox')).toHaveLength(1);
    expect(roles(m, 'password')).toHaveLength(1);
    expect(m.controls.filter((c) => c.name === 'Sign In')).toHaveLength(1);
    // No control is the whole page, and no control's name carries script text.
    expect(m.controls.every((c) => c.box.w < 1000 && !c.name.includes('setTimeout'))).toBe(true);
    await page.close();
  });

  it('Sample Savings Bank’s sign-in: the hidden copy of the password field is not in the model', async () => {
    const { m, page } = await open(banks.sample!, 'signin');
    expect(roles(m, 'password')).toHaveLength(1);
    expect(m.controls.filter((c) => c.name === 'Enter')).toHaveLength(1);
    expect(m.dropped).toBeGreaterThan(0);
    await page.close();
  });

  it('Generic Bank’s console: one picture from three frames, the member summary drawn by script', async () => {
    const { m, page } = await open(banks.generic!, `console`, { signedIn: true, settle: 2500 });
    const nav = m.controls.find((c) => c.name === 'Member Search')!;
    expect(nav).toBeDefined();
    expect(nav.box.y).toBeGreaterThan(50);
    await page.close();
    const summary = await open(banks.generic!, `members/${MEMBERS.demo}`, {
      signedIn: true,
      settle: 2500,
    });
    expect(summary.m.texts.some((t) => /Account ending in \d{4}/.test(t.text))).toBe(true);
    expect(summary.m.controls.filter((c) => c.name === 'Activity').length).toBeGreaterThanOrEqual(
      3,
    );
    await summary.page.close();
  });

  it('Example Credit Union’s tab strip, from its second origin, is read and placed across the top', async () => {
    const { m, page } = await open(banks.example!, 'console', { signedIn: true, settle: 3000 });
    const tab = m.controls.find((c) => c.name === 'Move Money');
    expect(tab).toBeDefined();
    expect(m.frames.some((f) => f.url.startsWith(banks.example!.secondOrigin!) && f.readable)).toBe(
      true,
    );
    expect(tab!.box.y).toBeGreaterThan(40);
    expect(tab!.box.y).toBeLessThan(120);
    await page.close();
  });

  it('Example Credit Union’s labels drawn as images are images with no name, never text', async () => {
    const { m, page } = await open(banks.example!, 'signin');
    expect(m.texts.map((t) => t.text).join(' ')).not.toMatch(/Username|Passcode/);
    expect(roles(m, 'image').filter((c) => c.name === '').length).toBeGreaterThanOrEqual(2);
    await page.close();
  });

  it('Sample Savings Bank’s notice bar covers the submit control, so it is not in the model until dismissed', async () => {
    const { m, page } = await open(banks.sample!, `members/${MEMBERS.demo}/transfer`, {
      signedIn: true,
      settle: 2500,
    });
    expect(m.texts.some((t) => t.text.includes('the wire cut-off today is 3:00 PM'))).toBe(true);
    expect(m.controls.some((c) => c.name === 'Proceed')).toBe(false);
    expect(m.controls.some((c) => c.name === 'Dismiss')).toBe(true);
    await page.close();
  });
}, 120_000);
