// Targeting by meaning (plan, §E.4). Drivers never write selectors: they ask for a field by its
// label, a button by its name, a control by the text it sits with. Every answer is exactly one
// control, or an error that says why; never a guess.
import type { Box, Control, Role, ScreenModel, Text } from './model.js';
import { normalize } from './recognize.js';

export class TargetError extends Error {
  constructor(
    public readonly kind: 'none' | 'ambiguous',
    public readonly what: string,
    public readonly candidates: string[] = [],
  ) {
    super(
      kind === 'none'
        ? `no ${what} on this screen`
        : `more than one ${what}: ${candidates.join(', ')}`,
    );
    this.name = 'TargetError';
  }
}

const EDITABLE: Role[] = ['textbox', 'password', 'select', 'checkbox', 'radio'];
const PRESSABLE: Role[] = ['button', 'image-button', 'link', 'clickable'];
const midY = (b: Box) => b.y + b.h / 2;
const right = (b: Box) => b.x + b.w;
const names = (n: string | string[]) => (Array.isArray(n) ? n : [n]).map(normalize);

/** A label as drawn: a single text run, or two runs side by side that read as it (a split label). */
interface LabelHit {
  box: Box;
}

function labelBoxes(m: ScreenModel, label: string[]): LabelHit[] {
  const want = new Set(label);
  const out: LabelHit[] = [];
  const texts: Text[] = [
    ...m.texts,
    ...m.controls
      .filter((c) => c.role === 'image' && c.name)
      .map((c) => ({ text: c.name, box: c.box, frame: c.frame })),
  ];
  for (const t of texts) if (want.has(normalize(t.text))) out.push({ box: t.box });
  // Split labels: "Staff" then "number:" in the next cell, on the same line.
  for (const a of texts) {
    for (const b of texts) {
      if (
        a === b ||
        Math.abs(midY(a.box) - midY(b.box)) > 4 ||
        b.box.x <= a.box.x ||
        b.box.x - right(a.box) > 40
      )
        continue;
      if (want.has(normalize(`${a.text} ${b.text}`))) {
        out.push({
          box: {
            x: a.box.x,
            y: Math.min(a.box.y, b.box.y),
            w: right(b.box) - a.box.x,
            h: Math.max(a.box.h, b.box.h),
          },
        });
      }
    }
  }
  return out;
}

/**
 * The editable control that belongs to a label: on the same row to its right first, then directly
 * below it, within a distance limit.
 */
export function field(
  m: ScreenModel,
  label: string | string[],
  o: { maxDistance?: number; roles?: Role[] } = {},
): Control {
  const max = o.maxDistance ?? 420;
  const roles = o.roles ?? EDITABLE;
  const wanted = names(label);
  const labels = labelBoxes(m, wanted);
  if (!labels.length) throw new TargetError('none', `label "${wanted.join('" or "')}"`);
  const pick = (cands: { c: Control; d: number }[]) => {
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    // Exactly one: a second candidate about as close is ambiguity, not a choice.
    if (cands.length > 1 && cands[1]!.d - cands[0]!.d < 8 && cands[1]!.c.ref !== cands[0]!.c.ref) {
      throw new TargetError(
        'ambiguous',
        `field for "${wanted[0]}"`,
        cands.slice(0, 3).map((x) => x.c.ref),
      );
    }
    return cands[0]!.c;
  };
  const editable = m.controls.filter((c) => roles.includes(c.role));
  const sameRow: { c: Control; d: number }[] = [];
  const below: { c: Control; d: number }[] = [];
  for (const l of labels) {
    for (const c of editable) {
      const dx = c.box.x - right(l.box);
      if (
        dx >= -2 &&
        dx <= max &&
        Math.abs(midY(c.box) - midY(l.box)) <= Math.max(c.box.h, l.box.h) / 2 + 2
      )
        sameRow.push({ c, d: dx });
      const dy = c.box.y - (l.box.y + l.box.h);
      const overlaps = c.box.x < right(l.box) + 20 && right(c.box) > l.box.x - 20;
      if (dy >= -2 && dy <= 60 && overlaps) below.push({ c, d: dy });
    }
  }
  const found = pick(sameRow) ?? pick(below);
  if (!found) throw new TargetError('none', `field for label "${wanted[0]}"`);
  return found;
}

/** The pressable control with this name: from its text, accessible name, alt, or learned image name. */
export function button(
  m: ScreenModel,
  name: string | string[],
  o: { roles?: Role[] } = {},
): Control {
  const wanted = names(name);
  const roles = o.roles ?? PRESSABLE;
  const hits = m.controls.filter(
    (c) => roles.includes(c.role) && wanted.includes(normalize(c.name)),
  );
  if (!hits.length) throw new TargetError('none', `button "${wanted.join('" or "')}"`);
  if (hits.length > 1)
    throw new TargetError(
      'ambiguous',
      `button "${wanted[0]}"`,
      hits.map((c) => c.ref),
    );
  return hits[0]!;
}

/**
 * The control named `name` that belongs with a piece of text: the "Activity" link in the tile that
 * says "Account ending in 7890". It must be below or beside the text, in its column, and clearly
 * the nearest one.
 */
export function withText(
  m: ScreenModel,
  anchor: string | ((t: string) => boolean),
  name: string | string[],
): Control {
  const match =
    typeof anchor === 'string' ? (t: string) => normalize(t).includes(normalize(anchor)) : anchor;
  const anchors = m.texts.filter((t) => match(t.text));
  const label = typeof anchor === 'string' ? anchor : 'the text';
  if (!anchors.length) throw new TargetError('none', `text "${label}"`);
  if (anchors.length > 1)
    throw new TargetError(
      'ambiguous',
      `text "${label}"`,
      anchors.map((a) => a.text),
    );
  const a = anchors[0]!.box;
  const wanted = names(name);
  const cands = m.controls
    .filter((c) => wanted.includes(normalize(c.name)) && c.box.y + c.box.h >= a.y - 2)
    .filter((c) => c.box.x < right(a) + 200 && right(c.box) > a.x - 200)
    .map((c) => ({ c, d: Math.hypot(c.box.x - a.x, c.box.y - a.y) }))
    .sort((x, y) => x.d - y.d);
  if (!cands.length) throw new TargetError('none', `"${wanted[0]}" near "${label}"`);
  if (cands.length > 1 && cands[1]!.d < cands[0]!.d * 1.5)
    throw new TargetError(
      'ambiguous',
      `"${wanted[0]}" near "${label}"`,
      cands.slice(0, 3).map((x) => x.c.ref),
    );
  return cands[0]!.c;
}

/** The control named `name` on the same row as a value: the Statement button on 2026-05-31's row. */
export function inRow(m: ScreenModel, value: string, name: string | string[]): Control {
  const rows = m.texts.filter((t) => normalize(t.text) === normalize(value));
  if (!rows.length) throw new TargetError('none', `row "${value}"`);
  if (rows.length > 1) throw new TargetError('ambiguous', `row "${value}"`);
  const y = midY(rows[0]!.box);
  const wanted = names(name);
  const hits = m.controls.filter(
    (c) => wanted.includes(normalize(c.name)) && Math.abs(midY(c.box) - y) <= c.box.h / 2 + 4,
  );
  if (!hits.length) throw new TargetError('none', `"${wanted[0]}" in row "${value}"`);
  if (hits.length > 1)
    throw new TargetError(
      'ambiguous',
      `"${wanted[0]}" in row "${value}"`,
      hits.map((c) => c.ref),
    );
  return hits[0]!;
}
