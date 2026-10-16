// The starting knowledge (plan §8): seeds/memory, checked against its manifest, then every entry
// through memory's door as the curator, and one approval for the whole set. A file whose hash or
// count is not the manifest's refuses the whole seed before anything is sent. Seeded lessons are
// curated patterns. Run again, the seed writes nothing.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from './curated.js';
import { sign, SIGNATURE } from './door.js';

const FILES = { ...CATALOG, lessons: 'lesson' } as const;
type File = keyof typeof FILES;

interface Manifest {
  set: string;
  approval: { role: string; reason: string };
  files: Record<File, { path: string; entries: number; sha256: string }>;
}

type Entry = Record<string, unknown> & { id: string };

export class SeedRefused extends Error {}

/** The seed as the manifest approved it, or SeedRefused naming what differs. */
export function readSeed(dir: string) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.approval?.role !== 'curator')
    throw new SeedRefused('the manifest is not approved for the curator role');
  const files = (Object.keys(FILES) as File[]).map((name) => {
    const f = manifest.files[name];
    if (!f) throw new SeedRefused(`the manifest lists no ${name}`);
    const bytes = readFileSync(join(dir, f.path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== f.sha256)
      throw new SeedRefused(`${f.path} is not the file the manifest approved (sha256 ${sha256})`);
    const { entries } = JSON.parse(bytes.toString('utf8')) as { entries: Entry[] };
    if (entries.length !== f.entries)
      throw new SeedRefused(`${f.path} holds ${entries.length} entries, not ${f.entries}`);
    return { name, kind: FILES[name], entries };
  });
  return { manifest, files };
}

/** A seed entry as one curated write. A lesson keeps its id as its key and is a pattern. */
function curatedOf(kind: string, e: Entry, reason: string) {
  if (kind !== 'lesson') return { kind, key: e.id, body: e, reason };
  const { id, lesson, why, area, confidence, signals } = e;
  return {
    kind,
    key: id,
    lesson: { text: lesson, why, area, confidence, signals, scope: 'pattern' },
    reason,
  };
}

export interface Counts {
  /** Each file's entries that memory serves, by file. */
  served: Record<File, number>;
  /** Versions this run wrote, and whether it approved them. */
  written: number;
  approved: number;
}

export async function seed(o: {
  dir: string;
  url: string;
  token: string;
  signingKey: string;
}): Promise<Counts> {
  const { manifest, files } = readSeed(o.dir);
  const auth = { authorization: `Bearer ${o.token}` };
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await fetch(`${o.url}${path}`, {
      method,
      headers: payload
        ? {
            ...auth,
            'content-type': 'application/json',
            [SIGNATURE]: sign(o.signingKey, method, path, payload),
          }
        : auth,
      body: payload,
    });
    const out = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(out)}`);
    return out;
  };

  // A version above the current one waits for approval, whether this run or an earlier one wrote it.
  const reason = `the starting knowledge (${manifest.set})`;
  const pending: { kind: string; key: string; version: number }[] = [];
  let written = 0;
  for (const { kind, entries } of files)
    for (const e of entries) {
      const r = (await call('POST', '/curated', curatedOf(kind, e, reason))) as {
        version: number;
        current: number;
        written: boolean;
      };
      if (r.written) written++;
      if (r.version > r.current) pending.push({ kind, key: e.id, version: r.version });
    }
  const approved = pending.length
    ? (
        (await call('POST', '/curated/approve', {
          set: manifest.set,
          reason: manifest.approval.reason,
          versions: pending,
        })) as { approved: number }
      ).approved
    : 0;

  const served = {} as Record<File, number>;
  for (const { name, entries } of files) {
    const out = await call('GET', `/${name}`);
    const keys = new Set(((out.entries ?? out.lessons) as { key: string }[]).map((x) => x.key));
    served[name] = entries.filter((e) => keys.has(e.id)).length;
  }
  return { served, written, approved };
}
