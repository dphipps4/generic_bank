// Pictures of text: a label or a button drawn as an image, with no name a browser can read. Each is
// named once from its picture, and known again by its fingerprint: a difference hash of the image
// shrunk to 33 by 8 in gray, on white, which survives small changes in scale and color. Labels are
// wide and short, and often transparent: a 9 by 8 hash saw mostly empty space, and told "USERNAME:"
// from "PASSCODE:" by 5 bits of 64; this one, by 36 of 256.
import type { Locator, Page } from 'playwright-core';
import { PNG } from 'pngjs';

const W = 33;
const H = 8;

/** The fingerprint of a PNG: 256 bits, as 64 hex digits. */
export function fingerprint(png: Buffer): string {
  const img = PNG.sync.read(png);
  // Each cell of the grid is the mean of the pixels it covers (a box filter, so nothing aliases).
  // A transparent pixel is the page behind it: white.
  const cell = (cx: number, cy: number) => {
    const x0 = Math.floor((cx * img.width) / W);
    const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * img.width) / W));
    const y0 = Math.floor((cy * img.height) / H);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * img.height) / H));
    let sum = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        const a = img.data[i + 3]! / 255;
        const g = img.data[i]! * 0.299 + img.data[i + 1]! * 0.587 + img.data[i + 2]! * 0.114;
        sum += g * a + 255 * (1 - a);
      }
    return sum / ((x1 - x0) * (y1 - y0));
  };
  let bits = '';
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W - 1; x++) bits += cell(x, y) > cell(x + 1, y) ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(64, '0');
}

/** How many of the bits differ. */
export function distance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Bits of 256 within which two fingerprints can be the same picture. */
export const NEAR = 16;

export interface KnownPicture {
  name: string;
  print: string;
  /** Width over height, as drawn: a label's shape, checked before any bits are. */
  ratio?: number;
}

/** A picture on the page: its fingerprint, and its shape. */
export interface Seen {
  print: string;
  ratio: number;
}

/**
 * Which of these pictures is the known one, if one clearly is. A candidate of another shape (width
 * over height off by more than 15%) is not it. The nearest must be within NEAR, and nearer than
 * half the next nearest (the ratio test of feature matching): two labels nearly alike are
 * ambiguous, and an ambiguous match is no match.
 */
export function matchPicture(seen: readonly Seen[], known: KnownPicture): number | null {
  const ranked = seen
    .map((p, i) => ({ i, d: distance(p.print, known.print), r: p.ratio }))
    .filter((c) => !known.ratio || Math.abs(c.r / known.ratio - 1) <= 0.15)
    .sort((a, b) => a.d - b.d);
  const [first, second] = ranked;
  if (!first || first.d > NEAR) return null;
  if (second && first.d >= second.d / 2) return null;
  return first.i;
}

/**
 * The picture drawn as a field's label: the nearest visible image just left of the field on its
 * line, else just above it. Null when there is none, or when it is too small to be words.
 */
export async function labelPicture(
  page: Page,
  box: { x: number; y: number; w: number; h: number },
): Promise<(Seen & { png: Buffer }) | null> {
  let best: { img: Locator; d: number; ratio: number } | null = null;
  for (const f of page.frames()) {
    const imgs = f.locator('img');
    for (let i = 0; i < (await imgs.count()); i++) {
      const img = imgs.nth(i);
      if (!(await img.isVisible())) continue;
      const b = await img.boundingBox().catch(() => null);
      if (!b || b.width < 12 || b.height < 6) continue;
      if (!labels(b, box)) continue;
      const d = Math.hypot(box.x - (b.x + b.width), box.y - b.y);
      if (!best || d < best.d) best = { img, d, ratio: b.width / b.height };
    }
  }
  const png = best && (await best.img.screenshot().catch(() => null));
  return best && png ? { png, print: fingerprint(png), ratio: best.ratio } : null;
}

/** Whether a picture at `b` is drawn as the label of a field at `box`: left on its line, or above. */
export function labels(
  b: { x: number; y: number; width: number; height: number },
  box: { x: number; y: number; w: number; h: number },
): boolean {
  const mid = b.y + b.height / 2;
  const left = b.x + b.width <= box.x + 2 && mid >= box.y - 4 && mid <= box.y + box.h + 4;
  const above =
    b.y + b.height <= box.y + 2 && box.y - (b.y + b.height) < 40 && Math.abs(b.x - box.x) < 40;
  return left || above;
}
