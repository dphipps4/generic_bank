// The Memory service as its callers reach it, for the memory suite: over HTTP, each request with a
// role's token, each write signed as that role's deterministic code signs it. Nothing here opens
// memory's database; a test that tampers with it says so.
import { sign, SIGNATURE } from '../../apps/memory/src/door.js';
import type { Role } from '../../apps/memory/src/memory.js';
import { SIGNING_KEY, TOKENS } from '../support/memory.js';

export interface Answer<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export const HASH = 'ab'.repeat(32);

/** A caller holding `role`'s token, or none. */
export function as(url: string, role: Role | null) {
  const auth: Record<string, string> = role ? { authorization: `Bearer ${TOKENS[role]}` } : {};
  return {
    async get<T = Record<string, unknown>>(path: string): Promise<Answer<T>> {
      const r = await fetch(`${url}${path}`, { headers: auth });
      return { status: r.status, body: (await r.json()) as T };
    },
    /** A write, signed with the deterministic code's key unless `key` says otherwise. */
    async post<T = Record<string, unknown>>(
      write: string,
      body: unknown,
      o: { key?: string | null } = {},
    ): Promise<Answer<T>> {
      const path = `/${write}`;
      const payload = JSON.stringify(body);
      const key = o.key === undefined ? SIGNING_KEY : o.key;
      const r = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          ...(key ? { [SIGNATURE]: sign(key, 'POST', path, payload) } : {}),
        },
        body: payload,
      });
      return { status: r.status, body: (await r.json()) as T };
    },
  };
}

export type Caller = ReturnType<typeof as>;

/** How many rows the change log holds, as memory verifies it. */
export const changes = async (c: Caller) =>
  (await c.get<{ ok: boolean; rows: number }>('/history/verify')).body.rows;

/** A run, recorded now by `who`; a task run that names a driver is one of that driver's runs. */
export async function run(
  c: Caller,
  id: string,
  bank: string,
  extra: Record<string, unknown> = {},
): Promise<Answer> {
  return c.post('episodes/runs', {
    id,
    kind: 'task',
    bank,
    vendor: 'corelink',
    outcome: 'succeeded',
    startedAt: new Date().toISOString(),
    ...extra,
  });
}

/** A lesson proposed by a run, as the factory proposes it; returns its id. */
export async function propose(
  c: Caller,
  runId: string,
  text: string,
  o: { scope?: string; seen?: boolean } = {},
): Promise<string> {
  const r = await c.post<{ lesson: string }>('lessons/proposals', {
    runId,
    text,
    area: 'statements',
    scope: o.scope ?? 'tenant',
    confidence: 'medium',
    seen: o.seen ?? true,
    frames: ['f1'],
    evidenceHash: HASH,
  });
  if (r.status >= 300) throw new Error(`proposal refused: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.lesson;
}

/** A lesson as memory serves it now, or at a version. */
export const lesson = async (c: Caller, id: string, version?: number) =>
  (
    await c.get<{
      state: string;
      scope: string;
      bank: string | null;
      vendor: string | null;
      role: string;
      version: number;
      current: number;
      retiredAtBanks: string[];
      reason: string | null;
    }>(`/lessons/${id}${version ? `?version=${version}` : ''}`)
  ).body;

/** What the rules did to a lesson, in order: each change-log row's action and rule. */
export const ruled = async (c: Caller, id: string) =>
  (
    await c.get<{ changes: { role: string; action: string; data: { rule?: string } }[] }>(
      `/history?entity=Lesson&id=${id}`,
    )
  ).body.changes
    .filter((x) => x.role === 'system')
    .map((x) => `${x.action} (${x.data.rule})`);
