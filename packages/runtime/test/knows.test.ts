// A screen is known by sight as well as by its words: a cut-out of words drawn as a picture must be
// found on the page's picture. Made-up pictures, no browser.
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { cropOf } from '../src/match.js';
import { type Frame, knows, UnknownPage } from '../src/see.js';

/** A white picture with a made-up "label" drawn at (x, y): a dark pattern, as words drawn as an image. */
function picture(label: { x: number; y: number } | null): Buffer {
  const png = new PNG({ width: 400, height: 200 });
  png.data.fill(255);
  if (label)
    for (let dy = 0; dy < 18; dy++)
      for (let dx = 0; dx < 90; dx++)
        if ((dx * 7 + dy * 13) % 11 < 4 || dx % 17 === 0) {
          const i = ((label.y + dy) * 400 + label.x + dx) * 4;
          png.data[i] = png.data[i + 1] = png.data[i + 2] = 20;
        }
  return PNG.sync.write(png);
}
const frame = (pic: Buffer, tree = '- button "Log In"'): Frame =>
  ({ tree, picture: pic, controls: [], dialogs: [], animated: [], at: '', address: '' }) as Frame;

describe('a screen known by sight', () => {
  const signIn = picture({ x: 60, y: 50 });
  const label = cropOf(signIn, { x: 60, y: 50, w: 90, h: 18 }).toString('base64');
  const pages = [
    { name: 'sign-in', shows: ['Log In'], looks: [label] },
    { name: 'home', shows: ['Log In', 'Sign Out'] },
  ];

  it('is known when its words show and its pictures are found, wherever the picture now sits', () => {
    expect(knows(frame(signIn), pages)).toBe('sign-in');
    expect(knows(frame(picture({ x: 200, y: 120 })), pages)).toBe('sign-in');
  });

  it('is not known when its picture is missing, even with its words', () => {
    expect(() => knows(frame(picture(null)), pages)).toThrow(UnknownPage);
  });

  it('can be known by its pictures alone', () => {
    expect(knows(frame(signIn, ''), [{ name: 'sign-in', shows: [], looks: [label] }])).toBe(
      'sign-in',
    );
  });
});

describe('a page known by its own title', () => {
  const titled = (
    title: string | undefined,
    roles: string[] = [],
    tree = '- text: anything',
  ): Frame =>
    ({
      tree,
      title,
      picture: picture(null),
      controls: roles.map((role) => ({ role, name: '', box: { x: 0, y: 0, w: 10, h: 10 } })),
      dialogs: [],
      animated: [],
      at: '',
      address: '',
    }) as Frame;

  it('is known by its title alone, whatever words it shows, in any case', () => {
    const pages = [
      { name: 'Account Summary', title: 'Account Summary', shows: [] },
      { name: 'Search', title: 'Search', shows: [] },
    ];
    expect(knows(titled('account summary ', [], '- text: Search'), pages)).toBe('Account Summary');
  });

  it('tells apart two pages that share a title by the fields each was seen to hold', () => {
    const pages = [
      { name: 'Sign On', title: 'Sign On', fields: ['password', 'textbox'], shows: [] },
      { name: 'Sign On · password', title: 'Sign On', fields: ['password'], shows: [] },
    ];
    expect(knows(titled('Sign On', ['textbox', 'password', 'checkbox'].slice(0, 2)), pages)).toBe(
      'Sign On',
    );
    expect(knows(titled('Sign On', ['password']), pages)).toBe('Sign On · password');
  });

  it('is unknown when pages that share a title hold the same fields, or when it has no title', () => {
    const pages = [
      { name: 'A', title: 'Lookup', fields: ['textbox'], shows: [] },
      { name: 'B', title: 'Lookup', fields: ['textbox'], shows: [] },
    ];
    expect(() => knows(titled('Lookup', ['textbox']), pages)).toThrow(UnknownPage);
    expect(() => knows(titled(undefined), [{ name: 'A', title: 'Lookup', shows: [] }])).toThrow(
      UnknownPage,
    );
  });

  it('names the page with its title as the closest when it is unknown', () => {
    const e = (() => {
      try {
        knows(titled('Lookup', ['select']), [
          { name: 'A', title: 'Lookup', fields: ['textbox'], shows: [] },
          { name: 'B', title: 'Lookup', fields: ['password'], shows: [] },
          { name: 'C', title: 'Other', shows: [] },
        ]);
      } catch (x) {
        return x as UnknownPage;
      }
    })();
    expect(e?.closest).toEqual(['A', 'B']);
  });
});
