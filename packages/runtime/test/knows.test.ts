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
