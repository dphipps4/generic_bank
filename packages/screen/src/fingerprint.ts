// Pictures of text (plan, §E.1 step 4). Some labels and buttons are images with no alt text. The
// crawler does not read pixels: when the factory explores a bank, its vision model names each such
// image once, and the bank's profile keeps the image's fingerprint with that name. At runtime the
// crawler matches pictures on screen against those fingerprints, so a picture gets a name like any
// other control. A picture with no match has no name, and is never clicked.
//
// The fingerprint is a difference hash shaped for text: the picture is reduced to 33 x 8 gray
// cells and each bit says whether a cell is brighter than its right-hand neighbour: 256 bits,
// stable across loads and small rendering differences, different for different words.
import type { Box, Control, ScreenModel } from './model.js';
import { decodePng, type Image } from './png.js';

const W = 33;
const H = 8;
export const MAX_DISTANCE = 24; // of 256 bits: about 9%

export interface KnownPicture {
  hash: string;
  name: string;
  /** Width over height, so a wide label never matches a square button. */
  aspect: number;
}

function gray(img: Image, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
}

/** The fingerprint of one region of a screenshot, as hex. */
export function fingerprint(img: Image, box: Box): string {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h));
  const cells: number[] = [];
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const ax = x0 + Math.floor(((x1 - x0) * cx) / W);
      const bx = Math.max(ax + 1, x0 + Math.floor(((x1 - x0) * (cx + 1)) / W));
      const ay = y0 + Math.floor(((y1 - y0) * cy) / H);
      const by = Math.max(ay + 1, y0 + Math.floor(((y1 - y0) * (cy + 1)) / H));
      let sum = 0;
      let n = 0;
      for (let y = ay; y < by && y < y1; y++) {
        for (let x = ax; x < bx && x < x1; x++) {
          sum += gray(img, x, y);
          n++;
        }
      }
      cells.push(n ? sum / n : 0);
    }
  }
  let bits = '';
  for (let cy = 0; cy < H; cy++)
    for (let cx = 0; cx < W - 1; cx++)
      bits += cells[cy * W + cx]! > cells[cy * W + cx + 1]! ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function distance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

const isPicture = (c: Control) => (c.role === 'image' || c.role === 'image-button') && !c.name;

/** For the factory: the fingerprint of every unnamed picture on screen, to be named once. */
export function picturesToName(
  m: ScreenModel,
): { ref: string; box: Box; hash: string; aspect: number }[] {
  const img = decodePng(m.screenshot);
  return m.controls.filter(isPicture).map((c) => ({
    ref: c.ref,
    box: c.box,
    hash: fingerprint(img, c.box),
    aspect: c.box.w / c.box.h,
  }));
}

/**
 * Names the pictures on screen from what the profile has learned. A picture gets a name only when
 * exactly one known picture is close enough and the same shape; otherwise it stays unnamed.
 */
export function namePictures(m: ScreenModel, known: KnownPicture[]): ScreenModel {
  if (!known.length || !m.controls.some(isPicture)) return m;
  const img = decodePng(m.screenshot);
  const controls = m.controls.map((c) => {
    if (!isPicture(c)) return c;
    const hash = fingerprint(img, c.box);
    const aspect = c.box.w / c.box.h;
    const close = known.filter(
      (k) => distance(k.hash, hash) <= MAX_DISTANCE && Math.abs(Math.log(k.aspect / aspect)) < 0.25,
    );
    const names = new Set(close.map((k) => k.name));
    return names.size === 1 ? { ...c, name: [...names][0]!, namedBy: 'fingerprint' as const } : c;
  });
  return { ...m, controls };
}
