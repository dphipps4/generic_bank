// A PNG decoder for screenshots: RGBA, 8 bits per channel, the five standard filters. Enough for
// what Chromium's screenshots are, with no dependency.
import { inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

export function decodePng(buf: Buffer): Image {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2))
    throw new Error(`unsupported PNG: depth ${bitDepth}, colour type ${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const x = line[i]!;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      cur[i] = v & 0xff;
    }
    for (let xx = 0; xx < width; xx++) {
      const s = xx * channels;
      const d = (y * width + xx) * 4;
      out[d] = cur[s]!;
      out[d + 1] = cur[s + 1]!;
      out[d + 2] = cur[s + 2]!;
      out[d + 3] = channels === 4 ? cur[s + 3]! : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether two screenshots are the same outside the given regions (things the page animates). */
export function sameOutside(a: Image, b: Image, ignore: Rect[] = []): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const skip = (x: number, y: number) =>
    ignore.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (
        a.data[i] === b.data[i] &&
        a.data[i + 1] === b.data[i + 1] &&
        a.data[i + 2] === b.data[i + 2]
      )
        continue;
      if (!skip(x, y)) return false;
    }
  }
  return true;
}
