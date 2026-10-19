import { deflateSync } from 'node:zlib';
import { hash32 } from '../rng.js';

// Text drawn as images. Some banks show certain labels and buttons only as pixels: the
// markup holds an <IMG> with no alt text, the image's address is an opaque id, and the image is a
// PNG drawn here from a 5x7 pixel font. The words exist nowhere a program could read them as
// text, so only a reader that looks at the screen can find them. Legacy sites did this with
// sliced Photoshop buttons; they also drew them in capitals, as these do.

// One glyph per character: seven rows, five bits each, the leftmost pixel the highest bit.
// prettier-ignore
const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0], ':': [0, 12, 12, 0, 12, 12, 0], '.': [0, 0, 0, 0, 0, 12, 12],
  ',': [0, 0, 0, 0, 12, 4, 8], '-': [0, 0, 0, 31, 0, 0, 0], '/': [0, 1, 2, 4, 8, 16, 0],
  $: [4, 15, 20, 14, 5, 30, 4], '&': [12, 18, 20, 8, 21, 18, 13], "'": [12, 4, 8, 0, 0, 0, 0],
  '?': [14, 17, 1, 2, 4, 0, 4], '!': [4, 4, 4, 4, 4, 0, 4], '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8], '·': [0, 0, 0, 12, 12, 0, 0],
};

export type PixelStyle = 'label' | 'button';

interface Look {
  ink: [number, number, number];
  paper: [number, number, number] | null;
  scale: number;
  pad: number;
}

const LOOKS: Record<PixelStyle, Look> = {
  label: { ink: [32, 32, 32], paper: null, scale: 2, pad: 2 },
  button: { ink: [255, 255, 255], paper: [15, 110, 110], scale: 2, pad: 6 },
};

/** The text as an RGBA PNG. Characters the font lacks are drawn as a space. */
export function renderText(text: string, style: PixelStyle): Buffer {
  const look = LOOKS[style];
  const chars = [...text.toUpperCase()];
  const cell = 6 * look.scale; // five pixels and a gap
  const width = chars.length * cell + look.pad * 2;
  const height = 7 * look.scale + look.pad * 2;
  const px = Buffer.alloc(width * height * 4);
  if (look.paper) {
    for (let i = 0; i < width * height; i++) {
      px[i * 4] = look.paper[0];
      px[i * 4 + 1] = look.paper[1];
      px[i * 4 + 2] = look.paper[2];
      px[i * 4 + 3] = 255;
    }
  }
  chars.forEach((ch, k) => {
    const rows = FONT[ch] ?? FONT[' ']!;
    rows.forEach((bits, r) => {
      for (let col = 0; col < 5; col++) {
        if (!(bits & (16 >> col))) continue;
        for (let dy = 0; dy < look.scale; dy++) {
          for (let dx = 0; dx < look.scale; dx++) {
            const x = look.pad + k * cell + col * look.scale + dx;
            const y = look.pad + r * look.scale + dy;
            const o = (y * width + x) * 4;
            px[o] = look.ink[0];
            px[o + 1] = look.ink[1];
            px[o + 2] = look.ink[2];
            px[o + 3] = 255;
          }
        }
      }
    });
  });
  return png(width, height, px);
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
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Which image shows which words. An id is a keyed hash, so the address says nothing; the words are
// registered when a page that shows them is drawn, and kept for as long as the process runs.
const registry = new Map<string, { text: string; style: PixelStyle }>();
const REGISTRY_MAX = 2000;

export function pixelId(seed: number, text: string, style: PixelStyle): string {
  const id = `${hash32(seed, style, text).toString(36)}${hash32(text, seed, style).toString(36)}`;
  if (!registry.has(id)) {
    if (registry.size >= REGISTRY_MAX) registry.delete(registry.keys().next().value as string);
    registry.set(id, { text, style });
  }
  return id;
}

export function pixelImage(id: string): Buffer | null {
  const e = registry.get(id);
  return e ? renderText(e.text, e.style) : null;
}
