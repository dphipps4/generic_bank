// Acting like a person (plan, §E.4): the real mouse and keyboard, at a control's center in page
// coordinates. Right before a click the screen is read again and the same control must still be
// there; if it moved (tiles that re-render), it is found again, up to twice. Typing is key by key,
// and every key comes from a fixed set.
import type { Page } from './browser.js';
import { type Control, readScreen, type ScreenModel } from './model.js';
import { normalize } from './recognize.js';
import { waitFullyRendered } from './render.js';

export class ActError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActError';
  }
}

/** Every key the crawler may press. Anything else is refused before a key goes down. */
const KEYS = /^[A-Za-z0-9 .,$@\-_/#']$/;
const SPECIAL = {
  Tab: 9,
  Enter: 13,
  Backspace: 8,
  End: 35,
  Home: 36,
  ArrowDown: 40,
  ArrowUp: 38,
  Escape: 27,
} as const;
export type SpecialKey = keyof typeof SPECIAL;

const center = (c: Control) => ({
  x: Math.round(c.box.x + c.box.w / 2),
  y: Math.round(c.box.y + c.box.h / 2),
});

/**
 * The same control on a fresh reading: the very same element if it is still drawn and on top
 * (its name may come from a fingerprint the fresh reading has not applied), otherwise the nearest
 * one with the same role and name.
 */
function findAgain(m: ScreenModel, c: Control): Control | null {
  const same = m.controls.find(
    (x) => x.backendNodeId === c.backendNodeId && x.session === c.session && x.role === c.role,
  );
  if (same) return { ...same, name: c.name };
  const alike = m.controls.filter(
    (x) => x.role === c.role && normalize(x.name) === normalize(c.name) && x.frame === c.frame,
  );
  if (!alike.length) return null;
  alike.sort(
    (a, b) =>
      Math.hypot(a.box.x - c.box.x, a.box.y - c.box.y) -
      Math.hypot(b.box.x - c.box.x, b.box.y - c.box.y),
  );
  return alike[0]!;
}

async function mouse(
  page: Page,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
) {
  await page.call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: 1,
  });
}

/** Clicks a control, re-reading the screen first. Returns the control actually clicked. */
export async function click(
  page: Page,
  target: Control,
  o: { retargets?: number } = {},
): Promise<Control> {
  let c = target;
  for (let attempt = 0; attempt <= (o.retargets ?? 2); attempt++) {
    let again = findAgain(await readScreen(page), c);
    // The page may be redrawing (a frame still loading): wait for it to settle, then look once more.
    if (!again) again = findAgain((await waitFullyRendered(page, { limitMs: 30_000 })).model, c);
    if (!again) throw new ActError(`the ${c.role} "${c.name}" is no longer on the screen`);
    if (!again.enabled) throw new ActError(`the ${c.role} "${c.name}" is disabled`);
    const moved = Math.abs(again.box.x - c.box.x) > 2 || Math.abs(again.box.y - c.box.y) > 2;
    c = again;
    if (moved && attempt < (o.retargets ?? 2)) continue; // it moved: read once more before trusting it
    const { x, y } = center(c);
    await mouse(page, 'mouseMoved', x, y);
    await mouse(page, 'mousePressed', x, y);
    await mouse(page, 'mouseReleased', x, y);
    await page.settle();
    return c;
  }
  throw new ActError(`the ${target.role} "${target.name}" kept moving`);
}

export async function press(page: Page, key: SpecialKey) {
  const code = SPECIAL[key];
  await page.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code: key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
  });
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
  });
}

/** Types into a field, key by key, after clicking it. A field that already holds a value is cleared. */
export async function type(page: Page, field: Control, text: string) {
  for (const ch of text)
    if (!KEYS.test(ch)) throw new ActError('a character outside the allowed keys');
  await click(page, field);
  if (field.hasValue) {
    await press(page, 'End');
    for (let i = 0; i < 64; i++) await press(page, 'Backspace');
  }
  await keys(page, text);
}

/** Presses each character's key in turn: key down with its text, then key up. */
async function keys(page: Page, text: string) {
  for (const ch of text) {
    const upper = ch.toUpperCase();
    const vk = /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0;
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ch,
      text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ch,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  }
}

/**
 * Chooses an option in a list by its text, with the keyboard, as a person can: focus the list,
 * close its popup, type the start of the option, and move on. The choice is read back, never
 * assumed.
 */
export async function choose(page: Page, list: Control, option: string | ((o: string) => boolean)) {
  const match =
    typeof option === 'string' ? (o: string) => normalize(o) === normalize(option) : option;
  const options = list.options ?? [];
  const hits = options.filter((o) => match(o));
  if (hits.length !== 1)
    throw new ActError(hits.length ? 'more than one option matches' : 'no option matches');
  const wanted = hits[0]!;
  // Type as much of the option as tells it apart from the others, from the allowed keys only.
  const typed = [...wanted].filter((ch) => KEYS.test(ch)).join('');
  let prefix = '';
  for (const ch of typed) {
    prefix += ch;
    if (options.filter((o) => normalize(o).startsWith(normalize(prefix))).length === 1) break;
  }
  await click(page, list);
  await press(page, 'Escape');
  await keys(page, prefix);
  await press(page, 'Tab');
  await page.settle();
  const after = (await readScreen(page)).controls.find(
    (c) => c.backendNodeId === list.backendNodeId,
  );
  if (after?.selected !== wanted)
    throw new ActError(
      `the list did not take the choice (it shows "${after?.selected ?? 'nothing'}")`,
    );
}
