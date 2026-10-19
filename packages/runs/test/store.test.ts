import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileStore } from '../src/store.js';

const root = mkdtempSync(join(tmpdir(), 'frames-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the file store', () => {
  const store = fileStore(join(root, 'evidence'));

  it('gives back the bytes it was given, under the same key', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    await store.put('runs/run_1/001.png', png, 'image/png');
    expect(await store.get('runs/run_1/001.png')).toEqual(png);
    await store.put('runs/run_1/001.png', Buffer.from('again'), 'image/png');
    expect((await store.get('runs/run_1/001.png'))!.toString()).toBe('again');
    expect(readdirSync(join(root, 'evidence/runs/run_1'))).toEqual(['001.png']);
  });

  it('answers null for a key it never kept', async () => {
    expect(await store.get('runs/run_1/999.png')).toBeNull();
  });

  it('refuses a key that escapes its root', async () => {
    for (const key of ['../outside.png', 'runs/../../outside.png', '/etc/passwd', '', '.']) {
      await expect(store.put(key, Buffer.from('x'), 'image/png')).rejects.toThrow(/outside/);
      await expect(store.get(key)).rejects.toThrow(/outside/);
    }
    expect(readdirSync(root)).toEqual(['evidence']);
  });
});
