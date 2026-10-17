// Acting on what is drawn. A field is found by its label's drawn text, then the box beside it, as
// an operator's eye finds it (legacy labels sit in a cell of their own, with no link to the box).
// A button is found by its drawn name, whatever the page built it from: a button, a link, or styled
// text. Exactly one target, or an error that says what was found: never a guess. Clicks are
// Playwright's, with the real mouse, and only once the target is visible, stable and on top.
import type { Frame, Locator, Page } from 'playwright-core';
import type { Box } from './mask.js';

export class TargetError extends Error {}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FIELDS =
  'textarea:visible, select:visible, input:visible:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=checkbox]):not([type=radio])';

const boxOf = async (l: Locator): Promise<Box | null> => {
  const b = await l.boundingBox().catch(() => null);
  return b && { x: b.x, y: b.y, w: b.width, h: b.height };
};

async function visible(l: Locator): Promise<Locator[]> {
  const out: Locator[] = [];
  for (let i = 0; i < (await l.count()); i++) if (await l.nth(i).isVisible()) out.push(l.nth(i));
  return out;
}

/** The field a label names: the nearest box to the label's right on its line, else just below it. */
export async function field(page: Page, label: string): Promise<{ target: Locator; box: Box }> {
  const found: { target: Locator; box: Box; d: number }[] = [];
  for (const f of page.frames()) {
    for (const l of await visible(f.getByText(new RegExp(`^\\s*${escape(label)}\\s*:?\\s*$`)))) {
      const lb = await boxOf(l);
      if (!lb) continue;
      for (const c of await visible(f.locator(FIELDS))) {
        const b = await boxOf(c);
        if (!b) continue;
        const mid = b.y + b.h / 2;
        const right = b.x >= lb.x + lb.w - 2 && mid >= lb.y - 4 && mid <= lb.y + lb.h + 4;
        const below =
          b.y >= lb.y + lb.h - 2 && b.y - (lb.y + lb.h) < 40 && Math.abs(b.x - lb.x) < 40;
        if (right || below)
          found.push({ target: c, box: b, d: Math.hypot(b.x - (lb.x + lb.w), b.y - lb.y) });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  if (!found.length) throw new TargetError(`no field beside the label "${label}"`);
  if (found.length > 1 && found[1]!.d - found[0]!.d < 4)
    throw new TargetError(`two fields beside the label "${label}", about as near`);
  return { target: found[0]!.target, box: found[0]!.box };
}

/** The one visible control with this drawn name, in any frame. */
export async function control(
  page: Page,
  name: string,
  near?: string,
): Promise<{ target: Locator; box: Box; frame: Frame }> {
  const exact = new RegExp(`^\\s*${escape(name)}\\s*$`);
  const hits: { target: Locator; frame: Frame }[] = [];
  for (const f of page.frames())
    for (const role of ['button', 'link'] as const)
      for (const l of await visible(f.getByRole(role, { name: exact })))
        hits.push({ target: l, frame: f });
  // Drawn like a button, but not one in the page's structure: its visible text, exactly.
  if (!hits.length)
    for (const f of page.frames())
      for (const l of await visible(f.getByText(exact))) hits.push({ target: l, frame: f });
  // Two of the same name (one in the nav, one in the page): the one nearest the anchor a person
  // would go by, such as the heading of the section it sits in.
  if (hits.length > 1 && near) {
    // The anchor exactly as drawn, else the one text that holds it ("ending in 1234").
    const anchors: Box[] = [];
    for (const exact of [true, false]) {
      for (const f of page.frames())
        for (const l of await visible(f.getByText(near, { exact }))) {
          const b = await boxOf(l);
          if (b) anchors.push(b);
        }
      if (anchors.length) break;
    }
    if (anchors.length === 1) {
      const a = anchors[0]!;
      const by = await Promise.all(hits.map(async (h) => ({ h, b: await boxOf(h.target) })));
      const d = (b: Box | null) => (b ? Math.hypot(b.x - a.x, b.y - a.y) : Infinity);
      by.sort((x, y) => d(x.b) - d(y.b));
      if (d(by[1]!.b) - d(by[0]!.b) > 20) hits.splice(0, hits.length, by[0]!.h);
    }
  }
  if (hits.length !== 1) throw new TargetError(`press "${name}": ${hits.length} visible`);
  const box = await boxOf(hits[0]!.target);
  if (!box) throw new TargetError(`press "${name}": it has no box`);
  return { ...hits[0]!, box };
}

/** Presses a control by its drawn name. Refused if anything covers it. */
export async function press(
  page: Page,
  name: string,
  o: { near?: string; timeoutMs?: number } = {},
): Promise<Box> {
  const c = await control(page, name, o.near);
  await c.target.click({ timeout: o.timeoutMs ?? 10_000 });
  return c.box;
}

/** Types into the field a label names, key by key, replacing what it holds. */
export async function type(page: Page, label: string, text: string): Promise<Box> {
  const f = await field(page, label);
  await f.target.click();
  await f.target.fill('');
  await page.keyboard.type(text, { delay: 20 });
  return f.box;
}

/** Chooses, in the list a label names, the one option whose visible text contains these words. */
export async function choose(page: Page, label: string, containing: string): Promise<Box> {
  const f = await field(page, label);
  const options = await f.target.locator('option').allInnerTexts();
  const hits = options.filter((o) => o.includes(containing));
  if (hits.length !== 1)
    throw new TargetError(`choose "${containing}" in "${label}": ${hits.length} options match`);
  await f.target.selectOption({ label: hits[0]! });
  return f.box;
}
