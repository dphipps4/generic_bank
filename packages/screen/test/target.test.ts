import { describe, expect, it } from 'vitest';
import type { Control, ScreenModel, Text } from '../src/model.js';
import { button, field, inRow, TargetError, withText } from '../src/target.js';

let n = 0;
const text = (t: string, x: number, y: number, w = 60): Text => ({
  text: t,
  box: { x, y, w, h: 12 },
  frame: 'top',
});
const ctl = (
  role: Control['role'],
  name: string,
  x: number,
  y: number,
  w = 120,
  h = 20,
): Control => ({
  ref: `c${++n}`,
  role,
  name,
  box: { x, y, w, h },
  enabled: true,
  frame: 'top',
  backendNodeId: n,
  session: 's',
});
const model = (texts: Text[], controls: Control[]): ScreenModel => ({
  url: 'x',
  title: '',
  frames: [],
  texts,
  controls,
  structureKey: '',
  screenshot: Buffer.alloc(0),
  dropped: 0,
  animated: [],
});

describe('targeting by meaning', () => {
  it('finds the field to the right of its label, on the same row', () => {
    const id = ctl('textbox', '', 200, 10);
    const pw = ctl('password', '', 200, 40);
    const m = model([text('Operator ID:', 100, 14), text('Password:', 100, 44)], [id, pw]);
    expect(field(m, 'Operator ID').ref).toBe(id.ref);
    expect(field(m, 'Password').ref).toBe(pw.ref);
  });

  it('falls back to the field directly below its label', () => {
    const amount = ctl('textbox', '', 100, 30);
    expect(field(model([text('Amount', 100, 10)], [amount]), 'Amount').ref).toBe(amount.ref);
  });

  it('reads a label split across two cells', () => {
    const f = ctl('textbox', '', 230, 10);
    expect(
      field(model([text('Staff', 100, 14, 40), text('number:', 150, 14, 60)], [f]), 'Staff number')
        .ref,
    ).toBe(f.ref);
  });

  it('accepts a bank’s synonyms, and a label drawn as a named image', () => {
    const f = ctl('textbox', '', 200, 10);
    const img = ctl('image', 'Username:', 100, 12, 80, 16);
    expect(field(model([], [img, f]), ['Operator ID', 'Username']).ref).toBe(f.ref);
  });

  it('refuses to guess between two fields equally near, or when there is none', () => {
    const m = model(
      [text('Amount', 100, 10)],
      [ctl('textbox', '', 100, 30), ctl('textbox', '', 104, 31)],
    );
    expect(() => field(m, 'Amount')).toThrow(TargetError);
    expect(() => field(model([text('Memo', 0, 0)], []), 'Memo')).toThrow(/no field for label/);
    expect(() => field(model([], []), 'Memo')).toThrow(/no label/);
  });

  it('finds a button by its name, and refuses two', () => {
    const b = ctl('image-button', 'Sign In', 10, 10);
    expect(button(model([], [b, ctl('link', 'Help', 10, 40)]), 'Sign In').ref).toBe(b.ref);
    expect(() =>
      button(model([], [ctl('button', 'Go', 0, 0), ctl('link', 'Go', 0, 50)]), 'Go'),
    ).toThrow(/more than one/);
  });

  it('picks the Activity link in the tile that says Account ending in 7890, not the next tile’s', () => {
    const mine = ctl('link', 'Activity', 10, 80, 60);
    const theirs = ctl('link', 'Activity', 300, 80, 60);
    const m = model(
      [text('Account ending in 7890', 10, 20, 150), text('Account ending in 1234', 300, 20, 150)],
      [mine, theirs],
    );
    expect(withText(m, 'Account ending in 7890', 'Activity').ref).toBe(mine.ref);
  });

  it('picks the Statement button on the row of a given date', () => {
    const may = ctl('button', 'Statement', 400, 100, 80);
    const april = ctl('button', 'Statement', 400, 130, 80);
    const m = model([text('2026-05-31', 10, 104), text('2026-04-30', 10, 134)], [may, april]);
    expect(inRow(m, '2026-04-30', 'Statement').ref).toBe(april.ref);
  });
});
