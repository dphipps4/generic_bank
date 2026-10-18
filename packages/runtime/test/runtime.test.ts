// The runtime on synthetic pages, through a real Chrome: each test is one trouble the real banks
// showed. Needs a Chrome (`just browser`, or CHROME_PATH).
import type { Browser, Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chooseAt,
  clickAt,
  cropOf,
  findCrop,
  typeAt,
  whatIsAt,
  field,
  knows,
  nameIn,
  launch,
  maskBoxes,
  newPage,
  press,
  read,
  see,
  TargetError,
  type,
  UnknownPage,
} from '../src/index.js';
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
    expect(f.tree).not.toMatch(/41,231|40017732|Alex Sample|1,000/);
    // One for one, so the text keeps the page's shape: an identifier keeps its last four, money and
    // known names are hidden whole, and the bank's own mask is never hidden again.
    expect(f.tree).toContain('Account ████7732');
    expect(f.tree).toContain('Share ****8176-S01');
    expect(f.tree).toContain('Checking, Share ****8176-S01, available █████████');
    expect(f.tree).toContain('Current balance: ██████████ for ████ ██████');
    expect(f.address).not.toContain('token');
    expect(f.controls.map((c) => c.name).join(' ')).not.toContain('40017732');
    const img = PNG.sync.read(f.picture);
    const boxes = await maskBoxes(p, ['Alex Sample']);
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    for (const b of boxes) {
      const x = Math.floor(b.x + b.w / 2);
      const y = Math.floor(b.y + b.h / 2);
      const i = (y * img.width + x) * 4;
      // A dark block, or the seam between two: a hidden value looks hidden, never absent.
      expect([40, 120]).toContain(img.data[i]);
      expect(img.data[i + 1]).toBe(img.data[i]);
    }
  });

  it('paints exactly the hidden characters, in text and in a list, and never the last four', async () => {
    const p = await open('/mask');
    const boxes = await maskBoxes(p, []);
    // Where the browser really drew each word: the test may run script in the page; masking may not.
    const rect = (id: string, word: string) =>
      p.evaluate(
        ([i, w]) => {
          const el = document.getElementById(i!)!.firstChild!;
          const at = el.textContent!.indexOf(w!);
          const r = document.createRange();
          r.setStart(el, at);
          r.setEnd(el, at + w!.length);
          const b = r.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        },
        [id, word],
      );
    const covered = (r: { x: number; y: number; w: number; h: number }) =>
      boxes.some(
        (b) => b.x <= r.x && b.y <= r.y && b.x + b.w >= r.x + r.w && b.y + b.h >= r.y + r.h,
      );
    const touched = (r: { x: number; y: number; w: number; h: number }) =>
      boxes.some((b) => b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h);
    expect(covered(await rect('member', '4001'))).toBe(true);
    expect(covered(await rect('member', '732'))).toBe(false);
    expect(touched(await rect('share', '8176'))).toBe(false);
    const list = (await p.locator('#from').boundingBox())!;
    expect(
      boxes.some((b) => b.x >= list.x && b.x + b.w <= list.x + list.width + 1 && b.y >= list.y - 2),
    ).toBe(true);
  });

  it('names a control by its accessible name, as the runtime presses it', async () => {
    const p = await open('/mask');
    const f = await see(p, { limitMs: 10_000 });
    expect(f.controls.find((c) => c.role === 'button')?.name).toBe('Submit');
    expect(nameIn('- button "Submit"')).toBe('Submit');
    expect(nameIn('- textbox "Memo": GBX 4CBE')).toBe('Memo');
    expect(nameIn('- combobox:')).toBe('');
  });

  it('reads the page unmasked for the crawler, and keeps nothing', async () => {
    const p = await open('/mask');
    await see(p, { known: ['Alex Sample'], limitMs: 10_000 });
    expect(await read(p)).toMatch(/41,231/);
  });

  it('presents as Chrome on a Mac', async () => {
    const p = await open('/label');
    expect(
      await p.evaluate(() => [navigator.userAgent, navigator.webdriver, navigator.platform]),
    ).toEqual([expect.stringContaining('Macintosh'), false, 'MacIntel']);
  });

  it('finds a label by sight, says what is at a point, and types, clicks and chooses there', async () => {
    page = await newPage(browser);
    const form = (top: number, extra = '') =>
      `<body style="margin:0">${extra}<div style="position:absolute;left:20px;top:${top}px">
        <span style="font:bold 15px monospace;letter-spacing:2px">USERNAME:</span>
        <input id="u" style="width:200px;height:24px"></div>
        <button id="b" onclick="this.textContent='Pressed'" style="position:absolute;left:20px;top:${top + 40}px;width:120px;height:30px">Log In</button>
        <select id="s" style="position:absolute;left:20px;top:${top + 80}px;width:300px">
          <option>Choose an account</option><option>Everyday Checking 8176</option><option>Rainy Day Savings 9433</option>
        </select></body>`;
    await page.setContent(form(20));
    const l = (await page.getByText('USERNAME:').boundingBox())!;
    const anchor = cropOf(await page.screenshot(), { x: l.x, y: l.y, w: l.width, h: l.height });
    // The page moves: the anchor is found where it now is, and the field beside it typed into.
    await page.setContent(form(200, '<h1 style="margin:20px">Welcome back</h1>'));
    const found = findCrop(await page.screenshot(), anchor)!;
    const u = (await page.locator('#u').boundingBox())!;
    expect(Math.abs(found.box.y - (u.y + u.height / 2 - found.box.h / 2))).toBeLessThan(6);
    const field = { x: u.x + u.width / 2, y: u.y + u.height / 2 };
    expect((await whatIsAt(page, field)).kind).toBe('field');
    await typeAt(page, field, 'teller0412');
    expect(await page.locator('#u').inputValue()).toBe('teller0412');
    await clickAt(page, { x: 80, y: 255 });
    expect(await page.locator('#b').textContent()).toBe('Pressed');
    expect(await chooseAt(page, { x: 170, y: 290 }, '9433')).toContain('Rainy Day Savings');
    // Two of the same label: no match, never a guess.
    await page.setContent(form(20) + form(400));
    expect(findCrop(await page.screenshot(), anchor)).toBeNull();
  });
});
