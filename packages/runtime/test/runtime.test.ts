// The runtime on synthetic pages, through a real Chrome: each test is one trouble the real banks
// showed. Needs a Chrome (`just browser`, or CHROME_PATH).
import type { Browser, Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  distance,
  field,
  fingerprint,
  knows,
  labelPicture,
  launch,
  maskBoxes,
  NEAR,
  newPage,
  press,
  read,
  see,
  TargetError,
  type,
  UnknownPage,
} from '../src/index.js';
import { cropOf, findCrop } from '../src/match.js';
import { chooseAt, clickAt, typeAt, whatIsAt } from '../src/hands.js';
import { serve } from './pages.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof serve>>;
let page: Page;

beforeAll(async () => {
  [browser, site] = await Promise.all([launch(), serve()]);
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const open = async (path: string) => {
  page = await newPage(browser);
  await page.goto(site.url + path);
  return page;
};
const textIn = async (p: Page) =>
  (
    await Promise.all(
      p
        .frames()
        .map(async (f) => ((await f.locator('body').count()) ? f.locator('body').innerText() : '')),
    )
  ).join('\n');

describe('the runtime: see first, then click', () => {
  it('reads a frameset frame by frame, and a link in one frame drives another', async () => {
    const p = await open('/frames');
    const first = await see(p, { limitMs: 10_000 });
    expect(knows(first, [{ name: 'welcome', shows: ['Welcome'] }])).toBe('welcome');
    await press(p, 'Member Search');
    const next = await see(p, { limitMs: 10_000 });
    expect(
      knows(next, [
        { name: 'welcome', shows: ['Welcome'] },
        { name: 'search', shows: ['Search for a member'] },
      ]),
    ).toBe('search');
  });

  it('names an unknown page, with the closest it knows', async () => {
    const p = await open('/frames');
    const f = await see(p, { limitMs: 10_000 });
    const e = (() => {
      try {
        knows(f, [{ name: 'summary', shows: ['Available balance', 'Welcome'] }]);
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(UnknownPage);
    expect((e as UnknownPage).closest).toEqual(['summary']);
  });

  it('finds a field by the label drawn beside it, not the decoy below', async () => {
    const p = await open('/label');
    await see(p, { limitMs: 10_000 });
    await type(p, 'Member number', '40017732');
    expect(await p.locator('#m').inputValue()).toBe('40017732');
    expect(await p.locator('#decoy').inputValue()).toBe('');
    await expect(field(p, 'Member name')).rejects.toBeInstanceOf(TargetError);
  });

  it('finds a field by sight when its label is a picture of words, wherever it moves', async () => {
    // Two label pictures that look different: stripes one way, and the other.
    const picture = (vertical: boolean) => {
      const png = new PNG({ width: 90, height: 18 });
      for (let y = 0; y < 18; y++)
        for (let x = 0; x < 90; x++) {
          const dark = vertical ? Math.floor(x / 10) % 2 === 0 : (x * 7 + y * 13) % 23 < 9;
          const i = (y * 90 + x) * 4;
          png.data[i] = png.data[i + 1] = png.data[i + 2] = dark ? 20 : 235;
          png.data[i + 3] = 255;
        }
      return PNG.sync.write(png);
    };
    const [user, pass] = [picture(true), picture(false)];
    const uri = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
    const row = (b: Buffer, id: string, kind = 'text') =>
      `<tr><td><img alt="" src="${uri(b)}"></td><td><input id="${id}" type="${kind}"></td></tr>`;
    page = await newPage(browser);
    await page.setContent(`<table>${row(user, 'u')}${row(pass, 'p', 'password')}</table>`);
    // As the Scout learns them: each label's picture as drawn, beside the field it chose.
    const learn = async (name: string, id: string) => {
      const b = (await page.locator(id).boundingBox())!;
      const shot = await labelPicture(page, { x: b.x, y: b.y, w: b.width, h: b.height });
      return { name, print: shot!.print, ratio: shot!.ratio };
    };
    const pictures = [await learn('USERNAME', '#u'), await learn('PASSCODE', '#p')];
    await type(page, 'PASSCODE', 'secret', pictures);
    await type(page, 'USERNAME', 'teller', pictures);
    expect([await page.locator('#u').inputValue(), await page.locator('#p').inputValue()]).toEqual([
      'teller',
      'secret',
    ]);
    // The rows swapped, and a field added above: each label still finds its own field.
    await page.setContent(
      `<input id="extra"><table>${row(pass, 'p', 'password')}${row(user, 'u')}</table>`,
    );
    await type(page, 'USERNAME', 'teller', pictures);
    expect(await page.locator('#u').inputValue()).toBe('teller');
    expect(await page.locator('#extra').inputValue()).toBe('');
    // Without its picture, a label drawn as an image finds nothing.
    await expect(field(page, 'USERNAME')).rejects.toBeInstanceOf(TargetError);
    // Two labels alike: ambiguous, so no match, never a guess.
    await page.setContent(`<table>${row(user, 'u')}${row(user, 'p', 'password')}</table>`);
    await expect(field(page, 'USERNAME', pictures)).rejects.toBeInstanceOf(TargetError);
  });

  it('presses a "button" that is styled text, and a real submit, by their drawn names', async () => {
    const p = await open('/font');
    await see(p, { limitMs: 10_000 });
    await press(p, 'Search');
    expect(await textIn(p)).toContain('font pressed');
    await press(p, 'Send');
    expect(await textIn(p)).toContain('send pressed');
  });

  it('sees a page whose marquee never stops', async () => {
    const p = await open('/marquee');
    const f = await see(p, { limitMs: 10_000 });
    expect(f.controls.map((c) => c.name)).toContain('Ready');
  });

  it('sees a page whose badge a script flashes forever, and records it as animated', async () => {
    const p = await open('/blink');
    const f = await see(p, { limitMs: 15_000 });
    expect(f.animated.length).toBe(1);
    expect(f.controls.map((c) => c.name)).toContain('Statements');
  });

  it('waits out a blank, still page until there is something to act on', async () => {
    const p = await open('/late');
    const t = Date.now();
    const f = await see(p, { limitMs: 10_000 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(1_900);
    expect(f.controls.map((c) => c.name)).toContain('Go');
  });

  it('presses the visible button, never its hidden or zero-size twins', async () => {
    const p = await open('/hidden');
    await see(p, { limitMs: 10_000 });
    await press(p, 'Save');
    expect(await textIn(p)).toContain('saved');
  });

  it('presses the one of two same-named links nearest the section a person means', async () => {
    const p = await open('/twice');
    await see(p, { limitMs: 10_000 });
    await expect(press(p, 'Transfer Funds')).rejects.toBeInstanceOf(TargetError);
    await press(p, 'Transfer Funds', { near: 'Member Summary' });
    expect(await textIn(p)).toContain('from the summary');
  });

  it('sees an error page that has words and nothing to act on', async () => {
    const p = await open('/unavailable');
    const f = await see(p, { limitMs: 10_000 });
    expect(knows(f, [{ name: 'unavailable', shows: ['Service Unavailable'] }])).toBe('unavailable');
  });

  it('looks again when a page moves on while it is being looked at', async () => {
    const p = await open('/moves-on');
    const f = await see(p, { limitMs: 10_000 });
    expect(f.address).toContain('/label');
  });

  it('never calls a page that says it is processing ready, and says what it showed', async () => {
    const p = await open('/processing');
    await expect(see(p, { limitMs: 3_000 })).rejects.toThrow(/please wait/);
  });

  it('refuses a control something is drawn over', async () => {
    const p = await open('/covered');
    await see(p, { limitMs: 10_000 });
    await expect(press(p, 'Pay', { timeoutMs: 1_500 })).rejects.toThrow(
      /intercepts pointer events|Timeout/,
    );
  });

  it('answers a surprise dialog without committing, and records it', async () => {
    const p = await open('/confirm');
    const f = await see(p, { limitMs: 10_000 });
    expect(f.dialogs).toEqual(['confirm: Leave unsaved changes?']);
    expect(knows(f, [{ name: 'done', shows: ['Done'] }])).toBe('done');
  });

  it('masks money, long numbers and known names in the picture, the page text and the address', async () => {
    const p = await open('/mask?token=abc123');
    const f = await see(p, { known: ['Alex Sample'], limitMs: 10_000 });
    expect(f.tree).not.toMatch(/41,231|40017732|Alex Sample/);
    expect(f.address).not.toContain('token');
    expect(f.controls.map((c) => c.name).join(' ')).not.toContain('40017732');
    const img = PNG.sync.read(f.picture);
    const boxes = await maskBoxes(p, ['Alex Sample']);
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    for (const b of boxes) {
      const x = Math.floor(b.x + b.w / 2);
      const y = Math.floor(b.y + b.h / 2);
      const i = (y * img.width + x) * 4;
      expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([255, 255, 255]);
    }
  });

  it('reads the page unmasked for the crawler, and keeps nothing', async () => {
    const p = await open('/mask');
    await see(p, { known: ['Alex Sample'], limitMs: 10_000 });
    expect(await read(p)).toMatch(/41,231/);
  });

  it('knows a picture of text by its fingerprint, and tells two apart', async () => {
    const p = await open('/pictures');
    await see(p, { limitMs: 10_000 });
    const imgs = p.getByRole('img');
    const a = fingerprint(await imgs.nth(0).screenshot());
    const b = fingerprint(await imgs.nth(1).screenshot());
    expect(distance(a, fingerprint(await imgs.nth(0).screenshot()))).toBe(0);
    expect(distance(a, b)).toBeGreaterThan(NEAR);
  });

  it('presents as Chrome on a Mac', async () => {
    const p = await open('/label');
    expect(
      await p.evaluate(() => [navigator.userAgent, navigator.webdriver, navigator.platform]),
    ).toEqual([expect.stringContaining('Macintosh'), false, 'MacIntel']);
  });

  it('finds a label in a screenshot by sight, wherever it moves, and never guesses between two', async () => {
    const label = (text: string) =>
      `<span style="font:bold 15px monospace;letter-spacing:2px;background:#eee;padding:2px">${text}</span>`;
    const form = (top: number, extra = '') =>
      `<body style="margin:0;background:#fdfbf4">${extra}<div style="position:absolute;left:${120 + top}px;top:${top}px">
        <div>${label('USERNAME:')} <input style="width:220px"></div>
        <div style="margin-top:8px">${label('PASSCODE:')} <input type="password" style="width:220px"></div></div></body>`;
    page = await newPage(browser);
    await page.setContent(form(60));
    const first = await page.screenshot();
    const u = (await page.getByText('USERNAME:').boundingBox())!;
    const anchor = cropOf(first, { x: u.x, y: u.y, w: u.width, h: u.height });
    // Moved, with more on the page: found where it now is.
    await page.setContent(
      form(200, '<h1 style="margin:20px">Welcome back</h1><p>Some other words</p>'),
    );
    const started = Date.now();
    const found = findCrop(await page.screenshot(), anchor);
    const ms = Date.now() - started;
    const now = (await page.getByText('USERNAME:').boundingBox())!;
    expect(found).not.toBeNull();
    expect(Math.abs(found!.box.x - now.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(found!.box.y - now.y)).toBeLessThanOrEqual(2);
    expect(found!.score).toBeGreaterThan(0.9);
    expect(ms).toBeLessThan(3000);
    // Two of the same label: ambiguous, so no match.
    await page.setContent(form(60) + form(300));
    expect(findCrop(await page.screenshot(), anchor)).toBeNull();
  });

  it('says what is at a point, frames included, and types and clicks there with no selector', async () => {
    page = await newPage(browser);
    await page.setContent(`<body style="margin:0">
      <input id="u" style="position:absolute;left:20px;top:20px;width:200px;height:24px">
      <input id="p" type="password" style="position:absolute;left:20px;top:60px;width:200px;height:24px">
      <button id="b" onclick="this.textContent='Pressed'" style="position:absolute;left:20px;top:100px;width:120px;height:30px">Log In</button>
      <a href="#x" style="position:absolute;left:20px;top:150px">Member Search</a>
      <iframe srcdoc="<input id=f style='width:150px;height:24px'>" style="position:absolute;left:300px;top:20px;width:220px;height:80px;border:0"></iframe>
    </body>`);
    const kind = async (x: number, y: number) => (await whatIsAt(page, { x, y })).kind;
    expect(await kind(120, 32)).toBe('field');
    expect(await kind(120, 72)).toBe('password field');
    expect(await kind(80, 115)).toBe('button');
    expect(await kind(40, 158)).toBe('link');
    expect(await kind(340, 40)).toBe('field');
    expect(await kind(700, 500)).not.toMatch(/field|button|link/);
    await typeAt(page, { x: 120, y: 32 }, 'teller0412');
    expect(await page.locator('#u').inputValue()).toBe('teller0412');
    await typeAt(page, { x: 120, y: 32 }, 'again');
    expect(await page.locator('#u').inputValue()).toBe('again');
    await clickAt(page, { x: 80, y: 115 });
    expect(await page.locator('#b').textContent()).toBe('Pressed');
  });

  it('chooses from a list by position and keyboard, reading what it shows', async () => {
    page = await newPage(browser);
    await page.setContent(`<body style="margin:0"><select id="s" style="position:absolute;left:20px;top:20px;width:360px">
      <option>Choose an account</option>
      <option>Everyday Checking, Account ending in 8176, available $4,800.00</option>
      <option>Rainy Day Savings, Account ending in 9433, available $12,000.00</option>
    </select></body>`);
    const shown = await chooseAt(page, { x: 200, y: 30 }, '9433');
    expect(shown).toContain('Rainy Day Savings');
    expect(await page.locator('#s').inputValue()).toContain('9433');
    await expect(chooseAt(page, { x: 200, y: 30 }, '0000')).rejects.toBeInstanceOf(TargetError);
  });
});
