// Masking (plan, §I.2). Everything is masked before it is written. Known values (the member's name,
// account numbers, credentials, codes) and patterns (runs of four or more digits, amounts of money,
// emails, phone numbers, street lines) are masked in text. Screenshots are masked from the screen
// model, which already knows where every piece of text is: every input, every text run that holds a
// known value or a pattern, and every picture the crawler cannot read is covered with a white box
// filled with asterisks, the way a redacted form looks. No OCR is involved.
import { type Box, type Control, decodePng, encodePng, type ScreenModel } from '@gb/screen';

export interface MaskPolicy {
  /** Values known before the run: credentials, codes, the member's name and numbers. */
  known: string[];
  /** Pictures the bank's profile marks safe to show (a learned "Confirm" button). */
  safePictures?: string[];
}

/** Patterns masked wherever they appear. A run of digits is masked only when it holds four or more. */
const PATTERNS: { re: RegExp; when?: (m: string) => boolean }[] = [
  { re: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g }, // emails
  { re: /\$\s?-?[\d,]+(\.\d{1,2})?/g }, // amounts of money
  { re: /-?\d[\d,]*\.\d{2}\b/g }, // amounts without a symbol
  {
    re: /\b\d+\s+[A-Z][a-z]+(\s[A-Z][a-z]+)?\s+(Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Boulevard|Blvd|Drive|Dr|Way|Court|Ct)\b\.?/g,
  }, // street lines
  { re: /\+?\(?\d[\d\s().-]*\d/g, when: (m) => m.replace(/\D/g, '').length >= 4 }, // phone numbers and runs of 4+ digits
];

const stars = (s: string) => s.replace(/[^\s]/g, '*');

/** Text with every known value and pattern replaced by asterisks of the same length. */
export function maskText(text: string, policy: MaskPolicy): string {
  let out = text;
  for (const v of policy.known
    .filter((k) => k.trim().length >= 2)
    .sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => stars(m));
  }
  for (const { re, when } of PATTERNS)
    out = out.replace(re, (m) => (!when || when(m) ? stars(m) : m));
  return out;
}

/** Whether a piece of text holds anything that masking would hide. */
export const sensitive = (text: string, policy: MaskPolicy) => maskText(text, policy) !== text;

const INPUTS: Control['role'][] = ['textbox', 'password', 'select', 'checkbox', 'radio'];

/** Every box a screenshot must have covered, from the screen model. */
export function maskBoxes(m: ScreenModel, policy: MaskPolicy): Box[] {
  const boxes: Box[] = [];
  for (const c of m.controls) {
    if (INPUTS.includes(c.role)) boxes.push(c.box);
    else if (sensitive(c.name, policy)) boxes.push(c.box);
    // A picture could show anything: it is covered unless the bank's profile marks it safe.
    else if (
      (c.role === 'image' || c.role === 'image-button') &&
      !(policy.safePictures ?? []).includes(c.name)
    )
      boxes.push(c.box);
  }
  for (const t of m.texts) if (sensitive(t.text, policy)) boxes.push(t.box);
  return boxes;
}

/** The screen model with every text and name masked, and no screenshot. */
export function maskModel(m: ScreenModel, policy: MaskPolicy) {
  return {
    url: maskText(m.url, policy),
    title: maskText(m.title, policy),
    frames: m.frames.map((f) => ({ ...f, url: maskText(f.url, policy) })),
    controls: m.controls.map(({ backendNodeId: _b, session: _s, ...c }) => ({
      ...c,
      name: maskText(c.name, policy),
      ...(c.options
        ? {
            options: c.options.map((o) => maskText(o, policy)),
            selected: c.selected ? maskText(c.selected, policy) : undefined,
          }
        : {}),
    })),
    texts: m.texts.map((t) => ({ ...t, text: maskText(t.text, policy) })),
    structureKey: m.structureKey,
  };
}
export type MaskedModel = ReturnType<typeof maskModel>;

// A five-by-five asterisk, drawn in grey on the white boxes.
const STAR = ['00100', '10101', '01110', '10101', '00100'];

/** The screenshot with every box covered: white, filled with grey asterisks, outlined. */
export function maskScreenshot(png: Buffer, boxes: Box[]): Buffer {
  const img = decodePng(png);
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  };
  for (const b of boxes) {
    const x0 = Math.floor(b.x) - 1;
    const y0 = Math.floor(b.y) - 1;
    const x1 = Math.ceil(b.x + b.w) + 1;
    const y1 = Math.ceil(b.y + b.h) + 1;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, 255);
    for (let x = x0; x < x1; x++) {
      set(x, y0, 190);
      set(x, y1 - 1, 190);
    }
    for (let y = y0; y < y1; y++) {
      set(x0, y, 190);
      set(x1 - 1, y, 190);
    }
    const cy = Math.floor((y0 + y1) / 2) - 2;
    for (let sx = x0 + 3; sx + 5 < x1 - 2; sx += 8) {
      for (let r = 0; r < 5; r++)
        for (let k = 0; k < 5; k++) if (STAR[r]![k] === '1') set(sx + k, cy + r, 120);
    }
  }
  return encodePng(img);
}
