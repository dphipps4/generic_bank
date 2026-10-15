import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameOf } from '../../packages/evidence/src/index.js';
import { Browser, decodePng, waitFullyRendered } from '../../packages/screen/src/index.js';
import { accountsOf, findMember } from '../../apps/bank/src/ledger.js';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS, signedInCookies } from '../support/banks.js';

// What a stored frame shows: every place the bank drew a known value or a pattern is covered. The
// bank knows where it drew them (the screen model read them there), so no OCR is needed.

let browser: Browser;
let bank: LiveBank;
beforeAll(async () => {
  bank = await liveBank('generic');
  browser = await Browser.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

describe('a masked frame of a real member summary', () => {
  it('covers every number, amount and name, and the stored model holds none of them', async () => {
    const p = await browser.newPage();
    for (const c of await signedInCookies(bank))
      await p.call('Network.setCookie', { name: c.name, value: c.value, url: bank.url });
    await p.goto(`${bank.url}members/${MEMBERS.demo}`);
    const r = await waitFullyRendered(p, {
      until: (m) => m.texts.some((t) => /Account ending in/.test(t.text)),
    });
    const member = (await findMember(bank.db, MEMBERS.demo))!;
    const accounts = await accountsOf(bank.db, MEMBERS.demo);
    const known = [
      MEMBERS.demo,
      member.firstName,
      member.lastName,
      ...accounts.map((a) => a.number),
      PASSWORDS.service,
    ];
    const frame = frameOf(r.model, { known }, { step: 3, screen: 'member.summary' });

    // The stored model: no known value, no amount, no four-digit run.
    const stored = JSON.stringify(frame.model) + frame.path;
    for (const v of [MEMBERS.demo, member.lastName, ...accounts.map((a) => a.number.slice(-4))])
      expect(stored).not.toContain(v);
    expect(stored).not.toMatch(/\$[\d,]+\.\d{2}/);
    expect(frame.path).toBe('/corelink/members/********');

    // The stored picture: each text the bank drew with a sensitive value is now white.
    expect(frame.image).not.toBeNull();
    const img = decodePng(frame.image!);
    const sensitiveTexts = r.model.texts.filter((t) => /\$[\d,]+\.\d{2}|\d{4}|Sample/.test(t.text));
    expect(sensitiveTexts.length).toBeGreaterThanOrEqual(6);
    for (const t of sensitiveTexts) {
      let white = 0;
      let all = 0;
      for (let y = Math.ceil(t.box.y); y < t.box.y + t.box.h; y++) {
        for (let x = Math.ceil(t.box.x); x < t.box.x + t.box.w; x++) {
          const i = (y * img.width + x) * 4;
          all++;
          if (
            img.data[i]! >= 120 &&
            img.data[i] === img.data[i + 1] &&
            img.data[i + 1] === img.data[i + 2]
          )
            white++;
        }
      }
      expect(white / all, `"${t.text}" must be covered`).toBeGreaterThan(0.99);
    }
    await p.close();
  }, 60_000);

  it('withholds a frame whose screen could not be read, with the reason', () => {
    const f = frameOf(
      {
        url: 'http://x/a',
        title: '',
        frames: [{ id: 'f', url: 'http://y/', box: { x: 0, y: 0, w: 1, h: 1 }, readable: false }],
        controls: [],
        texts: [],
        structureKey: '',
        screenshot: Buffer.alloc(0),
        dropped: 0,
        animated: [],
      },
      { known: [] },
      { step: 1 },
    );
    expect(f.image).toBeNull();
    expect(f.withheld).toMatch(/could not be read/);
  });
});
