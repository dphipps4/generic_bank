// The runtime on synthetic pages, through a real Chrome: each test is one trouble the real banks
// showed. Needs a Chrome (`just browser`, or CHROME_PATH).
import type { Browser, Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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

  it("reads a page's own title from the frame it is drawn in, not the frameset's or the menu's", async () => {
    const p = await open('/frames');
    expect((await see(p, { limitMs: 10_000 })).title).toBe('Home');
    await press(p, 'Member Search');
    const next = await see(p, { limitMs: 10_000 });
    expect(next.title).toBe('Member Search');
    expect(
      knows(next, [
        { name: 'Home', title: 'Home', shows: [] },
        { name: 'Member Search', title: 'Member Search', shows: [] },
      ]),
    ).toBe('Member Search');
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
    // known names are hidden whole.
    expect(f.tree).toContain('Account ████7732');
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
    expect(covered(await rect('member', '4001'))).toBe(true);
    expect(covered(await rect('member', '732'))).toBe(false);
  });

  it('masks a frame from another site through its own session', async () => {
    const p = await open('/other-frame');
    await p.frameLocator('#other').getByText('Current balance').waitFor();
    const frame = (await p.locator('#other').boundingBox())!;
    const boxes = await maskBoxes(p, ['Alex Sample']);
    const inside = boxes.filter(
      (b) => b.x >= frame.x - 2 && b.y >= frame.y - 2 && b.x + b.w <= frame.x + frame.width + 2,
    );
    expect(inside.length).toBeGreaterThanOrEqual(3);
    // Read, so only its hidden characters are painted, never the whole frame.
    expect(inside.every((b) => b.w < frame.width / 2)).toBe(true);
  });

  it('paints a frame whole when no session can read it', async () => {
    const p = await open('/other-frame');
    await p.frameLocator('#other').getByText('Current balance').waitFor();
    const frame = (await p.locator('#other').boundingBox())!;
    const other = p.frames().find((f) => f !== p.mainFrame())!;
    const ctx = p.context();
    const open_ = ctx.newCDPSession.bind(ctx);
    // The frame runs in another process: the page's own session can't see inside it.
    await (await open_(other)).detach();
    ctx.newCDPSession = (t) => (t === p ? open_(t) : Promise.reject(new Error('unreadable')));
    const boxes = await maskBoxes(p, []);
    expect(
      boxes.some(
        (b) =>
          Math.abs(b.x - frame.x) <= 2 &&
          Math.abs(b.y - frame.y) <= 2 &&
          b.w >= frame.width - 2 &&
          b.h >= frame.height - 2,
      ),
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
});
