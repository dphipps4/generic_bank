// A run keeps its frames for the goals and for the hazard pass after them: 150, not 60 (run
// build-example-26ef3ef4 ran out in its hazard pass, and the notes it found could cite nothing).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryStore } from '../../../packages/runs/src/index.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import type { Frame } from '../../../packages/runtime/src/index.js';
import { MAX_FRAMES, openTrail } from '../src/trail.js';

let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(async () => {
  await db?.close();
});

const frame = (n: number): Frame => ({
  at: new Date().toISOString(),
  address: `http://site.test/page/${n}`,
  title: 'A page',
  picture: Buffer.from('png'),
  tree: `- text: page ${n}`,
  controls: [],
  dialogs: [],
  animated: [],
});

describe("a run's frames", () => {
  it('are kept up to 150, and the next is said not to be kept', async () => {
    expect(MAX_FRAMES).toBe(150);
    const trail = await openTrail({
      sql: db,
      store: memoryStore(),
      runId: 'build-frames',
      task: 'factory',
      bank: 'sample',
      known: [],
    });
    let last: string | null = null;
    for (let n = 1; n <= 150; n++) last = (await trail.step({ name: 'look' }, frame(n)))!.ref;
    expect(last).toBe('f150');
    expect((await trail.step({ name: 'look' }, frame(151)))!.ref).toBeNull();
  }, 60_000);
});
