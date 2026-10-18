// Bank 2's pages, captured for measuring the models' sight (CAPTURE=1): each page's masked picture,
// exactly what the Scout and the Supervisor see, and the truth about it from the browser: every
// control with its kind and box, and every label drawn as a picture of words. A script walks the
// bank here, not an agent; the measurement then asks the models to list each picture and scores
// them against this truth.
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import {
  chooseAt,
  clickAt,
  type Control,
  launch,
  newPage,
  type Page,
  press,
  see,
  typeAt,
} from '../../packages/runtime/src/index.js';
import { liveBank, PASSWORDS } from '../support/banks.js';

const OUT = new URL('../../apps/factory/measure/bank-2/', import.meta.url);
const KIND: Record<string, string> = {
  textbox: 'field',
  password: 'password field',
  button: 'button',
  clickable: 'button',
  link: 'link',
  checkbox: 'checkbox',
  combobox: 'list',
  select: 'list',
};
const mid = (b: { x: number; y: number; w: number; h: number }) => ({
  x: b.x + b.w / 2,
  y: b.y + b.h / 2,
});

describe.runIf(process.env.CAPTURE === '1')("bank 2's pages, for measuring sight", () => {
  it('captures each page and its truth', async () => {
    mkdirSync(OUT, { recursive: true });
    const bank = await liveBank('example');
    const browser = await launch();
    const page = await newPage(browser);
    // The member's name too: masked here, as every seeded name should be.
    const known = [
      OPERATORS.service.id,
      PASSWORDS.service,
      MEMBERS.demo,
      'J. Doe',
      'John Doe',
      'John',
      'Doe',
    ];
    // The words bank 2 draws as pictures, written down beforehand: the truth the models are scored on.
    const words = ['Username:', 'Passcode:', 'Member number:', 'Amount:'];
    const pages: string[] = [];
    const keep = async (name: string) => {
      const f = await see(page, { known, limitMs: 15_000 });
      const pictures: { x: number; y: number; w: number; h: number }[] = [];
      // Every frame: bank 2's pages after sign-in sit in frames.
      for (const fr of page.frames()) {
        const imgs = fr.locator('img[src*="/img/t/"]');
        for (let i = 0; i < (await imgs.count()); i++) {
          const b = await imgs.nth(i).boundingBox();
          if (b && b.width > 0) pictures.push({ x: b.x, y: b.y, w: b.width, h: b.height });
        }
      }
      const truth = {
        page: name,
        controls: f.controls.map((c: Control) => ({
          kind: KIND[c.role] ?? c.role,
          name: c.name,
          box: c.box,
        })),
        labelPictures: pictures,
        pictureWords: words,
      };
      const n = String(pages.length + 1).padStart(2, '0');
      writeFileSync(new URL(`${n}-${name}.png`, OUT), f.picture);
      writeFileSync(new URL(`${n}-${name}.json`, OUT), `${JSON.stringify(truth, null, 2)}\n`);
      pages.push(name);
      return f;
    };
    try {
      await page.goto(bank.url);
      let f = await keep('sign-in');
      const fields = (r: string) => f.controls.filter((c) => c.role === r);
      await typeAt(page, mid(fields('textbox')[0]!.box), OPERATORS.service.id);
      await typeAt(page, mid(fields('password')[0]!.box), PASSWORDS.service);
      await press(page, 'Log In');
      f = await keep('code');
      const code = (await bank.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`))
        .code;
      await typeAt(page, mid(fields('textbox')[0]!.box), code);
      await press(page, 'Verify');
      f = await keep('home');
      await press(page, 'Find Member');
      f = await keep('member search');
      await typeAt(page, mid(fields('textbox')[0]!.box), MEMBERS.demo);
      await press(page, 'Find');
      f = await keep('results');
      await press(page, 'Open');
      f = await keep('summary');
      // The member's own Move Money, below the tabs.
      const move = f.controls
        .filter((c) => c.name === 'Move Money')
        .sort((a, b) => b.box.y - a.box.y)[0]!;
      await clickAt(page, mid(move.box));
      f = await keep('transfer form');
      await walkForm(page, f.controls);
      f = await keep('review');
    } finally {
      await browser.close();
      await bank.close();
    }
    expect(pages.length).toBeGreaterThanOrEqual(8);
  }, 180_000);
});

/** Fills the transfer form by position: the two lists, the amount, the memo, then Next. */
async function walkForm(page: Page, controls: Control[]) {
  const lists = controls.filter((c) => c.role === 'select' || c.role === 'combobox');
  await chooseAt(page, mid(lists[0]!.box), '8176');
  await chooseAt(page, mid(lists[1]!.box), '9433');
  const boxes = controls.filter((c) => c.role === 'textbox');
  await typeAt(page, mid(boxes[0]!.box), '1.00');
  if (boxes[1]) await typeAt(page, mid(boxes[1].box), 'GBX TEST');
  await press(page, 'Next');
}
