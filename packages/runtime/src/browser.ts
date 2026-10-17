// The browser: Chrome, driven by Playwright, presenting as Chrome on a Mac. We have a bank's web UI
// and nothing else, so we use the standard library a reviewer knows, and set the identity once per
// page from outside it (DevTools), never by script inside it.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Browser, chromium, type Dialog, type Page } from 'playwright-core';

/** Where Chrome is: CHROME_PATH, `just browser`'s install, or the Runner image's Debian chromium. */
export function findChrome(root = process.cwd()): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = resolve(root, '.run/browser/chrome');
  const inside =
    process.platform === 'darwin'
      ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      : 'chrome';
  if (existsSync(local))
    for (const v of readdirSync(local).sort().reverse())
      for (const sub of readdirSync(join(local, v))) {
        const bin = join(local, v, sub, inside);
        if (existsSync(bin)) return bin;
      }
  for (const p of ['/usr/lib/chromium/chromium', '/usr/bin/chromium']) if (existsSync(p)) return p;
  throw new Error('No Chrome found: run `just browser`, or set CHROME_PATH.');
}

/**
 * Chrome, headless, without the automation switches a bot screen looks for. `origins` are the
 * plain-HTTP addresses to treat as secure, so Chrome sends them the Sec-Fetch headers a real
 * browser sends over HTTPS (the local stack serves its banks over HTTP).
 */
export function launch(o: { origins?: string[] } = {}): Promise<Browser> {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--use-mock-keychain',
    '--password-store=basic',
  ];
  if (o.origins?.length)
    args.push(`--unsafely-treat-insecure-origin-as-secure=${o.origins.join(',')}`);
  if (process.platform === 'linux') args.push('--no-sandbox');
  return chromium.launch({
    executablePath: findChrome(),
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

/** Chromium's own brand list for a major version: computed as Chrome computes it, never chosen. */
export function brandsFor(major: number, version = String(major)) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const grease = {
    brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`,
    version: ['8', '99', '24'][major % 3]!,
  };
  const list = [
    {
      brand: grease.brand,
      version: version === String(major) ? grease.version : `${grease.version}.0.0.0`,
    },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version },
  ];
  const order = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ][major % 6]!;
  const out: typeof list = [];
  list.forEach((b, i) => (out[order[i]!] = b));
  return out;
}

export interface PageOptions {
  /** Extra request headers, such as a signed X-Hazards in tests. */
  headers?: Record<string, string>;
  /** What to do with a JavaScript dialog; dismissing it is the non-committal answer. */
  dialog?: (d: Dialog) => Promise<void>;
}

/** A page of its own (its own cookies), as Chrome on an Apple-silicon Mac. */
export async function newPage(browser: Browser, o: PageOptions = {}): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    ...(o.headers && { extraHTTPHeaders: o.headers }),
  });
  // Nothing waits long by default: a crawler that waits sets its own limit.
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  const full = browser.version();
  const major = Number(full.split('.')[0]);
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent,
    // Chrome adds the weights itself: this goes out as en-US,en;q=0.9.
    acceptLanguage: 'en-US,en',
    platform: 'MacIntel',
    userAgentMetadata: {
      brands: brandsFor(major),
      fullVersionList: brandsFor(major, full),
      fullVersion: full,
      platform: 'macOS',
      platformVersion: '26.6.2',
      architecture: 'arm',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  });
  const answer = o.dialog ?? ((d: Dialog) => d.dismiss());
  page.on('dialog', (d) => {
    dialogs.get(page)?.push(`${d.type()}: ${d.message()}`);
    void answer(d).catch(() => undefined);
  });
  dialogs.set(page, []);
  return page;
}

const dialogs = new WeakMap<Page, string[]>();

/** The dialogs a page has shown since this was last asked, oldest first. */
export function dialogsSince(page: Page): string[] {
  const seen = dialogs.get(page) ?? [];
  dialogs.set(page, []);
  return seen;
}
