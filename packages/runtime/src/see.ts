// Seeing a page, first, before anything is clicked. A page is ready when its picture holds still
// (moving parts such as a marquee aside), nothing says it is loading, and there is something to
// act on: a blank page that holds still, such as a sign-in hand-off, is not ready. Then the
// evidence is kept: the masked picture, the rendered page (what is visible, by role and name) and
// the masked address.
import type { Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { dialogsSince } from './browser.js';
import { type Box, maskAddress, maskBoxes, maskText, paint } from './mask.js';

export interface Control {
  role: string;
  name: string;
  box: Box;
}

/** One page, as it was seen: everything here is already masked. */
export interface Frame {
  at: string;
  address: string;
  picture: Buffer;
  /** The rendered page: per frame, its visible accessibility tree. */
  tree: string;
  controls: Control[];
  /** JavaScript dialogs the page showed (and the run answered) since the last frame. */
  dialogs: string[];
  /** Small regions that kept changing (a flashing badge), left out of "holds still". */
  animated: Box[];
}

export class NotReady extends Error {}

const ACTIONABLE =
  'a:visible, button:visible, input:visible:not([type=hidden]), select:visible, textarea:visible, [onclick]:visible';

/** The visible controls by role, read with Playwright's own selectors: no script of ours runs in the page. */
const FIELD =
  ':not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=password]):not([type=checkbox]):not([type=radio])';
const ROLES: [string, string][] = [
  ['link', 'a:visible'],
  [
    'button',
    'button:visible, input[type=submit]:visible, input[type=button]:visible, input[type=image]:visible, input[type=reset]:visible',
  ],
  ['textbox', `textarea:visible, input:visible${FIELD}`],
  ['password', 'input[type=password]:visible'],
  ['select', 'select:visible'],
  ['checkbox', 'input[type=checkbox]:visible'],
  ['radio', 'input[type=radio]:visible'],
  ['clickable', '[onclick]:visible:not(a):not(button):not(input)'],
];

/** The page's visible words, in short: what a page that never became ready was showing. */
async function shown(page: Page): Promise<string> {
  const words: string[] = [];
  for (const f of page.frames())
    if (await f.locator('body').count())
      words.push(
        await f
          .locator('body')
          .innerText()
          .catch(() => ''),
      );
  return words.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function hasText(page: Page): Promise<boolean> {
  for (const f of page.frames())
    if ((await f.locator('body').count()) && (await f.locator('body').innerText()).trim())
      return true;
  return false;
}

async function actionable(page: Page): Promise<number> {
  let n = 0;
  for (const f of page.frames())
    n += await f
      .locator(ACTIONABLE)
      .count()
      .catch(() => 0);
  return n;
}

async function loading(page: Page): Promise<boolean> {
  for (const f of page.frames())
    if (
      await f
        .getByText(/\b(loading|please wait|processing)\b/i)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return true;
  return false;
}

/** Where two pictures differ, outside the regions already known to move; null if nowhere. */
function changed(a: PNG, b: PNG, skip: Box[]): Box | null {
  if (a.width !== b.width || a.height !== b.height) return { x: 0, y: 0, w: b.width, h: b.height };
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -1,
    y2 = -1;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (
        a.data[i] === b.data[i] &&
        a.data[i + 1] === b.data[i + 1] &&
        a.data[i + 2] === b.data[i + 2]
      )
        continue;
      if (skip.some((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h)) continue;
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
  return x2 < 0 ? null : { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}
const small = (b: Box) => b.w * b.h <= 12_000;
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grow = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x) - 2,
    y = Math.min(a.y, b.y) - 2;
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) + 2 - x,
    h: Math.max(a.y + a.h, b.y + b.h) + 2 - y,
  };
};

/** Waits until the page is ready, then keeps it: the masked picture, page and address. */
export async function see(
  page: Page,
  o: { known?: string[]; limitMs?: number; everyMs?: number } = {},
): Promise<Frame> {
  const known = o.known ?? [];
  const until = Date.now() + (o.limitMs ?? 60_000);
  // How long between two looks: still twice running means ready.
  const every = o.everyMs ?? 350;
  let before: PNG | null = null;
  let lastChange: Box | null = null;
  const animated: Box[] = [];
  let still = 0;
  for (;;) {
    const marquees = page.frames().map((f) => f.locator('marquee'));
    // A navigation can begin while we look: then the page is not still, and we look again.
    const raw = await page.screenshot({ mask: marquees }).catch(() => null);
    if (!raw) {
      before = null;
      lastChange = null;
      still = 0;
      await page.waitForTimeout(every);
      continue;
    }
    const shot = PNG.sync.read(raw);
    const change = before && changed(before, shot, animated);
    // A small region that changes again in the same place is animated (a flashing badge): it is
    // left out from then on. Anything else that changes means the page is still being drawn.
    if (change && lastChange && small(change) && small(lastChange) && overlaps(change, lastChange))
      animated.push(grow(change, lastChange));
    else if (!change && before && !(await loading(page))) {
      // Ready: something to act on, or, for a page with nothing to act on (an error page), words
      // that have held still for three looks. A blank page that holds still is not ready.
      still++;
      if ((await actionable(page)) > 0 || (still >= 3 && (await hasText(page)))) break;
    } else still = 0;
    if (Date.now() > until)
      throw new NotReady(
        `not ready after ${o.limitMs ?? 60_000} ms at ${maskAddress(page.url(), known)}, showing: ${maskText(await shown(page), known)}`,
      );
    lastChange = change || null;
    before = shot;
    await page.waitForTimeout(every);
  }
  const picture = paint(await page.screenshot(), await maskBoxes(page, known));
  const parts: string[] = [];
  const controls: Control[] = [];
  for (const f of page.frames()) {
    // A frameset's own document has no body: its frames are read in their turn.
    const body = f.locator('body');
    const tree = (await body.count())
      ? await body.ariaSnapshot({ timeout: 5_000 }).catch(() => '')
      : '';
    parts.push(
      f === page.mainFrame() ? tree : `## frame ${f.name() || maskAddress(f.url())}\n${tree}`,
    );
    for (const [role, css] of ROLES) {
      const els = f.locator(css);
      for (let i = 0; i < Math.min(await els.count(), 60); i++) {
        const el = els.nth(i);
        const box = await el.boundingBox().catch(() => null);
        if (!box) continue;
        const own =
          (await el.getAttribute('aria-label')) ??
          (await el.getAttribute('alt')) ??
          (role === 'button' ? await el.getAttribute('value') : null);
        const text =
          own ??
          (['textbox', 'password', 'select'].includes(role)
            ? ''
            : await el.innerText().catch(() => ''));
        controls.push({
          role,
          name: maskText(text.trim().slice(0, 80), known),
          box: { x: box.x, y: box.y, w: box.width, h: box.height },
        });
      }
    }
  }
  return {
    at: new Date().toISOString(),
    address: maskAddress(page.url(), known),
    picture,
    tree: maskText(parts.join('\n\n'), known),
    controls,
    dialogs: dialogsSince(page).map((d) => maskText(d, known)),
    animated,
  };
}

/** A page the crawler expects, known by the words visible on it. */
export interface Expected {
  name: string;
  shows: string[];
  never?: string[];
}

export class UnknownPage extends Error {
  constructor(
    readonly frame: Frame,
    readonly closest: string[],
  ) {
    super(`an unknown page${closest.length ? `; closest: ${closest.join(', ')}` : ''}`);
  }
}

/** Which expected page this is: exactly one must match, by its visible words, or it's unknown. */
export function knows(frame: Frame, pages: Expected[]): string {
  const text = frame.tree.toLowerCase();
  const has = (w: string) => text.includes(w.toLowerCase());
  const hits = pages.filter((p) => p.shows.every(has) && !(p.never ?? []).some(has));
  if (hits.length === 1) return hits[0]!.name;
  const closest = [...pages]
    .map((p) => ({ name: p.name, share: p.shows.filter(has).length / p.shows.length }))
    .filter((p) => p.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, 3)
    .map((p) => p.name);
  throw new UnknownPage(frame, hits.length > 1 ? hits.map((h) => h.name) : closest);
}

/**
 * The page's visible words, unmasked, for the crawler to read a value from (a balance, a
 * confirmation number). Never kept: evidence comes only from `see`.
 */
export async function read(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const f of page.frames())
    if (await f.locator('body').count())
      parts.push(
        await f
          .locator('body')
          .ariaSnapshot({ timeout: 5_000 })
          .catch(() => ''),
      );
  return parts.join('\n');
}
