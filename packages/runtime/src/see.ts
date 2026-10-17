// Seeing a page, first, before anything is clicked. A page is ready when its picture holds still
// (moving parts such as a marquee aside), nothing says it is loading, and there is something to
// act on: a blank page that holds still, such as a sign-in hand-off, is not ready. Then the
// evidence is kept: the masked picture, the rendered page (what is visible, by role and name) and
// the masked address.
import type { Page } from 'playwright-core';
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
        .getByText(/^\s*(loading|please wait)/i)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return true;
  return false;
}

/** Waits until the page is ready, then keeps it: the masked picture, page and address. */
export async function see(
  page: Page,
  o: { known?: string[]; limitMs?: number } = {},
): Promise<Frame> {
  const known = o.known ?? [];
  const until = Date.now() + (o.limitMs ?? 60_000);
  let before: Buffer = Buffer.alloc(0);
  for (;;) {
    const moving = page.frames().map((f) => f.locator('marquee'));
    const shot = await page.screenshot({ mask: moving });
    if (before.equals(shot) && !(await loading(page)) && (await actionable(page)) > 0) break;
    if (Date.now() > until)
      throw new NotReady(`not ready after ${o.limitMs ?? 60_000} ms at ${maskAddress(page.url())}`);
    before = shot;
    await page.waitForTimeout(700);
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
