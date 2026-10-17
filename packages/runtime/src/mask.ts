// Masking, before anything is kept. Playwright can only cover whole elements, and a balance is often
// loose text in a cell, so the runs of drawn text are read from the browser's own layout over
// DevTools (from outside the page) and only the matching characters are painted over. The same
// values are masked in the saved page text and the address.
import type { CDPSession, Page } from 'playwright-core';
import { PNG } from 'pngjs';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DIGITS = /\d{4,}/g;
const MONEY = /\$\s?[\d,]+(\.\d\d)?/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spans of `text` to mask: long numbers, money, and any known value (a name, a password). */
export function spans(text: string, known: string[] = []): [number, number][] {
  const out: [number, number][] = [];
  const res = [
    DIGITS,
    MONEY,
    ...known.filter((k) => k.length >= 2).map((k) => new RegExp(escape(k), 'gi')),
  ];
  for (const re of res)
    for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Text with every span masked by asterisks. */
export function maskText(text: string, known: string[] = []): string {
  let out = text;
  for (const [a, b] of spans(text, known).sort((x, y) => y[0] - x[0]))
    out = out.slice(0, a) + '*'.repeat(Math.max(1, Math.min(8, b - a))) + out.slice(b);
  return out;
}

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
      inputValue?: { index: number[]; value: number[] };
      contentDocumentIndex?: { index: number[]; value: number[] };
    };
    layout: { nodeIndex: number[]; bounds: number[][]; text: number[] };
    textBoxes: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] };
  }[];
};

/** The boxes to paint, in screenshot coordinates, from one DevTools session's documents. */
async function boxesFrom(cdp: CDPSession, known: string[], dx: number, dy: number): Promise<Box[]> {
  const snap = (await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: [],
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
    // A field holding a value to mask (a typed number, a password, a name) is covered whole. A
    // radio button's or a checkbox's value is not typed: it stays, so the picture shows the choice.
    const inputs = d.nodes.inputValue;
    inputs?.index.forEach((node, k) => {
      const b = d.layout.bounds[layoutOf.get(node) ?? -1];
      if (b && spans(str(inputs.value[k]!), known).length)
        out.push({ x: x0 + b[0]!, y: y0 + b[1]!, w: b[2]!, h: b[3]! });
    });
    // Text: only the characters that match, by their share of the run's width.
    d.textBoxes.layoutIndex.forEach((li, k) => {
      const text = str(d.layout.text[li] ?? -1).slice(
        d.textBoxes.start[k],
        d.textBoxes.start[k]! + d.textBoxes.length[k]!,
      );
      const b = d.textBoxes.bounds[k]!;
      const per = text.length ? b[2]! / text.length : 0;
      // Where a character falls is estimated from the run's width, so each span grows by a
      // character on both sides: a leaked digit is a leak.
      for (const [s, e] of spans(text, known))
        out.push({
          x: x0 + b[0]! + (s - 1) * per - 1,
          y: y0 + b[1]! - 1,
          w: (e - s + 2) * per + 2,
          h: b[3]! + 2,
        });
    });
  });
  return out;
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

/** The picture with each box painted white. */
export function paint(png: Buffer, boxes: Box[]): Buffer {
  const img = PNG.sync.read(png);
  for (const b of boxes) {
    const x1 = Math.max(0, Math.floor(b.x));
    const y1 = Math.max(0, Math.floor(b.y));
    const x2 = Math.min(img.width, Math.ceil(b.x + b.w));
    const y2 = Math.min(img.height, Math.ceil(b.y + b.h));
    for (let y = y1; y < y2; y++)
      for (let x = x1; x < x2; x++)
        img.data.fill(255, (y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
  }
  return PNG.sync.write(img);
}
