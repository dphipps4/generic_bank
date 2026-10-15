import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBERS } from '../src/seed.js';
import { renderText } from '../src/markup/pixels.js';
import { accountsOf } from '../src/ledger.js';
import { type Client, signIn, type TestBank, testBank } from './harness.js';

/** Reads our own pixel font back out of a PNG: the proof that the pixels say the words. */
function readBack(png: Buffer, scale = 2): string {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let idat = Buffer.alloc(0);
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    if (png.toString('ascii', o + 4, o + 8) === 'IDAT')
      idat = Buffer.concat([idat, png.subarray(o + 8, o + 8 + len)]);
    o += 12 + len;
  }
  const raw = inflateSync(idat);
  const at = (x: number, y: number) =>
    raw.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 1 + x * 4 + 4);
  const paper = at(0, 0);
  const ink = (x: number, y: number) => !at(x, y).equals(paper);
  const pad = (height - 7 * scale) / 2;
  const n = Math.round((width - pad * 2) / (6 * scale));
  const font = new Map<string, string>();
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :.,-/$') {
    font.set(signature(renderText(ch, 'label')), ch);
  }
  let out = '';
  for (let k = 0; k < n; k++) {
    let sig = '';
    for (let r = 0; r < 7; r++)
      for (let col = 0; col < 5; col++)
        sig += ink(pad + k * 6 * scale + col * scale, pad + r * scale) ? '1' : '0';
    out += font.get(sig) ?? '?';
  }
  return out;

  function signature(one: Buffer) {
    return readCells(one);
  }
  function readCells(one: Buffer): string {
    const w = one.readUInt32BE(16);
    const h = one.readUInt32BE(20);
    let d = Buffer.alloc(0);
    for (let o = 8; o < one.length;) {
      const len = one.readUInt32BE(o);
      if (one.toString('ascii', o + 4, o + 8) === 'IDAT')
        d = Buffer.concat([d, one.subarray(o + 8, o + 8 + len)]);
      o += 12 + len;
    }
    const rr = inflateSync(d);
    const p = (h - 7 * scale) / 2;
    let sig = '';
    for (let r = 0; r < 7; r++) {
      for (let col = 0; col < 5; col++) {
        const x = p + col * scale;
        const y = p + r * scale;
        sig += rr[y * (w * 4 + 1) + 1 + x * 4 + 3] ? '1' : '0';
      }
    }
    return sig;
  }
}

let example: TestBank;
let sample: TestBank;
let ce: Client;
let cs: Client;
beforeAll(async () => {
  [example, sample] = await Promise.all([testBank('example'), testBank('sample')]);
  [ce, cs] = await Promise.all([signIn(example), signIn(sample)]);
});
afterAll(async () => {
  await Promise.all([example.close(), sample.close()]);
});

const images = (html: string) =>
  [...html.matchAll(/<(?:IMG|INPUT TYPE="image") SRC="([^"]*\/img\/t\/[^"]+)"([^>]*)>/gi)].map(
    (m) => ({ url: m[1]!, rest: m[2]! }),
  );
const png = (c: Client, url: string) => c.raw(url);

describe('Example Credit Union draws some labels and its Confirm button as pixels', () => {
  it('has no "Username" or "Passcode" anywhere in its sign-in markup, only images with no alt text', async () => {
    const page = (await example.client().get('signin')).body;
    expect(page).not.toMatch(/Username|Passcode/i);
    const imgs = images(page);
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    for (const i of imgs) {
      expect(i.rest).not.toMatch(/alt=/i);
      expect(i.url).not.toMatch(/user|pass/i);
    }
  });

  it('serves images whose pixels read USERNAME: and PASSCODE:', async () => {
    const page = (await example.client().get('signin')).body;
    const read = [];
    for (const i of images(page)) {
      const r = await png(ce, i.url);
      expect(r.type).toBe('image/png');
      read.push(readBack(r.bytes));
    }
    expect(read).toEqual(expect.arrayContaining(['USERNAME:', 'PASSCODE:']));
  });

  it('submits a transfer with an image button that says CONFIRM, and nowhere else', async () => {
    const [from, to] = await accountsOf(example.db, MEMBERS.demo);
    await ce.post(`members/${MEMBERS.demo}/transfer`, {
      from: String(from!.id),
      to: String(to!.id),
      amount: '1',
      memo: 'PIX',
    });
    const review = (await ce.get(`members/${MEMBERS.demo}/transfer/review`)).body;
    expect(review).not.toMatch(/Confirm/);
    const button = images(review).find((i) =>
      /<INPUT/i.test(review.slice(review.indexOf(i.url) - 40, review.indexOf(i.url))),
    );
    expect(button).toBeDefined();
    expect(readBack((await png(ce, button!.url)).bytes)).toBe('CONFIRM');
  });
});

describe('Sample Savings Bank draws its section headings as pixels', () => {
  it('has no heading text in the heading cell, and the image reads MEMBER SUMMARY', async () => {
    const page = (await cs.get(`members/${MEMBERS.demo}`)).body;
    expect(page).not.toMatch(/<B>Member Summary<\/B>/i);
    const urls = images(page).map((i) => i.url);
    const read = await Promise.all(urls.map(async (u) => readBack((await png(cs, u)).bytes)));
    expect(read).toContain('MEMBER SUMMARY');
  });
});

describe('the pixel images', () => {
  it('answer 404 for an id no page has drawn', async () => {
    expect((await png(ce, '/img/t/nothing.png')).status).toBe(404);
  });
});
