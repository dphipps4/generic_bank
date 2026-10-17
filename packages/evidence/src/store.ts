// Where trail frames are kept: files under one folder in the services (a Docker volume that every
// service which reads or writes frames mounts at the same path), memory in tests.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface FrameStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export function memoryStore(): FrameStore & { keys(): string[] } {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, b),
    get: async (k) => m.get(k) ?? null,
    keys: () => [...m.keys()],
  };
}

/**
 * Frames as files under root: the key is the path below it. A key that would land outside root
 * (`..`, an absolute path) is refused. A frame is written to a temporary name and renamed, so a
 * reader never sees half of one. The content type is the key's extension, so it is not kept.
 */
export function fileStore(root: string): FrameStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    const path = resolve(base, key);
    if (!key || !path.startsWith(base + sep))
      throw new Error(`a frame key outside the store: ${key}`);
    return path;
  };
  return {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      const part = `${path}.${randomUUID()}.part`;
      await writeFile(part, body);
      await rename(part, path);
    },
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
  };
}
