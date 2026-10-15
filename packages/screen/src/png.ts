// A PNG decoder for screenshots (RGBA, RGB or gray, 8 bits per channel, the five standard filters)
// and two encoders: RGBA, and the light gray one stored frames use. No dependency.
import { deflateSync, inflateSync } from 'node:zlib';

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
  const channels = ({ 6: 4, 2: 3, 0: 1 } as Record<number, number>)[colorType];
  if (bitDepth !== 8 || !channels)
    throw new Error(`unsupported PNG: depth ${bitDepth}, color type ${colorType}`);
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
      out[d + 1] = cur[channels === 1 ? s : s + 1]!;
      out[d + 2] = cur[channels === 1 ? s : s + 2]!;
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

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Buffer): Buffer {
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (const x of td) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** Encodes RGBA pixels as a PNG (no filters; deflate does the work). */
export function encodePng(img: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++)
    Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(
      raw,
      y * (img.width * 4 + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Encodes pixels as an 8-bit gray PNG, each row filtered against the one above: about a tenth of
 * the RGBA size for a page of text, and still readable at one pixel per CSS pixel.
 */
export function encodeGrayPng(img: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((img.width + 1) * img.height);
  let prev = new Uint8Array(img.width);
  for (let y = 0; y < img.height; y++) {
    const row = new Uint8Array(img.width);
    const o = y * (img.width + 1);
    raw[o] = 2;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const d = img.data;
      row[x] = (d[i]! * 77 + d[i + 1]! * 150 + d[i + 2]! * 29) >> 8;
      raw[o + 1 + x] = (row[x]! - prev[x]!) & 0xff;
    }
    prev = row;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
