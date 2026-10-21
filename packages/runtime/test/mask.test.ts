// Masking fails closed: a frame drawn on the page whose document no snapshot holds is painted whole
// unless its own session reads it. No browser: a snapshot as DevTools gives it, written small.
import { describe, expect, it } from 'vitest';
import { type Snapshot, snapshotBoxes } from '../src/mask.js';

const empty = { nodeIndex: [], bounds: [], text: [], styles: [] };
const noText = { layoutIndex: [], bounds: [], start: [], length: [] };

// A page with three frames: one whose document this snapshot holds (same process), one it doesn't
// (another origin's process), and one drawn at no size.
const snap: Snapshot = {
  strings: ['#document', 'HTML', 'IFRAME'],
  documents: [
    {
      nodes: {
        nodeName: [0, 1, 2, 2, 2],
        contentDocumentIndex: { index: [2], value: [1] },
      },
      layout: {
        nodeIndex: [2, 3, 4],
        bounds: [
          [10, 20, 300, 150],
          [10, 200, 300, 150],
          [0, 0, 0, 0],
        ],
        text: [-1, -1, -1],
        styles: [[], [], []],
      },
      textBoxes: noText,
    },
    { nodes: { nodeName: [0] }, layout: empty, textBoxes: noText },
  ],
};

describe('a frame the snapshot cannot read', () => {
  it('is returned to be painted whole, where it is drawn', () => {
    expect(snapshotBoxes(snap, [], 0, 0).unread).toEqual([{ x: 10, y: 200, w: 300, h: 150 }]);
    expect(snapshotBoxes(snap, [], 5, 7).unread).toEqual([{ x: 15, y: 207, w: 300, h: 150 }]);
  });

  it('is never one whose document the snapshot holds, or one drawn at no size', () => {
    const { unread } = snapshotBoxes(snap, [], 0, 0);
    expect(unread.some((b) => b.y === 20)).toBe(false);
    expect(unread).toHaveLength(1);
  });
});
