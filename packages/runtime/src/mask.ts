// Masking, before anything is kept: the rule is in rule.ts, and every view follows it. Playwright can
// only cover whole elements, and a balance is often loose text in a cell, so the runs of drawn text
// are read from the browser's own layout over DevTools (from outside the page), and exactly the
// hidden characters are painted over.
import { maskText, spans } from './rule.js';
import type { CDPSession, Page } from 'playwright-core';
import { PNG } from 'pngjs';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where one hidden character ends and the next begins, so the picture shows each one as a block. */
  cuts?: number[];
}

/** A hidden character as the picture shows it: a dark block, the "█" of the text. */
export const BLOCK = 40;
/** The seam between two blocks, lighter, so each hidden character shows as its own block. */
export const SEAM = 120;

export { HIDDEN, maskText, spans } from './rule.js';

/** An address with no query or fragment, and its path masked: tokens never leave the browser. */
export function maskAddress(url: string, known: string[] = []): string {
  try {
    const u = new URL(url);
    return `${u.origin}${maskText(u.pathname, known)}`;
  } catch {
    return maskText(url.split(/[?#]/)[0]!, known);
  }
}

type Snapshot = {
  strings: string[];
  documents: {
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    nodes: {
      parentIndex?: number[];
      nodeName?: number[];
      nodeValue?: number[];
      inputValue?: { index: number[]; value: number[] };
      optionSelected?: { index: number[] };
      contentDocumentIndex?: { index: number[]; value: number[] };
    };
    layout: { nodeIndex: number[]; bounds: number[][]; text: number[]; styles: number[][] };
    textBoxes: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] };
  }[];
};

/** The boxes to paint, in screenshot coordinates, from one DevTools session's documents. */
async function boxesFrom(cdp: CDPSession, known: string[], dx: number, dy: number): Promise<Box[]> {
  const snap = (await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: ['font-size'],
  })) as unknown as Snapshot;
  const str = (i: number) => (i >= 0 ? (snap.strings[i] ?? '') : '');
  const offsets = new Map<number, { x: number; y: number }>([[0, { x: dx, y: dy }]]);
  const out: Box[] = [];
  snap.documents.forEach((d, di) => {
    const off = offsets.get(di) ?? { x: dx, y: dy };
    const x0 = off.x - (d.scrollOffsetX ?? 0);
    const y0 = off.y - (d.scrollOffsetY ?? 0);
    const layoutOf = new Map(d.layout.nodeIndex.map((n, li) => [n, li]));
    // Frames inside this document start where their owner element is drawn.
    const owners = d.nodes.contentDocumentIndex;
    owners?.index.forEach((node, k) => {
      const b = d.layout.bounds[layoutOf.get(node) ?? -1];
      if (b) offsets.set(owners.value[k]!, { x: x0 + b[0]!, y: y0 + b[1]! });
    });
    const size = (li: number | undefined) =>
      parseFloat(str(li === undefined ? -1 : (d.layout.styles[li]?.[0] ?? -1))) || 13;
    // A field's value is drawn by the field, from just inside its left edge, in its own font size.
    // Only its hidden characters are painted, so a typed "████5678" shows that it was typed.
    const inputs = d.nodes.inputValue;
    inputs?.index.forEach((node, k) => {
      const li = layoutOf.get(node);
      const b = d.layout.bounds[li ?? -1];
      const value = str(inputs.value[k]!);
      if (b && value)
        out.push(...drawnInside(value, known, x0 + b[0]!, y0 + b[1]!, b[2]!, b[3]!, size(li)));
    });
    // Text: the hidden characters of each drawn run, placed by their share of the run's width.
    d.textBoxes.layoutIndex.forEach((li, k) => {
      const text = str(d.layout.text[li] ?? -1).slice(
        d.textBoxes.start[k],
        d.textBoxes.start[k]! + d.textBoxes.length[k]!,
      );
      const b = d.textBoxes.bounds[k]!;
      out.push(...hiddenBoxes(text, known, x0 + b[0]!, y0 + b[1]!, b[2]!, b[3]!));
    });
    // A list draws its chosen option itself, outside the text layout above.
    const n = d.nodes;
    const name = (i: number) => str(n.nodeName?.[i] ?? -1);
    const selected = new Set(n.optionSelected?.index ?? []);
    const textOf = (i: number) =>
      (n.parentIndex ?? [])
        .map((p, c) => (p === i && name(c) === '#text' ? str(n.nodeValue?.[c] ?? -1) : ''))
        .join('');
    (n.nodeName ?? []).forEach((_, i) => {
      if (name(i) !== 'SELECT') return;
      const li = layoutOf.get(i);
      const b = li === undefined ? undefined : d.layout.bounds[li];
      if (!b) return;
      const options = (n.parentIndex ?? []).flatMap((p, c) =>
        p === i && name(c) === 'OPTION' ? [c] : [],
      );
      const shown = options.find((o) => selected.has(o)) ?? options[0];
      if (shown === undefined) return;
      out.push(
        ...drawnInside(textOf(shown), known, x0 + b[0]!, y0 + b[1]!, b[2]!, b[3]!, size(li)),
      );
    });
  });
  return out;
}

/**
 * How wide a character is, in ems, near enough to place a character inside a run: narrow, wide,
 * capital, digit (all digits share one width in nearly every font), or other.
 */
function em(c: string): number {
  if (/\s/.test(c)) return 0.28;
  if (/[il.,:;'|!`]/.test(c)) return 0.28;
  if (/[fjrtI()[\]{}-]/.test(c)) return 0.38;
  if (/[mwMW@%]/.test(c)) return 0.88;
  if (/\d/.test(c)) return 0.56;
  if (/[A-Z]/.test(c)) return 0.68;
  return 0.52;
}

/**
 * The boxes over the hidden characters of a run drawn `w` wide from `x`. Where a character falls is
 * estimated from the widths of the characters before it, scaled to the run's real width, and each
 * box reaches a third of a character further on both sides: a leaked digit is a leak.
 */
function hiddenBoxes(
  text: string,
  known: string[],
  x: number,
  y: number,
  w: number,
  h: number,
): Box[] {
  const widths = [...text].map(em);
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const at = (i: number) => x + (w * widths.slice(0, i).reduce((a, b) => a + b, 0)) / total;
  const pad = w / Math.max(1, text.length) / 3;
  return spans(text, known).map(([a, b]) => {
    const left = at(a) - pad;
    const cuts = Array.from({ length: b - a - 1 }, (_, k) => at(a + k + 1));
    return { x: left - 1, y: y - 1, w: at(b) + pad - left + 2, h: h + 2, cuts };
  });
}

/**
 * The hidden characters of a value a field or a list draws itself: from just inside its left edge,
 * in its font size, kept inside the control. A run longer than the control is cut off by it.
 */
function drawnInside(
  text: string,
  known: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  size: number,
): Box[] {
  const runW = [...text].map(em).reduce((a, b) => a + b, 0) * size;
  // Inside the control's outline: its border stays drawn, so the field still looks like a field.
  const inset = 2;
  return hiddenBoxes(text, known, x + 3, y, runW, h).flatMap((b) => {
    const left = Math.max(b.x, x + inset);
    const right = Math.min(b.x + b.w, x + w - inset);
    const cuts = (b.cuts ?? []).filter((c) => c > left && c < right);
    return right > left ? [{ x: left, y: y + inset, w: right - left, h: h - 2 * inset, cuts }] : [];
  });
}

/** Every box to mask on the page as drawn now, frames from other origins included. */
export async function maskBoxes(page: Page, known: string[] = []): Promise<Box[]> {
  const main = await page.context().newCDPSession(page);
  const out = await boxesFrom(main, known, 0, 0);
  await main.detach();
  // A frame from another origin runs in its own process, and is read through a session of its own.
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const own = await page
      .context()
      .newCDPSession(f)
      .catch(() => null);
    if (!own) continue;
    const at = await (await f.frameElement()).boundingBox();
    if (at) out.push(...(await boxesFrom(own, known, at.x, at.y)));
    await own.detach().catch(() => undefined);
  }
  return out;
}

/**
 * The picture with each hidden character drawn as a dark block, as the text shows it ("████5678"):
 * a hidden value looks hidden, never absent. The seams are drawn over the block, never through it.
 */
export function paint(png: Buffer, boxes: Box[]): Buffer {
  const img = PNG.sync.read(png);
  const fill = (x: number, y: number, v: number) => {
    const i = (y * img.width + x) * 4;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  };
  for (const b of boxes) {
    const x1 = Math.max(0, Math.floor(b.x));
    const y1 = Math.max(0, Math.floor(b.y));
    const x2 = Math.min(img.width, Math.ceil(b.x + b.w));
    const y2 = Math.min(img.height, Math.ceil(b.y + b.h));
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) fill(x, y, BLOCK);
    for (const c of b.cuts ?? []) {
      const x = Math.round(c);
      if (x > x1 && x < x2 - 1) for (let y = y1; y < y2; y++) fill(x, y, SEAM);
    }
  }
  return PNG.sync.write(img);
}
