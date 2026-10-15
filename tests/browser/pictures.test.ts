import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  button,
  choose,
  click,
  distance,
  field,
  type KnownPicture,
  MAX_DISTANCE,
  namePictures,
  type Page,
  picturesToName,
  type,
  waitFullyRendered,
} from '../../packages/screen/src/index.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS, signedInCookies } from '../support/banks.js';

// Example Credit Union draws its labels and its Confirm button as pictures. The factory names each
// picture once (the test plays its vision model, which reads the picture); after that, the crawler
// finds them by fingerprint alone.

let browser: Browser;
let bank: LiveBank;
const learned: KnownPicture[] = [];
beforeAll(async () => {
  bank = await liveBank('example');
  browser = await Browser.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

async function signInPage(): Promise<Page> {
  const p = await browser.newPage();
  await p.goto(`${bank.url}signin`);
  return p;
}
const ready = (m: { controls: { role: string; enabled: boolean }[] }) =>
  m.controls.some((c) => c.role === 'password' && c.enabled);

describe('pictures of text', () => {
  it('the factory names each picture once: here, the two labels on the sign-in page', async () => {
    const p = await signInPage();
    const r = await waitFullyRendered(p, { until: ready });
    const pics = picturesToName(r.model);
    // The labels sit beside the fields, in order: what the vision model would read off them.
    const fields = r.model.controls.filter((c) => c.role === 'textbox' || c.role === 'password');
    const labelFor = (f: (typeof fields)[number]) =>
      pics.filter(
        (x) => Math.abs(x.box.y + x.box.h / 2 - (f.box.y + f.box.h / 2)) < 10 && x.box.x < f.box.x,
      )[0]!;
    learned.push({
      hash: labelFor(fields[0]!).hash,
      name: 'Username:',
      aspect: labelFor(fields[0]!).aspect,
    });
    learned.push({
      hash: labelFor(fields[1]!).hash,
      name: 'Passcode:',
      aspect: labelFor(fields[1]!).aspect,
    });
    expect(distance(learned[0]!.hash, learned[1]!.hash)).toBeGreaterThan(MAX_DISTANCE);
    await p.close();
  }, 60_000);

  it('a fresh page: the crawler finds the fields by their pictures and signs in', async () => {
    const p = await signInPage();
    const r = await waitFullyRendered(p, { until: ready });
    const named = namePictures(r.model, learned);
    expect(
      named.controls
        .filter((c) => c.namedBy === 'fingerprint')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['Passcode:', 'Username:']);
    await type(p, field(named, 'Username'), OPERATORS.service.id);
    await type(p, field(named, 'Passcode'), PASSWORDS.service);
    await click(p, button(named, 'Log In'));
    const after = await waitFullyRendered(p, {
      until: (m) => m.texts.some((t) => /6-digit code/.test(t.text)),
    });
    expect(after.model.texts.some((t) => /Enter the 6-digit code we sent/.test(t.text))).toBe(true);
    await p.close();
  }, 60_000);

  it('a picture it has not learned stays unnamed, and is never a target', async () => {
    const p = await signInPage();
    const r = await waitFullyRendered(p, { until: ready });
    const named = namePictures(r.model, learned.slice(0, 1));
    expect(named.controls.filter((c) => c.namedBy === 'fingerprint').map((c) => c.name)).toEqual([
      'Username:',
    ]);
    expect(() => field(named, 'Passcode')).toThrow();
    await p.close();
  }, 60_000);

  it('the Confirm button, a picture, is learned once and then pressed to post a transfer', async () => {
    const p = await browser.newPage();
    for (const c of await signedInCookies(bank))
      await p.call('Network.setCookie', { name: c.name, value: c.value, url: bank.url });
    const [from, to] = await accountsOf(bank.db, MEMBERS.demo);
    const reviewFor = async (memo: string) => {
      await p.goto(`${bank.url}members/${MEMBERS.demo}/transfer`);
      const r = await waitFullyRendered(p, {
        until: (m) => m.controls.some((c) => c.role === 'select' && (c.options?.length ?? 0) > 2),
      });
      await choose(p, field(r.model, 'From'), (o) => o.startsWith(from!.nickname));
      let m = (await waitFullyRendered(p)).model;
      await choose(p, field(m, 'To'), (o) => o.startsWith(to!.nickname));
      m = (await waitFullyRendered(p)).model;
      // The Amount label is a picture too: the factory names it the first time it sees this form.
      if (!learned.some((k) => k.name === 'Amount:')) {
        const amountField = m.controls.filter((c) => c.role === 'textbox')[0]!;
        const pic = picturesToName(m).find(
          (x) =>
            Math.abs(x.box.y + x.box.h / 2 - (amountField.box.y + amountField.box.h / 2)) < 10 &&
            x.box.x < amountField.box.x,
        )!;
        learned.push({ hash: pic.hash, name: 'Amount:', aspect: pic.aspect });
      }
      m = namePictures(m, learned);
      await type(p, field(m, 'Amount'), '3.21');
      await type(p, field(m, 'Memo'), memo);
      await click(p, button(m, 'Next'));
      return waitFullyRendered(p, {
        until: (x) => x.texts.some((t) => /Review transfer/.test(t.text)),
      });
    };
    let r = await reviewFor('PIX1');
    const pics = picturesToName(r.model).filter(
      (x) => r.model.controls.find((c) => c.ref === x.ref)!.role === 'image-button',
    );
    expect(pics).toHaveLength(1);
    learned.push({ hash: pics[0]!.hash, name: 'Confirm', aspect: pics[0]!.aspect });
    await p.goto(`${bank.url}members/${MEMBERS.demo}/transfer/cancel`);
    r = await reviewFor('PIX2');
    await click(p, button(namePictures(r.model, learned), 'Confirm'));
    const done = await waitFullyRendered(p, {
      until: (m) => m.texts.some((t) => /Confirmation number/.test(t.text)),
    });
    expect(
      done.model.texts.some((t) => /Transfer posted\. Confirmation number ECU-/.test(t.text)),
    ).toBe(true);
    await p.close();
  }, 120_000);
});
