import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, sameOutside } from '../src/png.js';

/** A tiny PNG built by hand: every row uses a different filter, so all five are decoded. */
function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
) {
  const rows: number[] = [];
  const raw: number[][] = [];
  for (let y = 0; y < height; y++) {
    const line: number[] = [];
    for (let x = 0; x < width; x++) line.push(...pixel(x, y));
    raw.push(line);
  }
  for (let y = 0; y < height; y++) {
    const f = y % 5;
    const cur = raw[y]!;
    const up = y > 0 ? raw[y - 1]! : new Array<number>(cur.length).fill(0);
    rows.push(f);
    for (let i = 0; i < cur.length; i++) {
      const a = i >= 4 ? cur[i - 4]! : 0;
      const b = up[i]!;
      const c = i >= 4 ? up[i - 4]! : 0;
      const p = a + b - c;
      const pr =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f]!;
      rows.push((cur[i]! - pred) & 0xff);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const gradient = (x: number, y: number): [number, number, number, number] => [
  (x * 37) & 255,
  (y * 53) & 255,
  (x * y) & 255,
  255,
];

describe('the PNG decoder', () => {
  it('decodes every filter back to the pixels', () => {
    const img = decodePng(png(9, 10, gradient));
    expect([img.width, img.height]).toEqual([9, 10]);
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 9; x++)
        expect([...img.data.subarray((y * 9 + x) * 4, (y * 9 + x) * 4 + 4)]).toEqual(
          gradient(x, y),
        );
  });

  it('compares two pictures, ignoring the regions a page animates', () => {
    const a = decodePng(png(10, 10, gradient));
    const b = decodePng(
      png(10, 10, (x, y) => (x >= 2 && x < 5 && y >= 2 && y < 5 ? [0, 0, 0, 255] : gradient(x, y))),
    );
    expect(sameOutside(a, a)).toBe(true);
    expect(sameOutside(a, b)).toBe(false);
    expect(sameOutside(a, b, [{ x: 2, y: 2, w: 3, h: 3 }])).toBe(true);
  });
});
