// Pictures of text: a label or a button drawn as an image, with no name a browser can read. Each is
// named once from its picture, and known again by its fingerprint: a difference hash of the image
// shrunk to 9 by 8 in gray, which survives small changes in scale and colour.
import type { Locator, Page } from 'playwright-core';
import { PNG } from 'pngjs';

/** The fingerprint of a PNG: 64 bits, as 16 hex digits. */
export function fingerprint(png: Buffer): string {
  const img = PNG.sync.read(png);
  const gray = (x: number, y: number) => {
    const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / 9));
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / 8));
    const i = (sy * img.width + sx) * 4;
    return img.data[i]! * 0.299 + img.data[i + 1]! * 0.587 + img.data[i + 2]! * 0.114;
  };
  let bits = '';
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bits += gray(x, y) > gray(x + 1, y) ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

/** How many of the 64 bits differ. */
export function distance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export const NEAR = 6;

export interface KnownPicture {
  name: string;
  print: string;
}

/** The visible image on the page whose fingerprint is this known picture's, if exactly one is. */
export async function pictureNamed(page: Page, known: KnownPicture): Promise<Locator | null> {
  const hits: Locator[] = [];
  for (const f of page.frames()) {
    // Every <img>: a label drawn as a picture often has an empty alt, which hides it from roles.
    const imgs = f.locator('img');
    for (let i = 0; i < (await imgs.count()); i++) {
      const img = imgs.nth(i);
      if (!(await img.isVisible())) continue;
      const shot = await img.screenshot().catch(() => null);
      if (shot && distance(fingerprint(shot), known.print) <= NEAR) hits.push(img);
    }
  }
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The picture drawn as a field's label: the nearest visible image just left of the field on its
 * line, else just above it. Null when there is none, or when it is too small to be words.
 */
export async function labelPicture(
  page: Page,
  box: { x: number; y: number; w: number; h: number },
): Promise<Buffer | null> {
  let best: { img: Locator; d: number } | null = null;
  for (const f of page.frames()) {
    const imgs = f.locator('img');
    for (let i = 0; i < (await imgs.count()); i++) {
      const img = imgs.nth(i);
      if (!(await img.isVisible())) continue;
      const b = await img.boundingBox().catch(() => null);
      if (!b || b.width < 12 || b.height < 6) continue;
      const mid = b.y + b.height / 2;
      const left = b.x + b.width <= box.x + 2 && mid >= box.y - 4 && mid <= box.y + box.h + 4;
      const above =
        b.y + b.height <= box.y + 2 && box.y - (b.y + b.height) < 40 && Math.abs(b.x - box.x) < 40;
      if (!left && !above) continue;
      const d = Math.hypot(box.x - (b.x + b.width), box.y - b.y);
      if (!best || d < best.d) best = { img, d };
    }
  }
  return best ? await best.img.screenshot().catch(() => null) : null;
}
