// Finding a picture in a screenshot by sight: an anchor (a label, drawn as text or as an image) is
// kept as a small crop of the screen, and found again by sliding it across a new screenshot and
// scoring each place by normalized cross-correlation. No HTML, no selector, no model: the same
// screen gives the same answer. A match that is weak, or not clearly better than the next best
// place, is no match: the caller stops rather than guesses.
import { PNG } from 'pngjs';
import type { Box } from './mask.js';

interface Gray {
  w: number;
  h: number;
  d: Float32Array;
}

/** A PNG in gray, transparent pixels on white, as the page shows them. */
function gray(png: Buffer): Gray {
  const img = PNG.sync.read(png);
  const d = new Float32Array(img.width * img.height);
  for (let i = 0; i < d.length; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    const g =
      img.data[i * 4]! * 0.299 + img.data[i * 4 + 1]! * 0.587 + img.data[i * 4 + 2]! * 0.114;
    d[i] = g * a + 255 * (1 - a);
  }
  return { w: img.width, h: img.height, d };
}

/** Each f by f block averaged into one pixel. */
function shrink(g: Gray, f: number): Gray {
  if (f === 1) return g;
  const w = Math.floor(g.w / f);
  const h = Math.floor(g.h / f);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++)
        for (let xx = 0; xx < f; xx++) s += g.d[(y * f + yy) * g.w + x * f + xx]!;
      d[y * w + x] = s / (f * f);
    }
  return { w, h, d };
}

/** The template's pixels minus their mean, and their spread; null when it is flat (no texture). */
function prepare(t: Gray): { z: Float32Array; norm: number } | null {
  let mean = 0;
  for (const v of t.d) mean += v;
  mean /= t.d.length;
  const z = new Float32Array(t.d.length);
  let sq = 0;
  for (let i = 0; i < z.length; i++) {
    z[i] = t.d[i]! - mean;
    sq += z[i]! * z[i]!;
  }
  return sq / t.d.length < 4 ? null : { z, norm: Math.sqrt(sq) };
}

/** The normalized cross-correlation of the template at (x, y) of the screen: 1 is identical. */
function scoreAt(s: Gray, t: Gray, p: { z: Float32Array; norm: number }, x: number, y: number) {
  let sum = 0;
  let sumSq = 0;
  let dot = 0;
  for (let ty = 0; ty < t.h; ty++) {
    const row = (y + ty) * s.w + x;
    for (let tx = 0; tx < t.w; tx++) {
      const v = s.d[row + tx]!;
      sum += v;
      sumSq += v * v;
      dot += v * p.z[ty * t.w + tx]!;
    }
  }
  const n = t.w * t.h;
  const spread = sumSq - (sum * sum) / n;
  return spread <= 1e-6 ? 0 : dot / (Math.sqrt(spread) * p.norm);
}

/** How sure a match must be, and how clearly ahead of the next best place. */
export const MATCH = { min: 0.9, lead: 0.05 };

export interface Found {
  /** Where the crop is on the screen, in page pixels. */
  box: Box;
  score: number;
  /** The score of the next best place that does not overlap it. */
  next: number;
}

/**
 * Where this crop is in this screenshot, if it is there clearly: scored at or above MATCH.min, and
 * ahead of every other place by MATCH.lead. Null otherwise, never a guess.
 */
export function findCrop(screen: Buffer, crop: Buffer): Found | null {
  const S = gray(screen);
  const T = gray(crop);
  if (T.w > S.w || T.h > S.h) return null;
  // Candidates on a smaller picture first, then each checked at full size around where it was.
  const f = Math.max(1, Math.min(4, Math.floor(Math.min(T.w, T.h) / 6)));
  const s = shrink(S, f);
  const t = shrink(T, f);
  const pt = prepare(t);
  const pT = prepare(T);
  if (!pt || !pT) return null;
  const coarse: { x: number; y: number; v: number }[] = [];
  for (let y = 0; y + t.h <= s.h; y++)
    for (let x = 0; x + t.w <= s.w; x++) {
      const v = scoreAt(s, t, pt, x, y);
      if (v > 0.5) coarse.push({ x, y, v });
    }
  coarse.sort((a, b) => b.v - a.v);
  const fine: { x: number; y: number; v: number }[] = [];
  for (const c of coarse.slice(0, 12)) {
    let best = { x: 0, y: 0, v: -1 };
    for (let y = Math.max(0, c.y * f - f); y <= Math.min(S.h - T.h, c.y * f + f); y++)
      for (let x = Math.max(0, c.x * f - f); x <= Math.min(S.w - T.w, c.x * f + f); x++) {
        const v = scoreAt(S, T, pT, x, y);
        if (v > best.v) best = { x, y, v };
      }
    fine.push(best);
  }
  fine.sort((a, b) => b.v - a.v);
  const top = fine[0];
  if (!top || top.v < MATCH.min) return null;
  // The next best place that is somewhere else: not overlapping the best by more than half.
  const apart = (a: { x: number; y: number }) =>
    Math.abs(a.x - top.x) > T.w / 2 || Math.abs(a.y - top.y) > T.h / 2;
  const next = fine.find(apart)?.v ?? 0;
  if (top.v - next < MATCH.lead) return null;
  return { box: { x: top.x, y: top.y, w: T.w, h: T.h }, score: top.v, next };
}

/** A region of a PNG, as a PNG: an anchor kept for the table, or a close-up for the Supervisor. */
export function cropOf(png: Buffer, box: Box): Buffer {
  const img = PNG.sync.read(png);
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const w = Math.max(1, Math.min(img.width - x0, Math.round(box.w)));
  const h = Math.max(1, Math.min(img.height - y0, Math.round(box.h)));
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(img, out, x0, y0, w, h, 0, 0);
  return PNG.sync.write(out);
}
